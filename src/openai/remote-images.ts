/**
 * Replaces the remote image URLs of a chat request with data URIs, when `remoteImages` is on (#109).
 *
 * @remarks
 * pi takes images only as base64 data, so the chat route runs this before message conversion: each
 * remote `image_url` is downloaded ({@link fetchRemoteImage}) and put back as a data URI, and
 * `convertMessages` stays synchronous. A request may carry at most
 * {@link MAX_REMOTE_IMAGES_PER_REQUEST} remote images; they are fetched together, and the first
 * failure cancels the others.
 *
 * @packageDocumentation
 */

import { proxyLogger } from '@proxy/logging'
import type { ConversionError } from '@proxy/openai/messages'
import {
  type FetchImageResult,
  type FetchRefusalReason,
  fetchRemoteImage,
  MAX_REDIRECTS,
  MAX_REMOTE_IMAGE_BYTES,
  type RemoteImageFetchOptions
} from '@proxy/openai/remote-image-fetch'
import type { OpenAIMessage } from '@proxy/openai/schemas'

/** Logger for remote image fetches. */
const imagesLogger = proxyLogger('openai', 'images')

/** The most remote image URLs one request may carry, so it cannot fan out unbounded fetches. */
export const MAX_REMOTE_IMAGES_PER_REQUEST = 8

/** A user message of a chat request. */
type UserMessage = Extract<OpenAIMessage, { role: 'user' }>

/** An `image_url` content part of a user message. */
type ImagePart = Extract<Exclude<UserMessage['content'], string>[number], { type: 'image_url' }>

/** A remote image URL in the request, and where it is. */
interface RemoteImage {
  readonly part: ImagePart
  /** The request path of its URL, `messages[i].content[j].image_url.url`: its error's `param`. */
  readonly param: string
}

/** The messages, every remote image URL replaced with a data URI. */
interface InlineSuccess {
  readonly ok: true
  readonly messages: OpenAIMessage[]
}

/** Outcome of {@link inlineRemoteImages}, discriminated on `ok`. */
export type InlineResult = InlineSuccess | ConversionError

/**
 * What the client is told for each refusal. Fixed text: never the remote server's answer, which the
 * client must not be able to read through the proxy.
 */
const REFUSAL_MESSAGES: Record<FetchRefusalReason, string> = {
  'invalid-url': 'Remote image URL is not a valid URL',
  'scheme': 'Remote image URL must use http or https',
  'unresolvable': 'Remote image host could not be resolved',
  'blocked-address':
    'Remote image host is blocked: it resolves to a loopback, private, link-local or reserved address',
  'http-status': 'Remote image server did not answer with the image',
  'wrong-type': 'Remote image is not a supported image type',
  'too-large': `Remote image exceeds the maximum of ${String(MAX_REMOTE_IMAGE_BYTES)} bytes`,
  'empty': 'Remote image is empty',
  'too-many-redirects': `Remote image fetch followed more than ${String(MAX_REDIRECTS)} redirects`,
  'timeout': 'Remote image fetch timed out',
  'network': 'Remote image could not be fetched',
  'cancelled': 'Remote image fetch was cancelled'
}

/**
 * Downloads every remote image URL in the messages and replaces it with a data URI.
 *
 * @param messages - the request's `messages`
 * @param options - the address policy, resolver and limits ({@link STRICT_REMOTE_IMAGE_FETCH} in
 *   production)
 * @param signal - the client's disconnect: it cancels every fetch
 * @returns the messages with data URIs (the same array when there was no remote URL), or the
 *   error for the first part refused, with its `param` path
 */
export async function inlineRemoteImages(
  messages: OpenAIMessage[],
  options: RemoteImageFetchOptions,
  signal: AbortSignal
): Promise<InlineResult> {
  const remoteImages = collectRemoteImages(messages)
  if (remoteImages.length === 0) return { ok: true, messages }

  const overCap = remoteImages[MAX_REMOTE_IMAGES_PER_REQUEST]
  if (overCap !== undefined) {
    imagesLogger.warn('Rejected {imageCount} remote images: the most per request is {maxImages}', {
      imageCount: remoteImages.length,
      maxImages: MAX_REMOTE_IMAGES_PER_REQUEST
    })
    return {
      ok: false,
      message: `Too many remote image URLs: at most ${String(MAX_REMOTE_IMAGES_PER_REQUEST)} per request`,
      param: overCap.param
    }
  }

  // One abort for the batch: the first refusal cancels the fetches still running.
  const batch = new AbortController()
  const batchSignal = AbortSignal.any([signal, batch.signal])
  const results = await Promise.all(
    remoteImages.map(async (remoteImage) => {
      const fetched = await fetchRemoteImage(remoteImage.part.image_url.url, options, batchSignal)
      if (!fetched.ok) batch.abort()
      return fetched
    })
  )

  const refusal = firstRefusal(remoteImages, results)
  if (refusal !== undefined) {
    return { ok: false, message: REFUSAL_MESSAGES[refusal.reason], param: refusal.image.param }
  }
  return { ok: true, messages: replaceImageUrls(messages, remoteImages, results) }
}

/**
 * Lists the remote image URLs of the user messages, in request order.
 *
 * @param messages - the request's `messages`
 * @returns each `image_url` part whose URL is not a data URI, with its position
 */
function collectRemoteImages(messages: readonly OpenAIMessage[]): RemoteImage[] {
  return messages.flatMap((message, messageIndex) => {
    if (message.role !== 'user' || typeof message.content === 'string') return []
    return message.content.flatMap((part, partIndex) =>
      part.type === 'image_url' && !part.image_url.url.startsWith('data:')
        ? [
            {
              part,
              param: `messages[${String(messageIndex)}].content[${String(partIndex)}].image_url.url`
            }
          ]
        : []
    )
  })
}

/**
 * Picks the refusal to report: the first in request order that is not a cancellation, since a
 * cancellation is only the echo of another image's refusal or of the client leaving.
 *
 * @param remoteImages - the images, in request order
 * @param results - their fetch results, in the same order
 * @returns the refused image and why, or `undefined` when every image was fetched
 */
function firstRefusal(
  remoteImages: readonly RemoteImage[],
  results: readonly FetchImageResult[]
): { readonly image: RemoteImage; readonly reason: FetchRefusalReason } | undefined {
  const refusals = remoteImages.flatMap((image, position) => {
    const fetched = results[position]
    return fetched === undefined || fetched.ok ? [] : [{ image, reason: fetched.reason }]
  })
  return refusals.find((refusal) => refusal.reason !== 'cancelled') ?? refusals[0]
}

/**
 * Returns the messages with each remote image URL replaced by its fetched data URI.
 *
 * @param messages - the request's `messages`
 * @param remoteImages - the remote images, in request order
 * @param results - their fetch results, all successful, in the same order
 * @returns new messages; the parts and messages without a remote image are the same objects
 */
function replaceImageUrls(
  messages: readonly OpenAIMessage[],
  remoteImages: readonly RemoteImage[],
  results: readonly FetchImageResult[]
): OpenAIMessage[] {
  const dataUris = new Map<ImagePart, string>()
  for (const [position, remoteImage] of remoteImages.entries()) {
    const fetched = results[position]
    if (fetched?.ok === true) {
      dataUris.set(remoteImage.part, `data:${fetched.mimeType};base64,${fetched.data}`)
    }
  }

  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'image_url') return part
        const dataUri = dataUris.get(part)
        return dataUri === undefined
          ? part
          : { ...part, image_url: { ...part.image_url, url: dataUri } }
      })
    }
  })
}
