import { Check } from 'lucide-react'
import { CONFIRMATIONS, ANSWERS } from '../lib/approvalChecklist'
import { useCategoryGroups } from '../context/CategoriesContext'
import ArtistSelect from './ArtistSelect'
import useArtistNames from '../hooks/useArtistNames'

// The checklist's questions. Presentation only — it decides nothing.
//
// Extracted from ApprovalChecklistDeck when Add Invoice needed the same review:
// an admin's add is written `status = 'approved'` on the spot, so it never
// reaches the Approvals queue and was never asked any of this. Two surfaces, one
// set of questions, one implication rule (lib/approvalChecklist.js) — because the
// alternative is two copies that drift, and this one decides whether an invoice
// may be filed.
//
// ── Two kinds of question, deliberately not styled alike ────────────────────
// The four CONFIRMATIONS are ticks: only "yes, that's right" is an answer.
// The four ANSWERS are Yes/No pairs, because "no" is a real answer there and it
// gets WRITTEN. Every one of those columns has a default, so without an explicit
// answer "somebody decided no" and "nobody ever looked" are the same row.
//
// Props:
//   values      what the row WILL hold — {artist, song, amount, category}. Not
//               the stored values: the card must show what is being confirmed.
//   checks      the answers so far
//   onCheck     (key, value) — undefined un-ticks
//   onCobrand   (value) — separate because answering it re-arms the category
//   onFieldChange (field, value) — the parent decides whether that means a PUT
//               (the deck) or a form edit (Add Invoice)
//   context     the row's own is_bulk_deal / recoupable, shown as CONTEXT only
//               and never as a pre-selected answer
export default function ApprovalChecklistFields({
  values = {},
  checks = {},
  onCheck,
  onCobrand,
  onFieldChange,
  categories = [],
  context = {},
  disabled = false,
  fieldKey = '',
}) {
  // Sections come from the context, not the `categories` prop: the prop is a flat
  // list several callers pass, and grouping is a property of the vocabulary
  // rather than of any one caller.
  const { groups: catGroups } = useCategoryGroups('expense')
  // The roster UNION the names already in the ledger — see the hook. Fetched
  // here rather than passed in because BOTH hosts need it and neither has it:
  // the approval deck's page holds vendors, and Add Invoice holds a form.
  const artistNames = useArtistNames()
  const c = checks

  const row = (label, node) => (
    <div className="flex items-start gap-2 py-1.5">
      <div className="w-[104px] shrink-0 text-[11px] font-bold text-gray-400 uppercase tracking-wider pt-1.5">{label}</div>
      <div className="flex-1 min-w-0">{node}</div>
    </div>
  )

  return (
    <div className="space-y-0.5">
      {CONFIRMATIONS.map((item) => {
        const value = values[item.field]
        const ticked = c[item.key] === true
        return (
          <div key={item.key} className="border-b border-divider last:border-b-0 py-1">
            {row(item.label, (
              <div className="flex items-center gap-2">
                {item.field === 'artist' ? (
                  /* A PICKER, not a text box.
                     `expenses.artist` is free text, so this field was a box you
                     retyped a name into — and retyping is how "manila killa"
                     lands beside "Manila Killa" and becomes a second artist.
                     Every other artist control in the app moved to ArtistSelect
                     for that reason; the checklist was the one left behind, on
                     the screen where the name is actually decided.

                     It still TAKES a name it has never heard of: vendors submit
                     off-roster artists (there is an `off_roster_artist` flag for
                     exactly that), so a picker that could only offer the roster
                     would refuse the case this page already warns about. Typing
                     one is the assignment — no roster row is created, or every
                     typo would become a permanent artist needing a merge.

                     Portalled, which matters here: the card sits in a scrolling
                     modal, and an absolutely-positioned menu would be clipped
                     by it. */
                  <ArtistSelect
                    value={value || ''}
                    onChange={(v) => onFieldChange?.('artist', v)}
                    options={artistNames}
                    disabled={disabled}
                    placeholder="(no artist)"
                    title="Pick from the roster and the names already in the ledger, or type a new one"
                    className="flex-1 min-w-0 px-2 py-1 text-[13px] border border-rule rounded-md bg-card disabled:opacity-60"
                  />
                ) : item.field === 'category' ? (
                  <select
                    value={value || ''}
                    // Locked while cobrand is yes: the category is a consequence
                    // at that point, not a choice.
                    disabled={disabled || c.cobrand === true}
                    onChange={(e) => onFieldChange?.('category', e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 text-[13px] border border-rule rounded-md bg-card disabled:opacity-60"
                  >
                    <option value="">(none)</option>
                    {/* Sections. The flat list ran 32 deep, ordered by GLOBAL
                        usage — so on a vendor invoice it led with Bank Fees,
                        Advertisements, Meals & Entertainment, Travel and
                        Software / Subscriptions, which between them have been
                        used on a vendor-submitted invoice exactly zero times.
                        `Recording`, with 23 uses right here, sat ninth.

                        Falls back to the flat list when the grouped shape has
                        not arrived: a picker with no options is worse than an
                        unsorted one. */}
                    {catGroups.length > 0
                      ? catGroups.map((g) => (
                        <optgroup key={g.key} label={g.label}>
                          {g.items.map((k) => <option key={k} value={k}>{k}</option>)}
                        </optgroup>
                      ))
                      : categories.map((k) => <option key={k} value={k}>{k}</option>)}
                    {/* A stored value the vocabulary no longer offers still has
                        to render, or the select goes BLANK and invites a silent
                        recategorization. */}
                    {value && !categories.some((k) => k === value)
                      && <option value={value}>{value}</option>}
                  </select>
                ) : (
                  <input
                    // Keyed on the value so an edit made elsewhere (or a new
                    // card) re-seeds this uncontrolled input.
                    key={`${fieldKey}:${item.field}:${value ?? ''}`}
                    defaultValue={value ?? ''}
                    disabled={disabled}
                    type={item.field === 'amount' ? 'number' : 'text'}
                    step={item.field === 'amount' ? '0.01' : undefined}
                    placeholder={item.field === 'song' ? '(no song)' : '(empty)'}
                    onBlur={(e) => {
                      const v = e.target.value
                      const cur = value ?? ''
                      if (String(v) !== String(cur)) onFieldChange?.(item.field, v)
                    }}
                    className="flex-1 min-w-0 px-2 py-1 text-[13px] border border-rule rounded-md bg-card"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onCheck?.(item.key, ticked ? undefined : true)}
                  title={ticked ? 'Confirmed — click to un-confirm' : 'Confirm this is right'}
                  className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center border-2 transition-colors ${
                    ticked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 text-transparent hover:border-emerald-400'
                  }`}
                >
                  <Check size={15} strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )
      })}

      {ANSWERS.map((q) => (
        <div key={q.key} className="border-b border-divider last:border-b-0 py-1">
          {row(q.label, (
            <div className="flex items-center gap-1.5">
              {[['Yes', true], ['No', false]].map(([text, val]) => {
                const on = c[q.key] === val
                return (
                  <button
                    key={text}
                    type="button"
                    onClick={() => (q.key === 'cobrand' ? onCobrand?.(val) : onCheck?.(q.key, val))}
                    // Campaign is locked once cobrand is yes — it is not a
                    // question at that point, it is a consequence. Two
                    // `disabled` attributes here would have had the second
                    // silently win, which is the sort of thing JSX lets you do
                    // quietly.
                    disabled={disabled || (q.key === 'campaign' && c.cobrand === true)}
                    className={`px-3 py-1 rounded-md text-[12px] font-bold border-2 transition-colors ${
                      on
                        ? (val ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-gray-600 border-gray-600 text-white')
                        : 'border-gray-300 text-gray-500 hover:border-gray-400'
                    }`}
                  >
                    {text}
                  </button>
                )
              })}
              <span className="text-[10px] text-gray-400 ml-1 truncate">{q.hint}</span>
            </div>
          ))}
          {/* What the SUBMITTER said, shown only when they said yes.
              `is_bulk_deal` is BOOLEAN DEFAULT FALSE, so false carries no
              information — it is equally "they said no" and "nobody was ever
              asked". True is the only value that means something, and it is
              context, never a pre-selected answer: the whole reason these are
              buttons is that this checklist records that a PERSON decided.

              That holds on Add Invoice too, where the form's own Cobrand and
              Bulk deal boxes are three inches above this card. Ticking a box on
              a form is not the same act as answering the question that gets
              stored, and pre-filling from it would put the tick back exactly
              where it means nothing. */}
          {q.key === 'bulk_deal' && context.is_bulk_deal === true && (
            <p className="pl-[112px] pb-1 text-[10px] text-blue-600">
              Marked bulk on the form
              {context.bulk_deal_quantity
                ? ` — ${context.bulk_deal_quantity} ${context.bulk_deal_unit || 'items'}`
                : ''}. Your answer is what gets recorded.
            </p>
          )}
          {q.key === 'cobrand' && context.cobrand === true && (
            <p className="pl-[112px] pb-1 text-[10px] text-blue-600">
              Ticked cobrand on the form. Your answer is what gets recorded.
            </p>
          )}
          {/* The mirror image for recoupable, and note which value is the
              informative one is REVERSED here: the column defaults to TRUE, so
              "true" is equally "they said yes" and "nobody was ever asked", and
              FALSE is the only value that took an act. */}
          {q.key === 'recoupable' && context.recoupable === false && (
            <p className="pl-[112px] pb-1 text-[10px] text-amber-600">
              Currently marked NOT recoupable. Someone set that deliberately —
              the column defaults to yes.
            </p>
          )}
        </div>
      ))}

      {c.cobrand === true && values.category === 'Marketing' && (
        <p className="pt-2 text-[11px] text-blue-600">
          Cobrand is marketing spend, so the category will be saved as <b>Marketing</b>. Confirm the category again.
        </p>
      )}
    </div>
  )
}
