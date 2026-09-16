import { Search, X } from 'lucide-react'

// Compact filter-as-you-type input for a list that's already loaded.
//
// Client-side only, by design: every page using this holds its full dataset,
// so filtering is instant and needs no request. Do NOT use it on a
// server-scoped list (the Payments dashboard's 14-day window, for example) —
// there, filtering the loaded rows shows "no matches" for records that simply
// weren't fetched, which reads as "nothing exists" and is how a filter starts
// lying. Those pages need a server round-trip instead.
//
// The `count`/`total` pair is deliberate: when a filter is active it shows
// "12 of 340", so a narrowed list never looks like the whole list. Same
// principle as the dismissal disclosures on Reports — the UI should say when
// it's showing you less than everything.
//
// Escape clears. The button is only rendered when there's something to clear,
// so it doesn't sit there as dead weight.
export default function ListSearch({
  value,
  onChange,
  placeholder = 'Search…',
  count = null,
  total = null,
  width = 260,
  className = '',
  autoFocus = false,
}) {
  const filtering = String(value || '').trim().length > 0
  const showCount = filtering && count != null && total != null

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <div className="relative" style={{ width }}>
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Stop page-level hotkeys (the review decks bind 1-9 / D / F)
            // from firing while someone is typing a query.
            e.stopPropagation()
            if (e.key === 'Escape') { e.preventDefault(); onChange('') }
          }}
          placeholder={placeholder}
          className="w-full border border-rule rounded-lg bg-card text-ink text-[12.5px] pl-7 pr-7 py-1.5 outline-none focus:border-boom-400"
        />
        {filtering && (
          <button
            onClick={() => onChange('')}
            title="Clear (Esc)"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-ink"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {showCount && (
        <span className="text-[11.5px] text-gray-500 tabular-nums whitespace-nowrap">
          {count} of {total}
        </span>
      )}
    </div>
  )
}

// Shared matcher: true when EVERY whitespace-separated term appears somewhere
// in the row's searchable fields. Multi-term means "amex 20000" narrows rather
// than widens, which is what people expect from a filter box.
//
// Nulls and numbers are tolerated so callers can pass raw row fields without
// pre-stringifying — amounts are matched as text, so "20000" finds 20000.00
// while "$20,000" does not. That's a real limitation, not an oversight:
// stripping currency formatting from a free-text query guesses at intent.
export function matchesQuery(query, fields) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = fields
    .filter((f) => f !== null && f !== undefined && f !== '')
    .map((f) => String(f).toLowerCase())
    .join('  ')
  return terms.every((t) => hay.includes(t))
}
