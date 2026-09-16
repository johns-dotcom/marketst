import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import api from '../api'

// The one "split this invoice between artists" dialog.
//
// John, 2026-09-01: "I want to be able to split payments between different
// songs/artists on the payments dashboard page." Splitting already existed on
// the Ledger, and 122 of the 312 rows on the Payments dashboard are already part
// of a split family — you just could not CREATE one from the page where you are
// looking at what to pay.
//
// Extracted rather than copied, and that is the whole point. A split is not a
// form, it is an operation with arithmetic: which slices exist, what the family
// total is, where the rounding remainder lands, and what "at least two" means.
// A second copy on Payments would be a second answer to each of those, and this
// repo has the scars — one artist-attribution path was rebuilt because the first
// had no caller, and the P&L drill and the report disagreed by $3.73M when two
// places derived the same money. The POST lives in here for the same reason:
// both pages send the identical payload or neither does.
//
// ── What the caller owns ──
// Styling tokens (`C`) and the refetch, because the two pages are styled
// differently and reload differently. Everything about the split itself — the
// rows, the total, the validation, the request — lives here.
//
// Props:
//   entry        the FAMILY ROOT being split (never a child — the caller gates)
//   family       parent + its non-deleted children, as the page already has
//                them. Used for the total and to pre-fill an existing split.
//   familyTotal  optional override when the page already knows it (Payments
//                gets `family_amount` from the server and does not load
//                children separately)
//   C            the page's colour tokens (getDarkColors)
//   songListId   optional (artist) => datalist id, for song suggestions
//   onClose      required
//   onDone       (count) => void — after a successful split; refetch here
//   onError      (message) => void
export default function SplitInvoiceModal({
  entry, family = [], familyTotal, C, songListId, onClose, onDone, onError,
}) {
  // The invoice as the VENDOR billed it, not the parent's leftover slice.
  //
  // A parent that has already been split holds only its own share — an $800
  // parent of a $2,005 invoice — so opening the dialog on it and dividing
  // "the amount" would quietly shrink the invoice by the children's value.
  // Prefer what the page was told (`family_amount`), then the loaded family,
  // then the row itself.
  const total = Number(
    familyTotal
    ?? (family.length
      ? family.reduce((s, r) => s + (Number(r.amount) || 0), 0)
      : entry?.amount)
  ) || 0

  const [rows, setRows] = useState(() => {
    // Re-splitting starts from what the split IS, not from a blank pair.
    // Preference order matters: the live family rows are the truth, and
    // `artist_breakdown` is a denormalised copy of them that can be stale (see
    // lib/split-breakdown.js) — so it is only the fallback for a page that has
    // the parent but not its children.
    const kids = family.filter((r) => r && r.id !== entry?.id)
    if (kids.length) {
      return [entry, ...kids].map((r) => ({
        artist: r.artist || '', song: r.song || '', amount: String(r.amount ?? ''),
      }))
    }
    if (Array.isArray(entry?.artist_breakdown) && entry.artist_breakdown.length > 1) {
      return entry.artist_breakdown.map((s) => ({
        artist: s.artist || '', song: s.song || '', amount: String(s.amount ?? ''),
      }))
    }
    return [
      { artist: entry?.artist || '', song: entry?.song || '', amount: '' },
      { artist: '', song: '', amount: '' },
    ]
  })
  const [busy, setBusy] = useState(false)

  // Did we manage to load the WHOLE invoice into this dialog?
  //
  // A split REPLACES every slice — the endpoint deletes the children and
  // recreates them from what is posted — so a dialog that opened on a partial
  // family would delete the slices it never showed. That is reachable on the
  // Payments dashboard, which is scoped to unpaid plus the last fortnight of
  // paid rows: a family can have one slice inside that window and one outside.
  //
  // Two signals, because either one alone misses a case. `is_split` is computed
  // by the server over the WHOLE family, so it knows about slices this page
  // never received — the case where the dialog opens with nothing prefilled and
  // looks like a fresh split. The arithmetic catches the rest: whatever we are
  // showing, if it does not add up to what the invoice is worth then something
  // is not on screen.
  const prefilled = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const alreadySplit = entry?.is_split === true
    || rows.filter((r) => parseFloat(r.amount) > 0).length > 1
  const missingSlices = alreadySplit && total > 0 && total - prefilled > 0.01

  const money = (n) => `${entry?.currency && entry.currency !== 'USD' ? `${entry.currency} ` : '$'}${
    Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const setRow = (i, patch) => setRows((prev) => prev.map((r, x) => (x === i ? { ...r, ...patch } : r)))
  const named = rows.filter((r) => (r.artist || '').trim())
  const splitTotal = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const remaining = total - splitTotal
  const balances = Math.abs(remaining) < 0.01

  // Divide evenly across the rows that name an artist. In CENTS, with the
  // remainder on the first slice, so three ways of $422 is 140.67 + 140.67 +
  // 140.66 and not 3 × 140.67 = $422.01. The split endpoint does NOT check that
  // the slices sum to the parent — it sets the parent to the first slice and
  // inserts the rest verbatim — so an extra cent here is an extra cent on the
  // invoice, silently.
  const splitEvenly = () => {
    if (!named.length) return
    const cents = Math.round(total * 100)
    const per = Math.floor(cents / named.length)
    let remainder = cents - per * named.length
    setRows((prev) => prev.map((r) => {
      if (!(r.artist || '').trim()) return r
      const c = per + (remainder > 0 ? remainder : 0)
      remainder = 0
      return { ...r, amount: (c / 100).toFixed(2) }
    }))
  }

  const submit = async () => {
    const valid = rows.filter((r) => (r.artist || '').trim() && r.amount !== '' && !Number.isNaN(parseFloat(r.amount)))
    if (valid.length < 2) {
      onError?.('Two artists with amounts, at least — that is what makes it a split.')
      return
    }
    setBusy(true)
    try {
      await api.post(`/bk/entries/${entry.id}/split`, {
        artist_breakdown: valid.map((r) => ({
          artist: r.artist.trim(), song: (r.song || '').trim(), amount: parseFloat(r.amount),
        })),
      })
      onDone?.(valid.length)
    } catch (err) {
      onError?.('Split failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const input = {
    padding: '8px 10px', border: `1.5px solid ${C?.border || '#e2e2e2'}`, borderRadius: 7,
    fontSize: 13, fontFamily: 'inherit', outline: 'none',
    background: C?.cardBg || '#fff', color: C?.text || '#111',
  }

  if (!entry) return null
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => !busy && onClose?.()}>
      <div style={{ background: C?.cardBg || '#fff', border: `1px solid ${C?.border || '#e2e2e2'}`, borderRadius: 10, padding: 28, width: 560, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,.25)', color: C?.text || '#111' }}
        onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Split between artists</h3>
        <p style={{ color: C?.textMuted || '#777', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          {entry.payee} — {money(total)}
          {entry.invoice_number ? ` · #${entry.invoice_number}` : ''}
        </p>

        {missingSlices && (
          <div style={{
            background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e',
            borderRadius: 8, padding: '9px 12px', fontSize: 12, lineHeight: 1.5, marginBottom: 12,
          }}>
            This invoice is already split and this page cannot see every slice —
            {money(prefilled)} of {money(total)} is showing here, and the rest is on a row outside
            what this view lists. Splitting <strong>replaces every slice</strong>, including the ones
            not shown. Enter the whole invoice, or split it from the Ledger, which always has the
            complete family.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="text" value={row.artist} placeholder="Artist"
                onChange={(e) => setRow(i, { artist: e.target.value })}
                style={{ ...input, flex: 1 }} />
              <input type="text" value={row.song} placeholder="Song (optional)"
                onChange={(e) => setRow(i, { song: e.target.value })}
                list={songListId ? songListId(row.artist) : undefined}
                autoComplete="off"
                style={{ ...input, flex: 1 }} />
              <input type="number" step="0.01" min="0" value={row.amount} placeholder="Amount"
                onChange={(e) => setRow(i, { amount: e.target.value })}
                style={{ ...input, width: 104, textAlign: 'right' }} />
              {rows.length > 2 && (
                <button onClick={() => setRows((prev) => prev.filter((_, x) => x !== i))}
                  title="Remove this slice"
                  style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer', padding: 4, display: 'flex' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#dc2626' }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#ccc' }}>
                  <Trash2 style={{ width: 14, height: 14 }} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button onClick={() => setRows((prev) => [...prev, { artist: '', song: '', amount: '' }])}
              style={{ background: 'none', border: 'none', color: C?.textMuted || '#777', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}>
              <Plus style={{ width: 13, height: 13 }} /> Add artist
            </button>
            <button onClick={splitEvenly} disabled={!named.length}
              title={named.length
                ? `Divide ${money(total)} evenly across the ${named.length} artist${named.length === 1 ? '' : 's'} listed`
                : 'Type at least one artist name first'}
              style={{
                background: named.length ? '#eef2ff' : 'transparent',
                border: named.length ? '1px solid #c7d2fe' : 'none',
                color: named.length ? '#4338ca' : '#bbb',
                fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                cursor: named.length ? 'pointer' : 'not-allowed',
                padding: named.length ? '4px 10px' : 0, borderRadius: 6,
              }}>
              Split evenly{named.length ? ` (${named.length})` : ''}
            </button>
          </div>
          {/* The arithmetic, out loud. The server accepts slices that do not add
              up — it writes what it is given — so this is the only place the
              difference is visible before it becomes the invoice. */}
          {rows.some((r) => r.amount) && (
            <span style={{ fontSize: 12, fontWeight: 700, color: balances ? '#15803d' : '#b45309' }}>
              Split: {money(splitTotal)}
              {!balances && (
                <span style={{ fontWeight: 400, color: C?.textMuted || '#999', marginLeft: 6 }}>
                  (invoice: {money(total)} ·{' '}
                  <span style={{ fontWeight: 700, color: remaining < 0 ? '#b91c1c' : '#b45309' }}>
                    {remaining < 0 ? 'over by ' : 'remaining: '}{money(Math.abs(remaining))}
                  </span>)
                </span>
              )}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center' }}>
          <button onClick={submit} disabled={busy}
            style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Splitting…' : 'Split'}
          </button>
          <button onClick={() => !busy && onClose?.()}
            style={{ background: C?.elevBg || '#f3f4f6', color: C?.text || '#111', border: 'none', borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>
            Cancel
          </button>
          {/* Splitting is reversible from the Ledger, which is worth saying on
              the page where the money is about to go out. */}
          <span style={{ fontSize: 11, color: C?.textMuted || '#999' }}>
            One invoice, several ledger rows. Undo it with “Unsplit” on the Ledger.
          </span>
        </div>
      </div>
    </div>
  )
}
