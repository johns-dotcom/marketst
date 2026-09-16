import { useState, useCallback } from 'react'
import { CheckCircle2 } from 'lucide-react'

// Shared chrome for the card-at-a-time review flows.
//
// This is deliberately PRESENTATION ONLY. Two decks use it and their
// bodies have almost nothing in common:
//
//   • BkStatements — swipe-to-decide over bank transactions, with match
//     suggestions, splits, currency correction, dismiss/reopen.
//   • Reports — recategorize the items behind one P&L cell.
//
// What they genuinely share (and what lives here) is the overlay, the
// "{i} of {n}" + progress header, the all-done panel, and the round
// action-button styling. Everything else — the card, the keyboard
// handler, and every server call — stays with the page that owns it.
// Resist the urge to pull action logic in here; the two decks' notions
// of "accept" are not the same operation.
//
// Props:
//   index, total      — 0-based position and item count (drives the header)
//   sub               — optional money reading beside the count ("$71,140 of
//                       $188,349"), computed by the owning page over its own
//                       snapshot
//   label             — optional center text in the header (e.g. the cell name)
//   onClose           — required; also fires on backdrop click when
//                       closeOnBackdrop is set
//   closeLabel        — header button text while items remain ('Close')
//   closeOnBackdrop   — clicking the dimmed area closes (statements deck does)
//   z                 — stacking context; the Reports deck opens ON TOP of a
//                       drill modal (z-50) so it needs a higher layer than the
//                       statements deck, which opens over the page itself.
//   done              — show the summary panel instead of children
//   doneTitle / doneSummary / doneActionLabel
//   hint              — keyboard legend under the card
//   aside             — optional second column beside the card (the inline
//                       document preview). With one, the shell widens and goes
//                       two-column; without one it is exactly the deck that was
//                       here before. Hidden below `lg`, where a second column
//                       would squeeze the card that carries the decision.
//                       The layout lives here because all three decks want the
//                       same one, and deck chrome is what this component owns.
//   cardWidth         — the card column's width when an aside is present. Only
//                       the duplicate-pairs deck overrides it: its card is a
//                       620px side-by-side comparison, and the default would
//                       squeeze it to 448 the moment a preview appeared.
//   children          — the card. PASS A FUNCTION, not a node: when the deck
//                       finishes, `index` runs one past the end and the
//                       current item is undefined. A node would already have
//                       been evaluated by the caller and blown up on
//                       `item.direction`; a thunk is only invoked while there
//                       is still a card to draw. Plain nodes are accepted for
//                       decks whose card can't dereference a missing item.
export default function ReviewDeck({
  index,
  total,
  label = '',
  // Optional second reading beside "{i} of {n}" — the money the count is worth.
  // A node, not a number: every deck computes its own figure over its OWN rows
  // (a filtered drill opens a filtered deck), so the shell must not be tempted
  // to derive one from a total it cannot see.
  sub = null,
  onClose,
  closeLabel = 'Close',
  closeOnBackdrop = false,
  z = 80,
  done = false,
  doneTitle = 'All reviewed',
  doneSummary = '',
  doneActionLabel = 'Close',
  hint = '',
  aside = null,
  cardWidth = 'lg:max-w-md',
  children,
}) {
  // Clamp: index runs one past the end when the deck finishes.
  const seen = Math.min(index, total)
  const pct = total > 0 ? (seen / total) * 100 : 0
  // An aside only applies to a live card — the done panel is a summary, not a
  // decision, so there is nothing to show a document for.
  const withAside = !!aside && !done

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/60"
      style={{ zIndex: z }}
      onClick={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose() } : undefined}
    >
      {/* Below `lg` the aside is hidden, so the shell must stay max-w-md there or
          the card would stretch into space nothing is filling. */}
      <div className={withAside ? 'w-full max-w-md lg:max-w-5xl' : 'w-full max-w-md'}>
        <div className="flex items-center justify-between gap-2 mb-2 text-white/90 text-sm font-semibold">
          <span className="flex items-baseline gap-1.5 shrink-0">
            <span className="tabular-nums">{Math.min(index + 1, total)} of {total}</span>
            {sub ? <span className="tabular-nums font-medium text-white/55">· {sub}</span> : null}
          </span>
          {label ? <span className="text-white/60 truncate px-2 min-w-0">{label}</span> : null}
          <button onClick={onClose} className="text-white/70 hover:text-white shrink-0">
            {done ? 'Done — close' : closeLabel}
          </button>
        </div>
        <div className="h-1.5 bg-white/20 rounded-full mb-4 overflow-hidden">
          <div className="h-full bg-white/70 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>

        {done ? (
          <div className="bg-card rounded-2xl shadow-2xl p-8 text-center">
            <CheckCircle2 size={36} className="mx-auto mb-3 text-emerald-500" />
            <div className="text-lg font-black text-ink mb-1">{doneTitle}</div>
            {doneSummary ? <p className="text-sm text-gray-500 mb-4">{doneSummary}</p> : null}
            <button onClick={onClose} className="bg-ink text-card hover:opacity-85 rounded-lg px-5 py-2 text-sm font-bold">
              {doneActionLabel}
            </button>
          </div>
        ) : withAside ? (
          <>
            <div className="flex items-start gap-4">
              {/* The card keeps its own width — the extra space is the aside's,
                  not the card's, so the decision surface reads identically. */}
              <div className={`w-full ${cardWidth} lg:shrink-0 min-w-0`}>
                {typeof children === 'function' ? children() : children}
              </div>
              {/* The iframe needs a definite height to fill, so the panel is
                  sized here rather than by its content. */}
              <div className="hidden lg:block flex-1 min-w-0 h-[76vh]">{aside}</div>
            </div>
            {hint ? <p className="text-center text-white/60 text-[11px] mt-3">{hint}</p> : null}
          </>
        ) : (
          <>
            {typeof children === 'function' ? children() : children}
            {hint ? <p className="text-center text-white/60 text-[11px] mt-3">{hint}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}

// Whether the decks show the document panel. ONE key for all three: someone who
// turns the preview off in Bank Matching means "don't show me documents while I
// review", not "…only on this page", and finding it off in one deck and on in the
// next reads as a bug. Defaults ON — 93% of the statements deck's cards have a
// document, so the panel is the normal case.
const PREVIEW_KEY = 'deck_inline_preview'

export function useDeckPreview() {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(PREVIEW_KEY) !== '0' } catch { return true }
  })
  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v
      try { localStorage.setItem(PREVIEW_KEY, next ? '1' : '0') } catch { /* private mode */ }
      return next
    })
  }, [])
  return [on, toggle]
}

