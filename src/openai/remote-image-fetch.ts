/**
 * Downloads one remote image for a chat request, when the `remoteImages` setting is on (#109).
 *
 * @remarks
 * pi takes images only as base64 data, so the proxy fetches a remote `image_url` itself: a request
 * the proxy's host makes on a client's behalf. These safeguards hold on every hop:
 * - `http:` and `https:` only;
 * - every address the host resolves to must be public ({@link classifyAddress}): one loopback,
 *   private, link-local, shared, multicast or reserved address refuses the whole host;
 * - the connection goes to an address that was checked, never to a second DNS answer (DNS
 *   rebinding), while the Host header and the TLS name checks stay on the URL's host name;
 * - redirects are followed by hand, at most {@link MAX_REDIRECTS}, each target checked again;
 * - a connect timeout ({@link CONNECT_TIMEOUT_MS}) and a total deadline ({@link TOTAL_TIMEOUT_MS});
 * - a byte cap ({@link MAX_REMOTE_IMAGE_BYTES}) enforced while the body streams, and a budget for
 *   all of a request's images together ({@link MAX_REMOTE_IMAGE_BYTES_PER_REQUEST});
 * - the response's content type must be one the proxy accepts in a data URI;
 * - a plain GET with the proxy's user agent: no client header, cookie or credential is sent.
 *
 * The address policy and the resolver are parameters, so tests can reach a local server; production
 * passes {@link STRICT_REMOTE_IMAGE_FETCH}, and no setting loosens it.
 *
 * @packageDocumentation
 */

import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { once } from 'node:events'
import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { BlockList, isIP, isIPv6, type LookupFunction } from 'node:net'

import { proxyLogger } from '@proxy/logging'
import {
  imageUrlHost,
  MAX_BASE64_PAYLOAD_SIZE,
  SUPPORTED_IMAGE_MIME_TYPES
} from '@proxy/openai/messages'
import { HTTP_BAD_REQUEST, HTTP_MULTIPLE_CHOICES, HTTP_OK } from '@proxy/server/http-status'
import { errorCode } from '@proxy/utils/guards'

/** Logger for remote image fetches. */
const imagesLogger = proxyLogger('openai', 'images')

// --- Address policy ---

/** What kind of address an IP is. Only `public` addresses are fetched from. */
export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'multicast'
  | 'reserved'
  | 'invalid'

/** A class of address the proxy never fetches from. */
type BlockedAddressClass = Exclude<AddressClass, 'public' | 'invalid'>

/**
 * The ranges of each blocked class, as CIDR blocks, checked in this order.
 *
 * @remarks
 * IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`, `::ffff:7f00:1`) are checked against the IPv4
 * ranges: Node's `BlockList` does that itself. The IPv6 transition prefixes that embed an IPv4
 * address another way (IPv4-compatible `::/96`, NAT64, 6to4, Teredo) are refused outright as
 * reserved, rather than decoded.
 */
