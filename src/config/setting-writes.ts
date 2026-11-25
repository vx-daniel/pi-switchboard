/**
 * Changing one setting of `proxy-config.json` from a value (#367): what the admin UI's Settings
 * page writes, checked with the same schemas the file is loaded with, so a value the console's
 * editors would refuse is refused here too.
 *
 * @remarks
 * Pure: it takes the file and returns the file with the change, or why the value can't be used;
 * the caller saves it. Proxy auth is not here: the token is a credential, changed in the console
 * only (constitution III). Listening beyond this machine with proxy auth off needs the caller's
 * confirmation, as the console asks for it.
 *
 * @packageDocumentation
 */

import { isLoopbackHost, type ProxyConfig, ProxyConfigSchema } from '@proxy/config/schema'
import type { SettingKey } from '@proxy/config/settings'
import * as z from 'zod'

/** The settings a value can change: all but proxy auth, which is the console's alone. */
export type WritableSetting = Exclude<SettingKey, 'authToken'>

/** The file's fields, whose schemas the values are checked with. */
const FIELDS = ProxyConfigSchema.shape
/** The routing section's fields. */
const ROUTING = FIELDS.routing.shape

/** Why a value can't be written. */
export interface SettingRefusal {
  /** `invalid` for a value the setting can't take; `confirm` for one that needs confirming first. */
  readonly code: 'invalid' | 'confirm'
  readonly message: string
}

/** The file with the change, or why not. */
export type SettingWrite =
  | { readonly ok: true; readonly file: ProxyConfig }
  | ({ readonly ok: false } & SettingRefusal)

/** What a write is checked against besides the value. */
export interface WriteContext {
  /** Whether the server asks for a token now. */
  readonly authOn: boolean
  /** Whether the operator confirmed listening beyond this machine with proxy auth off. */
  readonly confirmed: boolean
}

/**
 * Writes a checked value into the file.
 *
 * @typeParam T - the value's type
 * @param schema - the setting's schema
 * @param value - the value sent
 * @param put - puts the checked value in the file
 * @returns the change, or why the value can't be used
 */
function checked<T>(
  schema: z.ZodType<T>,
  value: unknown,
  put: (checkedValue: T) => ProxyConfig
): SettingWrite {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, code: 'invalid', message: z.prettifyError(parsed.error) }
  }
  return { ok: true, file: put(parsed.data) }
}

/**
 * Writes the bind address, asking for confirmation beyond this machine with proxy auth off.
 *
 * @param file - the file
 * @param value - the address sent
 * @param context - auth and the confirmation
 * @returns the change, or why not
 */
function writeHost(file: ProxyConfig, value: unknown, context: WriteContext): SettingWrite {
  const host = FIELDS.host.safeParse(value)
  if (!host.success) return { ok: false, code: 'invalid', message: 'An address is needed.' }
  if (!isLoopbackHost(host.data) && !context.authOn && !context.confirmed) {
    return {
      ok: false,
      code: 'confirm',
      message: `Proxy auth is off: any client that can reach ${host.data} could use your logins. Confirm to listen there anyway.`
    }
  }
  return { ok: true, file: { ...file, host: host.data } }
}

/** Each setting's writer. */
const WRITERS: Readonly<
  Record<
    WritableSetting,
    (file: ProxyConfig, value: unknown, context: WriteContext) => SettingWrite
  >
> = {
  host: writeHost,
  port: (file, value) => checked(FIELDS.port, value, (port) => ({ ...file, port })),
  maxBodySizeMb: (file, value) =>
    checked(FIELDS.maxBodySizeMb, value, (maxBodySizeMb) => ({ ...file, maxBodySizeMb })),
  upstreamTimeoutSec: (file, value) =>
    checked(FIELDS.upstreamTimeoutSec, value, (upstreamTimeoutSec) => ({
      ...file,
      upstreamTimeoutSec
    })),
  logLevel: (file, value) => checked(FIELDS.logLevel, value, (logLevel) => ({ ...file, logLevel })),
  hostOriginGuard: (file, value) =>
    checked(FIELDS.hostOriginGuard, value, (hostOriginGuard) => ({ ...file, hostOriginGuard })),
  remoteImages: (file, value) =>
    checked(FIELDS.remoteImages, value, (remoteImages) => ({ ...file, remoteImages })),
  responsesApi: (file, value) =>
    checked(FIELDS.responsesApi, value, (responsesApi) => ({ ...file, responsesApi })),
  docsUi: (file, value) => checked(FIELDS.docsUi, value, (docsUi) => ({ ...file, docsUi })),
  stats: (file, value) => checked(FIELDS.stats, value, (stats) => ({ ...file, stats })),
  consoleLog: (file, value) =>
    checked(FIELDS.consoleLog, value, (consoleLog) => ({ ...file, consoleLog })),
  publicModelIdMode: (file, value) =>
    checked(FIELDS.publicModelIdMode, value, (publicModelIdMode) => ({
      ...file,
      publicModelIdMode
    })),
  modelExposureMode: (file, value) =>
    checked(FIELDS.modelExposureMode, value, (modelExposureMode) => ({
      ...file,
      modelExposureMode
    })),
  customModels: (file, value) =>
    checked(FIELDS.customModels, value, (customModels) => ({ ...file, customModels })),
  providerPrefixes: (file, value) =>
    checked(FIELDS.providerPrefixes, value, (providerPrefixes) => ({ ...file, providerPrefixes })),
  reserve: (file, value) =>
    checked(ROUTING.reserve, value, (reserve) => ({
      ...file,
      routing: { ...file.routing, reserve }
    })),
  loginFallbackOn: (file, value) =>
    checked(ROUTING.logins.shape.fallbackOn, value, (fallbackOn) => ({
      ...file,
      routing: { ...file.routing, logins: { ...file.routing.logins, fallbackOn } }
    }))
}

/**
 * Says whether a setting can be changed from a value: every one but proxy auth.
 *
 * @param key - the setting
 * @returns whether {@link writeSetting} takes it
 */
export function isWritableSetting(key: SettingKey): key is WritableSetting {
  return key !== 'authToken'
}

/**
 * Changes one setting of the file, checked as the file is loaded.
 *
 * @param file - the file as it is now
 * @param key - the setting
 * @param value - the value sent: a number, a switch, a string, a list or a map, as the setting is
 * @param context - auth and the operator's confirmation
 * @returns the file with the change, or why the value can't be used
 */
export function writeSetting(
  file: ProxyConfig,
  key: WritableSetting,
  value: unknown,
  context: WriteContext
): SettingWrite {
  return WRITERS[key](file, value, context)
}
