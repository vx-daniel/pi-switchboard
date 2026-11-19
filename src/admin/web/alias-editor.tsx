/**
 * The Models page's alias editor (#367, phase 2): an alias's name, its targets in order (each an
 * exposed model or a family, with the effort it runs at), and the failures that move a request to
 * the next target. It offers what the console's editor offers: exposed models, families with an
 * exposed member, and only the efforts the target's model runs at. The proxy checks the same.
 *
 * @packageDocumentation
 */

import type { AliasDraft, DraftTarget } from '@proxy/admin/web/alias-draft'
import type { AliasOptions } from '@proxy/admin/web/api'
import { type ReactElement, useState } from 'react'

/** The effort option that keeps the request's own `reasoning_effort`. */
const REQUEST_EFFORT = ''

/**
 * Lists the efforts a target may fix: those of the model it serves (a family's pin, else its
 * newest member), with its current one kept so it shows.
 *
 * @param target - the target
 * @param options - the editor's options
 * @returns the efforts
 */
function effortsOf(target: DraftTarget, options: AliasOptions): readonly string[] {
  const family =
    target.kind === 'family'
      ? options.families.find((option) => option.family === target.family)
      : undefined
  const model = target.kind === 'model' ? target.model : (target.pin ?? family?.newest ?? undefined)
  const efforts = options.models.find((option) => option.id === model)?.efforts ?? []
  return target.effort === null || efforts.includes(target.effort)
    ? efforts
    : [...efforts, target.effort]
}

/**
 * Starts a new target of a kind: the first model, or the first family.
 *
 * @param kind - a model or a family
 * @param options - the editor's options
 * @returns the target
 */
function newTarget(kind: DraftTarget['kind'], options: AliasOptions): DraftTarget {
  return kind === 'model'
    ? { kind, model: options.models[0]?.id ?? '', effort: null }
    : { kind, family: options.families[0]?.family ?? '', pin: null, effort: null }
}

/**
 * Lists a select's choices, the current value kept when it is not among them.
 *
 * @param choices - what may be picked
 * @param current - the value now
 * @returns the choices
 */
function withCurrent(choices: readonly string[], current: string): readonly string[] {
  return current === '' || choices.includes(current) ? choices : [current, ...choices]
}

/** What the family pickers are given. */
interface FamilyPickersView {
  readonly target: Extract<DraftTarget, { kind: 'family' }>
  readonly label: string
  readonly options: AliasOptions
  readonly onChange: (target: DraftTarget) => void
}

/**
 * A family target's family and pin: the newest member, or one pinned.
 *
 * @param pickers - the target and how to change it
 * @returns the two selects
 */
function FamilyPickers(pickers: FamilyPickersView): ReactElement {
  const { target, label, options } = pickers
  const members = options.families.find((option) => option.family === target.family)?.members
  return (
    <>
      <select
        className="select select-sm w-56"
        aria-label={`${label} family`}
        value={target.family}
        onChange={(event) => {
          pickers.onChange({ ...target, family: event.target.value, pin: null, effort: null })
        }}
      >
        {withCurrent(
          options.families.map((option) => option.family),
          target.family
        ).map((familyId) => (
          <option key={familyId}>{familyId}</option>
        ))}
      </select>
      <select
        className="select select-sm w-64"
        aria-label={`${label} pin`}
        value={target.pin ?? ''}
        onChange={(event) => {
          pickers.onChange({
            ...target,
            pin: event.target.value === '' ? null : event.target.value,
            effort: null
          })
        }}
      >
        <option value="">newest</option>
        {withCurrent(members ?? [], target.pin ?? '').map((memberId) => (
          <option key={memberId}>{memberId}</option>
        ))}
      </select>
    </>
  )
}

/** What a row's buttons are given. */
interface RowButtonsView {
  readonly label: string
  readonly position: number
  readonly count: number
  readonly onMove: (step: -1 | 1) => void
  readonly onRemove: () => void
}

/**
 * A target's buttons: up, down, and remove (not for an alias's only target).
 *
 * @param buttons - the target's place and how to move it
 * @returns the buttons
 */
