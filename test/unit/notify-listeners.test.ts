/**
 * Tests the shared listener notifier the console's registries use.
 *
 * @packageDocumentation
 */
import { resetSync } from '@logtape/logtape'
import { configureLogging, proxyLogger } from '@proxy/logging'
import { notifyListeners } from '@proxy/utils/listeners'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

/** The JSON Lines the logger wrote during one test. */
let lines: string[] = []

beforeEach(() => {
  lines = []
  configureLogging({ level: 'trace', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

describe('notifyListeners', () => {
  // Catches a throwing listener failing whatever changed the registry, keeping the listeners after
  // it from hearing of the change, or going unlogged, so a console panel silently stops updating.
  test('a listener that throws is logged and the others still hear the change', () => {
    const heard: string[] = []
    const listeners = [
      (value: string): void => {
        heard.push(`first ${value}`)
      },
      (): void => {
        throw new TypeError('panel broke')
      },
      (value: string): void => {
        heard.push(`last ${value}`)
      }
    ]

    expect(() => {
      notifyListeners(listeners, ['change'], proxyLogger('server'), 'test registry')
    }).not.toThrow()

    expect(heard).toEqual(['first change', 'last change'])
    const records = lines.map((line): unknown => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        properties: expect.objectContaining({ source: 'test registry', errorName: 'TypeError' })
      })
    )
  })
})