const BLOCKED_RANGES: readonly (readonly [BlockedAddressClass, readonly string[]])[] = [
  ['unspecified', ['0.0.0.0/32', '::/128']],
  ['loopback', ['127.0.0.0/8', '::1/128']],
  ['private', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']],
  // 169.254.0.0/16 holds the cloud metadata address, 169.254.169.254
  ['link-local', ['169.254.0.0/16', 'fe80::/10']],
  // Carrier-grade NAT
  ['shared', ['100.64.0.0/10']],
  ['multicast', ['224.0.0.0/4', 'ff00::/8']],
  [
    'reserved',
    [
      // "This network", IETF protocol assignments, documentation and benchmarking ranges
      '0.0.0.0/8',
      '192.0.0.0/24',
      '192.0.2.0/24',
      '198.18.0.0/15',
      '198.51.100.0/24',
      '203.0.113.0/24',
      // Reserved for future use, with the limited broadcast address 255.255.255.255
      '240.0.0.0/4',
      // IPv4-compatible, NAT64, discard-only, IETF protocol assignments (Teredo), documentation,
      // 6to4, deprecated site-local, and the newer documentation range
      '::/96',
      '64:ff9b::/96',
      '64:ff9b:1::/48',
      '100::/64',
      '2001::/23',
      '2001:db8::/32',
      '2002::/16',
      'fec0::/10',
      '3fff::/20'
    ]
  ]
]

/**
 * Builds a block list from CIDR blocks.
 *
 * @param ranges - CIDR blocks, `network/prefix`, IPv4 or IPv6
 * @returns the block list
 */
function toBlockList(ranges: readonly string[]): BlockList {
  const blockList = new BlockList()
  for (const range of ranges) {
    const [network = '', prefix = ''] = range.split('/')
    blockList.addSubnet(network, Number(prefix), isIPv6(network) ? 'ipv6' : 'ipv4')
  }
  return blockList
}

/** {@link BLOCKED_RANGES} as block lists, in the same order. */
const BLOCK_LISTS = BLOCKED_RANGES.map(
  ([addressClass, ranges]) => [addressClass, toBlockList(ranges)] as const
)

/**
 * Classifies an IP address for the remote image policy.
 *
 * @param address - an IPv4 or IPv6 address, as a resolver returns it or a URL holds it
 * @returns `public` when the proxy may fetch from it; the blocked class it falls in; or `invalid`
 *   when it is not an IP address
 */
export function classifyAddress(address: string): AddressClass {
  if (isIP(address) === 0) return 'invalid'
  const family = isIPv6(address) ? 'ipv6' : 'ipv4'
  const blocked = BLOCK_LISTS.find(([, blockList]) => blockList.check(address, family))
  return blocked === undefined ? 'public' : blocked[0]
}

// --- Options ---

/** Resolves a host name to every address it has. */
export type HostResolver = (hostname: string) => Promise<readonly LookupAddress[]>

/** The limits of one image fetch, and of all a request's fetches together. */
export interface RemoteImageLimits {
  /** How long a connection may take to open. */
  readonly connectTimeoutMs: number
  /** How long the whole fetch may take, redirects and body included. */
  readonly totalTimeoutMs: number
  /** The most body bytes one image may have. */
  readonly maxBytes: number
  /** The most body bytes all remote images of one request may total. */
  readonly maxRequestBytes: number
  /** The most redirects followed. */
  readonly maxRedirects: number
}

/** How remote images are fetched: the address policy, the resolver, and the limits. */
export interface RemoteImageFetchOptions {
  /** Classifies each address a host resolves to; anything but `public` refuses the host. */
  readonly classifyAddress: (address: string) => AddressClass
  /** Resolves a host name to all its addresses. */
  readonly resolveHost: HostResolver
  /** The limits of one fetch, and of all a request's fetches together. */
  readonly limits: RemoteImageLimits
}

/** How long a connection to an image host may take to open. */
const CONNECT_TIMEOUT_MS = 5000
/** How long one image fetch may take in all: every redirect, and the body. */
const TOTAL_TIMEOUT_MS = 10_000
/** The most redirects one image fetch follows. */
export const MAX_REDIRECTS = 3
/** Base64 writes each group of this many bytes… */
const BASE64_GROUP_BYTES = 3
/** …as this many characters. */
const BASE64_GROUP_CHARS = 4
/**
 * The largest remote image accepted, in bytes: the most whose base64 still fits the data URI limit
 * ({@link MAX_BASE64_PAYLOAD_SIZE} characters), 15 MiB.
 */
export const MAX_REMOTE_IMAGE_BYTES =
  Math.floor(MAX_BASE64_PAYLOAD_SIZE / BASE64_GROUP_CHARS) * BASE64_GROUP_BYTES

/**
 * The most bytes all remote images of one request may total: one full-size image, or several
 * smaller ones. Without it, 8 images of the full size would hold about 120 MiB, and twice that once
 * converted to base64, for one request.
 */
export const MAX_REMOTE_IMAGE_BYTES_PER_REQUEST = MAX_REMOTE_IMAGE_BYTES

/** The bytes a request's remote images may still use; its fetches draw it down as bytes arrive. */
export interface ByteBudget {
  remaining: number
}

/**
 * Resolves a host name with the system resolver, every address in the order it gives them.
 *
 * @param hostname - the host name
 * @returns the addresses
 */
async function systemResolveHost(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, order: 'verbatim' })
}