function RowButtons(buttons: RowButtonsView): ReactElement {
  const { label } = buttons
  return (
    <div className="join">
      <button
        type="button"
        className="btn btn-xs join-item"
        aria-label={`Move ${label} up`}
        disabled={buttons.position === 0}
        onClick={() => buttons.onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn btn-xs join-item"
        aria-label={`Move ${label} down`}
        disabled={buttons.position === buttons.count - 1}
        onClick={() => buttons.onMove(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="btn btn-xs join-item"
        aria-label={`Remove ${label}`}
        disabled={buttons.count === 1}
        onClick={buttons.onRemove}
      >
        ✕
      </button>
    </div>
  )
}

/** What one target's row is given. */
interface TargetRowView {
  readonly target: DraftTarget
  readonly position: number
  readonly count: number
  readonly options: AliasOptions
  readonly onChange: (target: DraftTarget) => void
  readonly onMove: (step: -1 | 1) => void
  readonly onRemove: () => void
}

/**
 * One target: what it names, the effort, and moving or removing it.
 *
 * @param row - the target and how to change it
 * @returns the row
 */
function TargetRow(row: TargetRowView): ReactElement {
  const { target, options } = row
  const label = `Target ${String(row.position + 1)}`
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="select select-sm w-28"
        aria-label={`${label} kind`}
        value={target.kind}
        onChange={(event) => {
          row.onChange(newTarget(event.target.value === 'family' ? 'family' : 'model', options))
        }}
      >
        <option value="model">Model</option>
        <option value="family">Family</option>
      </select>
      {target.kind === 'model' ? (
        <select
          className="select select-sm w-72"
          aria-label={`${label} model`}
          value={target.model}
          onChange={(event) => {
            row.onChange({ ...target, model: event.target.value, effort: null })
          }}
        >
          {withCurrent(
            options.models.map((option) => option.id),
            target.model
          ).map((modelId) => (
            <option key={modelId}>{modelId}</option>
          ))}
        </select>
      ) : (
        <FamilyPickers target={target} label={label} options={options} onChange={row.onChange} />
      )}
      <select
        className="select select-sm w-44"
        aria-label={`${label} effort`}
        value={target.effort ?? REQUEST_EFFORT}
        onChange={(event) => {
          row.onChange({
            ...target,
            effort: event.target.value === REQUEST_EFFORT ? null : event.target.value
          })
        }}
      >
        <option value={REQUEST_EFFORT}>the request's effort</option>
        {effortsOf(target, options).map((effort) => (
          <option key={effort}>{effort}</option>
        ))}
      </select>
      <RowButtons
        label={label}
        position={row.position}
        count={row.count}
        onMove={row.onMove}
        onRemove={row.onRemove}
      />
    </div>
  )
}

/** What the editor is given. */
export interface AliasEditorView {
  readonly options: AliasOptions
  /** The alias's name now, `''` for a new one. */
  readonly name: string
  readonly draft: AliasDraft
  /** Whether a save is under way. */
  readonly busy: boolean
  /** Why the last save was refused, if it was. */
  readonly error: string | undefined
  readonly onSave: (name: string, draft: AliasDraft) => void
  readonly onCancel: () => void
}

/**
 * Moves one entry of a list by a step.
 *
 * @typeParam Entry - what the list holds
 * @param list - the list
 * @param from - the entry's place
 * @param step - `-1` up, `1` down
 * @returns the list reordered
 */
function moved<Entry>(list: readonly Entry[], from: number, step: -1 | 1): Entry[] {
  const next = [...list]
  const [taken] = next.splice(from, 1)
  if (taken !== undefined) next.splice(from + step, 0, taken)
  return next
}

/**
 * Edits one alias: its name, its targets and its fallback classes.
 *
 * @param editor - the alias, the options, and how to save
 * @returns the editor
 */
export function AliasEditor(editor: AliasEditorView): ReactElement {
  const { options } = editor
  const [name, setName] = useState(editor.name)
  const [targets, setTargets] = useState<readonly DraftTarget[]>(editor.draft.targets)
  const [fallbackOn, setFallbackOn] = useState<readonly string[]>(editor.draft.fallbackOn)
  return (
    <div className="card card-border bg-base-100">
      <div className="card-body gap-3">
        <label className="flex items-center gap-2">
          <span className="w-24 text-sm">Name</span>
          <input
            className="input input-sm w-64 font-mono"
            aria-label="Alias name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>
        {targets.map((target, position) => (
          <TargetRow
            // A target has no identity of its own but its place in the chain.
            key={`${String(position)}-${target.kind}`}
            target={target}
            position={position}
            count={targets.length}
            options={options}
            onChange={(changed) => {
              setTargets(targets.map((current, place) => (place === position ? changed : current)))
            }}
            onMove={(step) => {
              setTargets(moved(targets, position, step))
            }}
            onRemove={() => {
              setTargets(targets.filter((_current, place) => place !== position))
            }}
          />
        ))}
        <div>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => {
              setTargets([...targets, newTarget('model', options)])
            }}
          >
            + Add a target
          </button>
        </div>
        <fieldset className="fieldset">
          <legend className="fieldset-legend">Move to the next target on</legend>
          <div className="flex flex-wrap gap-3">
            {options.failures.map((failure) => (
              <label key={failure} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={fallbackOn.includes(failure)}
                  onChange={() => {
                    setFallbackOn(
                      fallbackOn.includes(failure)
                        ? fallbackOn.filter((other) => other !== failure)
                        : [...fallbackOn, failure]
                    )
                  }}
                />
                {failure}
              </label>
            ))}
          </div>
        </fieldset>
        {editor.error === undefined ? null : (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            {editor.error}
          </div>
        )}
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={editor.busy}
            onClick={() => {
              editor.onSave(name.trim(), { targets, fallbackOn })
            }}
          >
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={editor.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
