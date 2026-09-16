import { useState, useRef, useEffect } from 'react'
import { Loader } from 'lucide-react'
import { useCategoriesContext, withValue } from '../context/CategoriesContext'
import PickerMenu from './PickerMenu'

// A category <select> that can also create a category.
//
// Categorizing is when you discover you need a new category — so the option to
// add one lives in the dropdown itself rather than in Settings. Picking
// "+ New category…" swaps the select for a text input; Enter creates it and
// selects it in one gesture, Escape backs out.
//
// Two behaviours that matter:
//
//   • The current value is always renderable. Stored categories are free text
//     and may not be in the active list (history, deactivated, imported), and
//     a <select> with an unmatched value renders BLANK — inviting the user to
//     silently recategorize the row. withValue() appends it.
//
//   • Creation failures surface. A 409 on a near-duplicate names the existing
//     category; the field stays open so the name can be corrected rather than
//     the error vanishing behind a closed input.
//
// `kind` picks the vocabulary: 'expense' (debits) or 'income' (credits).
// Styling comes in via className so the caller can match its own surface —
// this is used on both Tailwind and inline-styled pages.
export default function CategorySelect({
  value = '',
  onChange,
  kind = 'expense',
  className = '',
  style,
  disabled = false,
  placeholder = 'Category…',
  allowCreate = true,
  numbered = false, // prefix "1 · " etc. for the deck's 1-9 hotkeys
  // An explicit, already-ordered vocabulary. REQUIRED whenever `numbered` is
  // set: the review decks order their categories by how often each is actually
  // booked, and without a way to pass that list in, this component numbered the
  // context order instead — so the menu said "1 · Recording" while pressing 1
  // selected the most-booked category. The label and the key disagreed.
  //
  // Omitted, behaviour is unchanged: every other picker keeps the context order.
  options: optionsProp,
  autoFocus = false,
}) {
  const { expense, income, create, expenseGroups, expenseOrder, incomeGroups, incomeOrder } =
    useCategoriesContext()
  // ── Sections, and where the numbering comes from ───────────────────────────
  //
  // When the caller passes its own `options` (the review decks do, to control
  // their 1-9 hotkeys) that list wins outright and the menu stays flat: the deck
  // resolves a keypress by index into ITS array, so rendering a different order
  // here is precisely the desync described above.
  //
  // Otherwise the grouped shape from the context renders, and the numbering runs
  // down `order` — which the server produced as `groups.flatMap(items)`. One
  // flatten, one source; the label and the key cannot disagree.
  const ctxGroups = kind === 'income' ? (incomeGroups || []) : (expenseGroups || [])
  const ctxOrder = kind === 'income' ? (incomeOrder || []) : (expenseOrder || [])
  const useGroups = !optionsProp && ctxGroups.length > 0
  const base = optionsProp || (useGroups ? ctxOrder : (kind === 'income' ? income : expense))
  // withValue APPENDS an unlisted stored value, so it can never shift the first
  // nine and desync the numbering — and keeping it in the path preserves the
  // blank-select fix described above.
  const options = withValue(base, value)

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  const submit = async () => {
    const name = draft.replace(/\s+/g, ' ').trim()
    if (!name || busy) return
    setBusy(true)
    setError('')
    try {
      const created = await create(name, kind)
      setCreating(false)
      setDraft('')
      onChange?.(created)
    } catch (err) {
      // Keep the field open with the text intact so a rejected name can be
      // edited rather than retyped.
      setError(err.response?.data?.error || err.message || 'Failed to create')
    } finally { setBusy(false) }
  }

  const cancel = () => { setCreating(false); setDraft(''); setError('') }

  if (creating) {
    return (
      <span className="inline-flex flex-col gap-0.5 min-w-0">
        <span className="inline-flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError('') }}
            onKeyDown={(e) => {
              // Stop the deck's 1-9 / D / F hotkeys from firing while typing.
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              else if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={kind === 'income' ? 'New income type' : 'New category'}
            maxLength={64}
            disabled={busy}
            className={className}
            style={style}
          />
          <button onClick={(e) => { e.stopPropagation(); submit() }} disabled={busy || !draft.trim()}
            title="Create and select (Enter)"
            className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 disabled:opacity-40 whitespace-nowrap">
            {busy ? <Loader size={11} className="animate-spin" /> : 'Add'}
          </button>
          <button onClick={(e) => { e.stopPropagation(); cancel() }} disabled={busy}
            title="Cancel (Esc)"
            className="text-[11px] text-gray-400 hover:text-gray-600 whitespace-nowrap">
            Cancel
          </button>
        </span>
        {error && <span className="text-[10.5px] font-semibold text-rose-600 max-w-[220px]">{error}</span>}
      </span>
    )
  }

  // ONE index map, then both shapes read from it. `options` is already in render
  // order (it IS `order` when grouped), so the position a category holds here is
  // the position it holds on screen — which is what makes the number correct.
  const labelFor = (c, i) => `${numbered && i < 9 ? `${i + 1} · ` : ''}${c}`
  const numberedOptions = options.map((c, i) => ({ value: c, label: labelFor(c, i) }))
  const indexOfValue = new Map(options.map((c, i) => [c, i]))
  const groupedOptions = (useGroups ? ctxGroups : []).map((g) => ({
    key: g.key,
    label: g.label,
    // withValue may have appended an unlisted stored value at the END of
    // `options`; it belongs to no group, so it is picked up by the flat
    // `options` fallback in PickerMenu rather than invented into one here.
    items: (g.items || [])
      .filter((c) => indexOfValue.has(c))
      .map((c) => ({ value: c, label: labelFor(c, indexOfValue.get(c)) })),
  }))

  // Filterable, for the same reason as ArtistSelect: ~30 categories, several of
  // them long and near-identical ("Artist Expense - Recording" vs "- Legal" vs
  // "- Other"), picked over and over down a page of rows.
  //
  // The 1-9 prefixes stay in the LABEL, so the deck's hotkey numbering and what
  // the menu says still match — that pair has been wrong once already.
  return (
    <PickerMenu
      value={value}
      options={numberedOptions}
      groups={useGroups ? groupedOptions : []}
      onSelect={(v) => onChange?.(v)}
      // Carries the typed text into the create field. "+ New category…" used to
      // open an empty box, so a name you had just written into the filter had to
      // be written again — the two-step that makes people give up and pick a
      // wrong-but-present category instead.
      onCreate={allowCreate ? (q) => { setDraft(q); setCreating(true) } : undefined}
      createLabel={(q) => `+ Create ${kind === 'income' ? 'income type' : 'category'} “${q}”`}
      actions={allowCreate
        ? [{ key: 'new', label: `+ New ${kind === 'income' ? 'income type' : 'category'}…`, onSelect: () => { setDraft(''); setCreating(true) } }]
        : []}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className}
      style={style}
    />
  )
}