/** The production fetch options: the strict address policy, the system resolver, the limits above. */
export const STRICT_REMOTE_IMAGE_FETCH: RemoteImageFetchOptions = {
  classifyAddress,
  resolveHost: systemResolveHost,
  limits: {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
    maxRequestBytes: MAX_REMOTE_IMAGE_BYTES_PER_REQUEST,
    maxRedirects: MAX_REDIRECTS
  }
}

// --- Results ---

/** Why a remote image was not fetched. */
export type FetchRefusalReason =
  | 'invalid-url'
  | 'scheme'
  | 'unresolvable'
  | 'blocked-address'
  | 'http-status'
  | 'wrong-type'
  | 'too-large'
  | 'request-too-large'
  | 'empty'
  | 'too-many-redirects'
  | 'timeout'
  | 'network'
  | 'cancelled'

/** A fetched image: its MIME type and its bytes in base64. */
export interface FetchedImage {
  readonly ok: true
  readonly mimeType: string
  readonly data: string
}

/** A refused fetch, and why. */
export interface FetchRefusal {
  readonly ok: false
  readonly reason: FetchRefusalReason
}

/** Outcome of {@link fetchRemoteImage}, discriminated on `ok`. */
export type FetchImageResult = FetchedImage | FetchRefusal

// --- Fetching ---

/** The request headers of every image fetch: nothing from the client. */
const REQUEST_HEADERS = {
  'user-agent': 'pi-switchboard (remote image fetch)',
  'accept': [...SUPPORTED_IMAGE_MIME_TYPES].join(', ')
}

/** One fetch in progress: its options and its signals. */
interface FetchAttempt {
  readonly options: RemoteImageFetchOptions
  /** The caller's signal: the client left, or a sibling fetch failed. */
  readonly callerSignal: AbortSignal
  /** Fires at the total deadline. */
  readonly deadline: AbortSignal
  /** Either of the two. */
  readonly signal: AbortSignal
  /** The request's byte budget, shared with its other fetches. */
  readonly budget: ByteBudget
}

/** A downloaded image body. */
interface ImageOutcome {
  readonly kind: 'image'
  readonly host: string
  readonly status: number
  readonly mimeType: string
  readonly body: Buffer
}

/** A redirect to follow. */
interface RedirectOutcome {
  readonly kind: 'redirect'
  readonly location: string
}

/** A refused hop, with what the log line needs. */
interface RefusedOutcome {
  readonly kind: 'refused'
  readonly host: string
  readonly reason: FetchRefusalReason
  /** The status or address class behind the refusal, for the log. */
  readonly detail?: string
}

/** Outcome of one hop. */
type HopOutcome = ImageOutcome | RedirectOutcome | RefusedOutcome

/** At least one address. */
type Addresses = readonly [LookupAddress, ...LookupAddress[]]

/** The connection to an image host did not open in time. */
class ConnectTimeoutError extends Error {
  /** Creates the error. */
  constructor() {
    super('Connecting to the image host timed out')
    this.name = 'ConnectTimeoutError'
  }
}

/**
 * Fetches a remote image under the given policy and limits.
 *
 * @remarks
 * Never throws: every failure is a refusal with a reason. Logs one line per fetch, with the host
 * only (a path or query can carry a token).
 *
 * @param url - the image URL from the request
 * @param options - the address policy, resolver and limits ({@link STRICT_REMOTE_IMAGE_FETCH} in
 *   production)
 * @param signal - aborts the fetch: the client left, or another image of the request failed
 * @param budget - the bytes the request's images may still use, shared by its fetches; unlimited
 *   when one image is fetched alone
 * @returns the image, or why it was refused
 */