// Round action button used in both decks' control rows.
//
//   tone   — palette. 'amberOn' is the flagged (filled) state of 'amber'.
//   size   — 'md' (12) for secondary actions, 'lg' (14) / 'xl' (16) for accept.
//   label  — optional caption revealed under the circle on hover. The
//            reserved h-3 strip keeps the row from reflowing, so pass a
//            label on every button in a row or on none of them.
const TONES = {
  neutral: 'border-2 border-gray-200 text-gray-400 hover:bg-gray-50',
  amber: 'border-2 border-amber-200 text-amber-500 hover:bg-amber-50',
  amberOn: 'border-2 border-amber-400 bg-amber-50 text-amber-600',
  rose: 'border-2 border-rose-200 text-rose-500 hover:bg-rose-50',
  accept: 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg',
}
const LABEL_TONES = {
  neutral: 'text-gray-400',
  amber: 'text-amber-500',
  amberOn: 'text-amber-500',
  rose: 'text-rose-500',
  accept: 'text-emerald-600',
}
const SIZES = { md: 'w-12 h-12', lg: 'w-14 h-14', xl: 'w-16 h-16' }

export function DeckButton({ tone = 'neutral', size = 'md', label = '', className = '', children, ...rest }) {
  const btn = (
    <button
      {...rest}
      className={`${SIZES[size] || SIZES.md} rounded-full flex items-center justify-center disabled:opacity-30 ${TONES[tone] || TONES.neutral} ${className}`}
    >
      {children}
    </button>
  )
  if (!label) return btn
  return (
    <div className="group flex flex-col items-center">
      {btn}
      <span className={`text-[10px] font-bold mt-1 h-3 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap ${LABEL_TONES[tone] || LABEL_TONES.neutral}`}>
        {label}
      </span>
    </div>
  )
}
