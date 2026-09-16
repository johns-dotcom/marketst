import { useState, useEffect, useRef } from 'react'
import { Loader, ArrowRight, ChevronRight, Undo2, Ban, AlertTriangle } from 'lucide-react'
import api from '../api'
import ReviewDeck, { DeckButton } from './ReviewDeck'

// Card-at-a-time review of likely duplicate vendors.
//
// A component rather than page code, because BOTH the Vendors page and Vendor
// Flags open it. Two copies of a deck's keyboard handler and server calls is the
// duplication this codebase keeps paying for — the same reason Bank Matching
// ended up with two Review buttons reporting different counts.
//
// ReviewDeck supplies only the chrome (overlay, "{i} of {n}", the done panel, the
// round buttons). Its own header says the card, the keys and every server call
// stay with the owner, and they do.
//
// ── Why this deck can offer Undo at all ──────────────────────────────────────
//
// A merge renames rows and used to leave no record of WHICH rows moved, so the
// reverse could only go by name — dragging rows that always belonged to the
// target back to a name they never had. `vendor_merge_log` now stores the ids,
// and POST /bk/vendors/unmerge/:logId reverses by id. Where that record is
// missing (a merge whose log write failed) `logId` comes back null and Undo is
// disabled for that card rather than offering something it cannot do.