export async function fetchRemoteImage(
  url: string,
  options: RemoteImageFetchOptions,
  signal: AbortSignal,
  budget: ByteBudget = { remaining: Number.POSITIVE_INFINITY }
): Promise<FetchImageResult> {
  const start = performance.now()
  const deadline = AbortSignal.timeout(options.limits.totalTimeoutMs)
  const attempt: FetchAttempt = {
    options,
    callerSignal: signal,
    deadline,
    signal: AbortSignal.any([signal, deadline]),
    budget
  }
  const outcome = await followRedirects(url, attempt)
  const durationMs = Math.round(performance.now() - start)

  if (outcome.kind === 'image') {
    imagesLogger.info(
      'Fetched remote image from {host}: {status}, {bytes} bytes in {durationMs} ms',
      {
        host: outcome.host,
        status: outcome.status,
        bytes: outcome.body.length,
        durationMs,
        mimeType: outcome.mimeType
      }
    )
    return { ok: true, mimeType: outcome.mimeType, data: outcome.body.toString('base64') }
  }

  const properties = {
    host: outcome.host,
    reason: outcome.reason,
    detail: outcome.detail ?? 'none',
    durationMs
  }
  if (outcome.reason === 'cancelled') {
    imagesLogger.debug('Cancelled remote image fetch from {host} after {durationMs} ms', properties)
  } else {
    imagesLogger.warn('Refused remote image from {host}: {reason} ({detail})', properties)
  }
  return { ok: false, reason: outcome.reason }
}

/**
 * Fetches a URL, following redirects by hand, each one a new checked hop.
 *
 * @param url - the first URL
 * @param attempt - the fetch's options and signals
 * @returns the image, or the refusal that ended the chain
 */
async function followRedirects(
  url: string,
  attempt: FetchAttempt
): Promise<ImageOutcome | RefusedOutcome> {
  let target = url
  for (let redirects = 0; redirects <= attempt.options.limits.maxRedirects; redirects++) {
    const outcome = await fetchHop(target, attempt)
    if (outcome.kind !== 'redirect') return outcome
    target = outcome.location
  }
  return { kind: 'refused', host: imageUrlHost(target), reason: 'too-many-redirects' }
}

/**
 * Fetches one URL: checks the scheme and every address, connects to a checked address, and reads
 * the answer.
 *
 * @param target - the URL of this hop
 * @param attempt - the fetch's options and signals
 * @returns the image, a redirect to follow, or a refusal
 */
async function fetchHop(target: string, attempt: FetchAttempt): Promise<HopOutcome> {
  if (!URL.canParse(target)) {
    return { kind: 'refused', host: imageUrlHost(target), reason: 'invalid-url' }
  }
  const url = new URL(target)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'refused', host: url.host, reason: 'scheme', detail: url.protocol }
  }
  try {
    const addresses = await vetAddresses(url, attempt)
    if ('kind' in addresses) return addresses
    const response = await openResponse(url, addresses, attempt)
    return await readResponse(url, response, attempt)
  } catch (error: unknown) {
    return {
      kind: 'refused',
      host: url.host,
      reason: failureReason(error, attempt),
      detail: errorCode(error)
    }
  }
}

/**
 * Resolves a URL's host and checks every address it has.
 *
 * @param url - the URL; a literal IP host is checked without resolving
 * @param attempt - the fetch's options and signals
 * @returns the addresses, all allowed; or the refusal for a host that does not resolve or has a
 *   blocked address
 */
async function vetAddresses(url: URL, attempt: FetchAttempt): Promise<Addresses | RefusedOutcome> {
  // A URL holds an IPv6 literal in brackets
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1')
  const family = isIP(hostname)
  const resolution: Resolution =
    family === 0
      ? await resolveUntilAborted(hostname, attempt)
      : { addresses: [{ address: hostname, family }] }
  const resolved = resolution.addresses

  const [first, ...rest] = resolved
  if (first === undefined) {
    return {
      kind: 'refused',
      host: url.host,
      reason: 'unresolvable',
      detail: resolution.failure ?? 'no addresses'
    }
  }

  const blocked = resolved
    .map(({ address }) => attempt.options.classifyAddress(address))
    .find((addressClass) => addressClass !== 'public')
  if (blocked !== undefined) {
    return { kind: 'refused', host: url.host, reason: 'blocked-address', detail: blocked }
  }
  return [first, ...rest]
}

