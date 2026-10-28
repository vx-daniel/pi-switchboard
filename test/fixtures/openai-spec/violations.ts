/**
 * Validates a value against one of the schemas in OpenAI's pinned spec subset, for the spec checks
 * of the proxy's answers.
 *
 * @packageDocumentation
 */

import { Ajv2020 } from 'ajv/dist/2020'

import { subset } from './schema'

/** The `$id` the pinned subset is registered under. */
const SPEC_ID = 'openai'

// `strict: false`: the spec carries OpenAPI keywords that are not JSON Schema (`discriminator`).
// Formats are not checked: no format plugin is installed, and none of the checked shapes depends
// on one.
/** The validator holding the pinned subset. */
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, logger: false })
ajv.addSchema({ $id: SPEC_ID, components: subset.components })

/**
 * Validates a value against one of OpenAI's schemas.
 *
 * @param schemaName - the schema's name under `components.schemas`
 * @param value - the value to validate
 * @returns one line per violation, `<path> <message>`; empty when the value is valid
 * @throws Error when the pinned subset has no schema of that name
 */
export function violations(schemaName: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${SPEC_ID}#/components/schemas/${schemaName}`)
  if (validate === undefined) throw new Error(`No schema '${schemaName}' in the pinned subset`)
  if (validate(value) === true) return []
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`
  )
}
