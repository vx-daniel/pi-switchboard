/**
 * The Settings page's controls (#367, phase 2): one per kind of input a setting takes, each
 * holding its edit until saved. A switch or a choice saves at once; text, numbers, lists and maps
 * save with their button.
 *
 * @packageDocumentation
 */

import type { Setting, SettingInput } from '@proxy/admin/web/api'
import { type ReactElement, useState } from 'react'
import * as z from 'zod'

/** What every control is given. */
export interface ControlProps<Input extends SettingInput['kind']> {
  readonly setting: Setting & { readonly input: Extract<SettingInput, { kind: Input }> }
  /** Saves a new value. */
  readonly save: (value: unknown) => void
  /** Whether a save is under way. */
  readonly busy: boolean
}

/** A list of names. */
const NamesSchema = z.array(z.string().trim())
/** A map of names to text or shares: the provider prefixes or the quota reserve. */
const NameMapSchema = z.record(z.string().trim(), z.union([z.string().trim(), z.number()]))

/**
 * The Save button the edits with one share.
 *
 * @param button - whether it is busy or has nothing to save
 * @param button.busy - whether a save is under way
 * @param button.onSave - saves the edit
 * @returns the button
 */
function SaveButton(button: { readonly busy: boolean; readonly onSave: () => void }): ReactElement {
  return (
    <button type="button" className="btn btn-sm" disabled={button.busy} onClick={button.onSave}>
      Save
    </button>
  )
}

/**
 * A text setting: the bind address.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function TextControl(control: ControlProps<'text'>): ReactElement {
  const saved = control.setting.value
  const [text, setText] = useState(typeof saved === 'string' ? saved : '')
  return (
    <div className="flex gap-2">
      <input
        className="input input-sm"
        aria-label={control.setting.label}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <SaveButton busy={control.busy} onSave={() => control.save(text)} />
    </div>
  )
}

/**
 * A whole number within the setting's bounds.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function IntControl(control: ControlProps<'int'>): ReactElement {
  const saved = control.setting.value
  const [text, setText] = useState(typeof saved === 'number' ? String(saved) : '')
  const { min, max } = control.setting.input
  return (
    <div className="flex gap-2">
      <input
        type="number"
        className="input input-sm w-32"
        aria-label={control.setting.label}
        min={min}
        max={max}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <SaveButton busy={control.busy} onSave={() => control.save(Number(text))} />
    </div>
  )
}

/**
 * A switch, saved as it is flipped.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function SwitchControl(control: ControlProps<'switch'>): ReactElement {
  const on = control.setting.value === true
  return (
    <input
      type="checkbox"
      className="toggle toggle-sm"
      aria-label={control.setting.label}
      checked={on}
      disabled={control.busy}
      onChange={() => {
        control.save(!on)
      }}
    />
  )
}

/**
 * One of a list, saved as it is picked.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function ChoiceControl(control: ControlProps<'choice'>): ReactElement {
  return (
    <select
      className="select select-sm w-56"
      aria-label={control.setting.label}
      value={String(control.setting.value)}
      disabled={control.busy}
      onChange={(event) => {
        control.save(event.target.value)
      }}
    >
      {control.setting.input.options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  )
}

/**
 * Any number of a list: the custom models, the login fallback's failures.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function ManyControl(control: ControlProps<'many'>): ReactElement {
  const saved = NamesSchema.safeParse(control.setting.value)
  const [ticked, setTicked] = useState(new Set(saved.success ? saved.data : []))
  const options = [...new Set([...control.setting.input.options, ...ticked])]
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-sm">{ticked.size} picked</summary>
      <div className="mt-2 grid max-h-72 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={ticked.has(option)}
              onChange={() => {
                const next = new Set(ticked)
                if (next.has(option)) next.delete(option)
                else next.add(option)
                setTicked(next)
              }}
            />
            <span className="font-mono text-xs">{option}</span>
          </label>
        ))}
      </div>
      <div className="mt-2">
        <SaveButton busy={control.busy} onSave={() => control.save([...ticked])} />
      </div>
    </details>
  )
}

/**
 * A map from each of a list to a value: the provider prefixes (text) or the quota reserve (a share
 * from 0 to 1). An empty field removes the entry.
 *
 * @param control - the setting, how to save it, and which kind of map
 * @param control.numbers - whether the values are shares, not text
 * @returns the control
 */
function MapControl(
  control: ControlProps<'prefixes' | 'shares'> & { readonly numbers: boolean }
): ReactElement {
  const parsed = NameMapSchema.safeParse(control.setting.value)
  const saved: Readonly<Record<string, string | number>> = parsed.success ? parsed.data : {}
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(saved).map(([name, value]) => [name, String(value)]))
  )
  const names = [...new Set([...control.setting.input.options, ...Object.keys(fields)])]
  const value = Object.fromEntries(
    Object.entries(fields)
      .filter(([, entered]) => entered.trim() !== '')
      .map(([name, entered]) => [name, control.numbers ? Number(entered) : entered])
  )
  return (
    <div className="flex flex-col gap-1">
      {names.map((owner) => (
        <label key={owner} className="flex items-center gap-2 text-sm">
          <span className="w-48 truncate font-mono text-xs">{owner}</span>
          <input
            className="input input-xs w-32"
            aria-label={`${control.setting.label}: ${owner}`}
            {...(control.numbers ? { type: 'number', min: 0, max: 1, step: 0.05 } : {})}
            value={fields[owner] ?? ''}
            onChange={(event) => {
              setFields({ ...fields, [owner]: event.target.value })
            }}
          />
        </label>
      ))}
      <div>
        <SaveButton busy={control.busy} onSave={() => control.save(value)} />
      </div>
    </div>
  )
}

/**
 * The provider prefixes: a prefix per provider, none where empty.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function PrefixesControl(control: ControlProps<'prefixes'>): ReactElement {
  return <MapControl {...control} numbers={false} />
}

/**
 * The quota reserve: a share per login, none where empty.
 *
 * @param control - the setting and how to save it
 * @returns the control
 */
export function SharesControl(control: ControlProps<'shares'>): ReactElement {
  return <MapControl {...control} numbers />
}