/** A host's addresses, or none with the resolver's error code when it failed. */
interface Resolution {
  readonly addresses: readonly LookupAddress[]
  /** The resolver's error code (`ENOTFOUND`, `EAI_AGAIN`, …); absent when it answered. */
  readonly failure?: string
}

/**
 * Resolves a host name, giving up when the fetch is aborted (a resolver cannot be cancelled).
 *
 * @param hostname - the host name
 * @param attempt - the fetch's options and signals
 * @returns the addresses; none, with the resolver's error code, when resolution fails, so the log
 *   tells a host that does not exist (`ENOTFOUND`) from a passing DNS failure (`EAI_AGAIN`)
 * @throws Error (or the signal's reason) when the fetch is aborted before the host resolves
 */
async function resolveUntilAborted(hostname: string, attempt: FetchAttempt): Promise<Resolution> {
  const { signal } = attempt
  signal.throwIfAborted()
  // Stops listening for the abort once the race is decided.
  const settled = new AbortController()
  try {
    return await Promise.race([
      attempt.options.resolveHost(hostname).then(
        (addresses): Resolution => ({ addresses }),
        (error: unknown): Resolution => ({ addresses: [], failure: errorCode(error) })
      ),
      once(signal, 'abort', { signal: settled.signal }).then(() => {
        throw new Error('Image fetch aborted while resolving its host')
      })
    ])
  } finally {
    settled.abort()
  }
}

/**
 * A `lookup` for `http.request` that answers with addresses already checked, so the socket cannot
 * connect anywhere a fresh DNS answer points.
 *
 * @param addresses - the checked addresses
 * @returns the lookup function; it serves both single (`all: false`) and `all: true` calls
 */
function pinnedLookup(addresses: Addresses): LookupFunction {
  const [first] = addresses
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [...addresses])
    else callback(null, first.address, first.family)
  }
}

/**
 * Sends the GET and waits for the response head.
 *
 * @param url - the URL of this hop
 * @param addresses - its checked addresses, the only ones the socket may connect to
 * @param attempt - the fetch's options and signals
 * @returns the response, its body not yet read
 * @throws Error when the connection fails, times out or is aborted
 */