const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function VendorDupeDeck({ pairs, onClose, onChanged }) {
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  // Which name survives. Defaults to the server's `recommended` (the higher
  // invoice count), keyed by fingerprint so switching card and coming back keeps
  // the choice.
  const [winner, setWinner] = useState({})
  // What was done, so ⌫ can reverse the previous card. Each entry carries the
  // real inverse: a merge's logId, or an ack's fingerprint.
  const [history, setHistory] = useState([])
  const [stats, setStats] = useState({ merged: 0, notDupes: 0, skipped: 0 })
  const [err, setErr] = useState('')
  const dirty = useRef(false)

  const item = pairs[index]
  const done = index >= pairs.length

  const close = () => {
    // Refresh the caller only if something actually changed — a deck opened and
    // closed without a decision should not make the page flicker.
    if (dirty.current) onChanged?.()
    onClose()
  }

  const advance = (key, entry) => {
    setStats((s) => ({ ...s, [key]: s[key] + 1 }))
    setHistory((h) => [...h, { index, ...entry }])
    setIndex((i) => i + 1)
    setErr('')
  }

  const targetFor = (g) => winner[g.fingerprint] || g.recommended
  const sourceFor = (g) => {
    const t = targetFor(g)
    return g.vendors.find((v) => v.payee !== t)?.payee || g.vendors[1].payee
  }

  const merge = async () => {
    if (busy || !item) return
    setBusy(true)
    try {
      const source = sourceFor(item), target = targetFor(item)
      const { data } = await api.post('/bk/vendors/merge', { source, target })
      dirty.current = true
      advance('merged', { kind: 'merge', logId: data.logId ?? null, source, target })
    } catch (e) { setErr(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  const notDupes = async () => {
    if (busy || !item) return
    setBusy(true)
    try {
      await api.post('/bk/vendor-duplicates/ack', { fingerprint: item.fingerprint })
      dirty.current = true
      advance('notDupes', { kind: 'ack', fingerprint: item.fingerprint })
    } catch (e) { setErr(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  const skip = () => { if (!busy && item) advance('skipped', { kind: 'skip' }) }

  // Back = revisit the previous card AND undo what was done to it. Every action
  // this deck takes has a server-side inverse; a skip has nothing to undo.
  const back = async () => {
    if (busy) return
    const prev = history[history.length - 1]
    if (!prev) return
    setBusy(true)
    try {
      if (prev.kind === 'merge') {
        if (!prev.logId) {
          setErr('That merge was not recorded, so it cannot be undone here — merge the names back by hand on the Vendors page.')
          setBusy(false)
          return
        }
        await api.post(`/bk/vendors/unmerge/${prev.logId}`)
        dirty.current = true
      } else if (prev.kind === 'ack') {
        // The bk-scoped inverse, not /statements/flags/ack — that one is
        // Admin-only while the ack itself allows Approvers, so an Approver could
        // dismiss a pair here and then be refused when undoing it. Fingerprint on
        // the query string: a DELETE body is awkward for some clients.
        await api.delete(`/bk/vendor-duplicates/ack?fingerprint=${encodeURIComponent(prev.fingerprint)}`)
        dirty.current = true
      }
      setStats((s) => {
        const key = prev.kind === 'merge' ? 'merged' : prev.kind === 'ack' ? 'notDupes' : 'skipped'
        return { ...s, [key]: Math.max(0, s[key] - 1) }
      })
      setHistory((h) => h.slice(0, -1))
      setIndex(prev.index)
      setErr('')
    } catch (e) { setErr(e.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  // Same key vocabulary as the statements deck, so muscle memory carries over:
  // → accept · ← skip · ⌫ back · D dismiss-ish · Esc close. 1/2 picks the
  // winner, which is this deck's equivalent of 1-9 picking a category.
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight') { e.preventDefault(); merge() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); skip() }
      else if (e.key === 'Backspace') { e.preventDefault(); back() }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); notDupes() }
      else if (e.key === 'Escape') { e.preventDefault(); close() }
      else if ((e.key === '1' || e.key === '2') && item) {
        e.preventDefault()
        const pick = item.vendors[Number(e.key) - 1]
        if (pick) setWinner((w) => ({ ...w, [item.fingerprint]: pick.payee }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const canUndo = history.length > 0
  const prevKind = history[history.length - 1]?.kind

  return (
    <ReviewDeck
      index={index}
      total={pairs.length}
      onClose={close}
      closeLabel="Done — close"
      closeOnBackdrop
      done={done}
      doneTitle="Duplicates reviewed"
      doneSummary={`${stats.merged} merged · ${stats.notDupes} not duplicates`
        + (stats.skipped > 0 ? ` · ${stats.skipped} skipped (still suggested)` : '')}
      doneActionLabel="Back to vendors"
      hint="→ merge · ← skip · 1/2 pick the surviving name · D not duplicates · ⌫ undo · Esc close"
    >
      {() => (
        <div className="bg-card rounded-2xl shadow-2xl p-6 select-none">
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-[11px] font-semibold text-gray-400">Same vendor?</span>
            <span className="text-[12px] text-gray-500">{item.reason}</span>
            {item.tier === 'weak' && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700"
                title="The names overlap mid-word rather than on a word boundary — the weakest signal this detector reports, shown so you can judge it rather than trusting it.">
                <AlertTriangle size={11} /> weaker signal
              </span>
            )}
          </div>

          {/* Both names with their weight, and which one survives. The merge
              direction is the consequential part of this decision, so it is
              visible before the action rather than implied by the button. */}
          <div className="flex flex-col gap-2">
            {item.vendors.map((v, i) => {
              const keep = targetFor(item) === v.payee
              return (
                <button key={v.payee} type="button"
                  onClick={() => setWinner((w) => ({ ...w, [item.fingerprint]: v.payee }))}
                  className={`w-full text-left rounded-xl border px-3.5 py-3 transition ${
                    keep ? 'border-ink ring-1 ring-ink bg-gray-50' : 'border-rule bg-card hover:border-gray-300'}`}>
                  <span className="flex items-center gap-2.5">
                    <span className="text-[10px] font-bold text-gray-400 w-3">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-bold text-ink truncate">{v.payee}</span>
                      <span className="block text-[11.5px] text-gray-500 tabular-nums">
                        {v.invoices} {v.invoices === 1 ? 'entry' : 'entries'} · {fmt(v.total)}
                      </span>
                    </span>
                    {keep && <span className="text-[10px] font-bold uppercase tracking-wide text-ink shrink-0">keep this</span>}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mt-3 text-[12px] text-gray-500">
            Merging renames{' '}
            <strong className="font-semibold text-ink">
              {item.vendors.find((v) => v.payee === sourceFor(item))?.invoices ?? 0}
            </strong>{' '}
            {(item.vendors.find((v) => v.payee === sourceFor(item))?.invoices ?? 0) === 1 ? 'entry' : 'entries'} from{' '}
            <span className="font-mono">{sourceFor(item)}</span> to{' '}
            <span className="font-mono">{targetFor(item)}</span>, moves its bank links across, and records the old
            name as an alias. <span className="text-gray-400">Undoable from here.</span>
          </p>

          {err && (
            <div className="mt-3 rounded-lg border border-alert-bd bg-alert-bg px-3 py-2 text-[12px] text-ink">{err}</div>
          )}

          <div className="flex items-start justify-center gap-3 mt-5">
            <DeckButton onClick={back} disabled={busy || !canUndo}
              title={canUndo
                ? `Back — undo the ${prevKind === 'merge' ? 'merge' : prevKind === 'ack' ? '"not duplicates"' : 'skip'} on the previous card (⌫)`
                : 'Nothing to undo yet'}
              label="Undo">
              <Undo2 size={18} />
            </DeckButton>
            <DeckButton onClick={notDupes} disabled={busy} tone="rose" label="Not dupes"
              title="These are different vendors — never suggest this pair again (D)">
              <Ban size={18} />
            </DeckButton>
            <DeckButton onClick={skip} disabled={busy} label="Skip"
              title="Decide later — stays in the suggestions (←)">
              <ChevronRight size={20} className="rotate-180" />
            </DeckButton>
            <DeckButton onClick={merge} disabled={busy} tone="accept" size="xl"
              title={`Merge ${sourceFor(item)} into ${targetFor(item)} (→)`} label="Merge">
              {busy ? <Loader size={22} className="animate-spin" /> : <ArrowRight size={26} />}
            </DeckButton>
          </div>
        </div>
      )}
    </ReviewDeck>
  )
}