function openResponse(
  url: URL,
  addresses: Addresses,
  attempt: FetchAttempt
): Promise<IncomingMessage> {
  const requestOptions: RequestOptions = {
    // A fresh connection each time: no pooled socket from an earlier lookup
    agent: false,
    headers: REQUEST_HEADERS,
    lookup: pinnedLookup(addresses),
    signal: attempt.signal
  }
  return new Promise((resolve, reject) => {
    const outgoing =
      url.protocol === 'https:'
        ? httpsRequest(url, requestOptions, resolve)
        : httpRequest(url, requestOptions, resolve)
    outgoing.on('socket', (socket) => {
      const timer = setTimeout(() => {
        outgoing.destroy(new ConnectTimeoutError())
      }, attempt.options.limits.connectTimeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
      })
      socket.once('close', () => {
        clearTimeout(timer)
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/**
 * Reads one response: a redirect to follow, or an image within the type and size limits.
 *
 * @param url - the URL of this hop, which a relative redirect resolves against
 * @param response - the response, body unread
 * @param attempt - the fetch's limits and the request's byte budget
 * @returns the image, the redirect, or a refusal
 * @throws Error when the body fails or is aborted while streaming
 */
async function readResponse(
  url: URL,
  response: IncomingMessage,
  attempt: FetchAttempt
): Promise<HopOutcome> {
  const { maxBytes } = attempt.options.limits
  const { budget } = attempt
  const status = response.statusCode ?? 0
  const host = url.host
  if (status < HTTP_OK || status >= HTTP_MULTIPLE_CHOICES) {
    response.destroy()
    return redirectOrRefusal(url, status, response.headers.location)
  }

  const mimeType = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (mimeType === undefined || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    response.destroy()
    return { kind: 'refused', host, reason: 'wrong-type' }
  }
  // A declared length is compared with what the budget has left; only streamed bytes draw it down.
  const declaredBytes = Number(response.headers['content-length'])
  const declared = bodyLimitPassed(declaredBytes, maxBytes, budget.remaining - declaredBytes)
  if (declared !== undefined) {
    response.destroy()
    return { kind: 'refused', host, reason: declared, detail: 'content-length' }
  }

  const body = await readBody(response, maxBytes, budget)
  if (!Buffer.isBuffer(body)) return { kind: 'refused', host, reason: body, detail: 'streamed' }
  if (body.length === 0) return { kind: 'refused', host, reason: 'empty' }
  return { kind: 'image', host, status, mimeType, body }
}

/** A body limit: the image's own cap, or the request's budget for all its images. */
type BodyLimit = 'too-large' | 'request-too-large'

/**
 * Tells which body limit a byte count passes, if any.
 *
 * @param bytes - the image's bytes so far, or its declared length (`NaN` when not declared)
 * @param maxBytes - the most bytes one image may have
 * @param budgetLeft - what the request's budget has left after these bytes
 * @returns the limit passed (the image cap first), or `undefined` within both
 */
function bodyLimitPassed(
  bytes: number,
  maxBytes: number,
  budgetLeft: number
): BodyLimit | undefined {
  if (bytes > maxBytes) return 'too-large'
  if (budgetLeft < 0) return 'request-too-large'
  return undefined
}

/**
 * Turns a non-2xx answer into a redirect to follow, or a refusal.
 *
 * @param url - the URL of this hop
 * @param status - the response status
 * @param location - the `Location` header, when there is one
 * @returns a redirect for a 3xx with a valid `Location`, else an `http-status` refusal
 */
function redirectOrRefusal(url: URL, status: number, location: string | undefined): HopOutcome {
  const isRedirect = status >= HTTP_MULTIPLE_CHOICES && status < HTTP_BAD_REQUEST
  if (isRedirect && location !== undefined && URL.canParse(location, url)) {
    return { kind: 'redirect', location: new URL(location, url).href }
  }
  return { kind: 'refused', host: url.host, reason: 'http-status', detail: String(status) }
}

/**
 * Reads a body, stopping as soon as it passes the image cap or the request's budget: nothing past
 * either is buffered.
 *
 * @param response - the response
 * @param maxBytes - the most bytes one image may have
 * @param budget - the request's remaining bytes, drawn down as chunks arrive
 * @returns the body; or which limit it passed (the response is destroyed)
 * @throws Error when the body fails or is aborted before it ends
 */
function readBody(
  response: IncomingMessage,
  maxBytes: number,
  budget: ByteBudget
): Promise<Buffer | BodyLimit> {
  // The executor form: Promise.withResolvers is ES2024, and the project's lib is ES2023.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      budget.remaining -= chunk.length
      const passed = bodyLimitPassed(received, maxBytes, budget.remaining)
      if (passed !== undefined) {
        response.destroy()
        resolve(passed)
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      resolve(Buffer.concat(chunks, received))
    })
    response.on('error', reject)
    // After `end` or a cap stop this does nothing: the promise is settled.
    response.on('close', () => {
      reject(new Error('Image response closed before it ended'))
    })
  })
}

/**
 * Names why a hop threw.
 *
 * @param error - what was thrown
 * @param attempt - the fetch's signals, which tell a deadline from a caller abort
 * @returns `cancelled` when the caller aborted, `timeout` at the deadline or a connect timeout,
 *   else `network`
 */
function failureReason(error: unknown, attempt: FetchAttempt): FetchRefusalReason {
  if (attempt.callerSignal.aborted) return 'cancelled'
  if (attempt.deadline.aborted || error instanceof ConnectTimeoutError) return 'timeout'
  return 'network'
}
