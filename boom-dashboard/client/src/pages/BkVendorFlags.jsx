import { useEffect, useRef, useState } from 'react'
import { Flag, ArrowRight, ArrowLeftRight, Loader, Zap } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import api from '../api'
import VendorDupeDeck from '../components/VendorDupeDeck'

// Vendor Flags — likely duplicate ledger vendors with one-click merging.
// Pairs come from name normalization (case/punctuation variants score 100)
// and the shared fuzzy vendor matcher. Merging uses the existing
// /bk/vendors/merge (renames all entries + records the alias); "Not
// duplicates" persists so a dismissed pair never nags again.

const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function BkVendorFlags({ embedded = false, onCount }) {
  const { user } = useAuth()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null) // fingerprint being acted on
  // Per-group merge direction override: fingerprint -> target payee
  const [targets, setTargets] = useState({})
  // Keyboard review cursor — same conventions as the statements deck
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(null)
  // Custom-name merge editor: which pair, and the name being typed
  const [customEdit, setCustomEdit] = useState(null)
  const [customName, setCustomName] = useState('')

  const isAdminRole = user && (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver')

  const [autoMerged, setAutoMerged] = useState(0)
  // The deck. Card-at-a-time over the same `groups` this page lists, so the
  // button's count, the deck's "of N" and the list length are one number.
  const [deckOpen, setDeckOpen] = useState(false)
  const fetchGroups = async () => {
    try {
      const res = await api.get('/bk/vendor-duplicates')
      const list = Array.isArray(res.data.data) ? res.data.data : []
      setGroups(list)
      onCount?.(list.length)
      if (res.data.auto_merged > 0) setAutoMerged(res.data.auto_merged)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setLoading(false) }
  }
  // One confirm, every high-confidence pair merged into its recommended
  // keeper — the Spotify/FACEBK-style substring tail in one click.
  const mergeAllHigh = async () => {
    const high = groups.filter((g) => g.score >= 85)
    if (!high.length) return
    if (!window.confirm(
      `Merge all ${high.length} high-confidence pair${high.length === 1 ? '' : 's'} (≥85%)?\n\n` +
      high.slice(0, 8).map((g) => `• "${sourceOf(g)}" → "${targetOf(g)}"`).join('\n') +
      (high.length > 8 ? `\n…and ${high.length - 8} more` : '')
    )) return
    setBusy('bulk')
    try {
      for (const g of high) {
        await api.post('/bk/vendors/merge', { source: sourceOf(g), target: targetOf(g) }).catch(() => {})
      }
      await fetchGroups()
    } finally { setBusy(null) }
  }
  useEffect(() => { if (isAdminRole) fetchGroups() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  const targetOf = (g) => targets[g.fingerprint] || g.recommended
  const sourceOf = (g) => g.vendors.find((v) => v.payee !== targetOf(g))?.payee

  const merge = async (g) => {
    const target = targetOf(g)
    const source = sourceOf(g)
    if (!window.confirm(`Merge "${source}" into "${target}"?\n\nAll of "${source}"'s entries are renamed to "${target}" and "${source}" becomes an alias.`)) return
    setBusy(g.fingerprint)
    try {
      await api.post('/bk/vendors/merge', { source, target })
      setGroups((prev) => prev.filter((x) => x.fingerprint !== g.fingerprint))
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }
  // Merge BOTH names into a custom third spelling ("fang_w3" + "Fang_w3"
  // → "Fang W3"): merge each existing name into the custom target; both
  // become aliases of it.
  const mergeCustom = async (g) => {
    const name = (customName || '').trim()
    if (!name) return
    if (!window.confirm(`Merge ${g.vendors.map((v) => `"${v.payee}"`).join(' and ')} into "${name}"?\n\nAll entries are renamed to "${name}"; both old names become aliases.`)) return
    setBusy(g.fingerprint)
    try {
      for (const v of g.vendors) {
        if (v.payee.trim().toLowerCase() === name.toLowerCase()) continue
        await api.post('/bk/vendors/merge', { source: v.payee, target: name })
      }
      setCustomEdit(null); setCustomName('')
      setGroups((prev) => prev.filter((x) => x.fingerprint !== g.fingerprint))
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }
  // Same company, but keep both names on their entries — record the alias
  // so submissions/matching treat them as one, without renaming history.
  const aliasOnly = async (g) => {
    const target = targetOf(g)
    const source = sourceOf(g)
    if (!window.confirm(`Keep both names, but record "${source}" as an alias of "${target}"?\n\nNo entries are renamed — submissions and matching treat them as the same vendor going forward.`)) return
    setBusy(g.fingerprint)
    try {
      await api.post('/bk/vendors/aliases', { primary_name: target, alias: source })
      setGroups((prev) => prev.filter((x) => x.fingerprint !== g.fingerprint))
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }
  const notDuplicates = async (g) => {
    setBusy(g.fingerprint)
    try {
      // bk-scoped ack so Approvers (full bookkeeping access) can dismiss
      // pairs — the /statements ack endpoint is Admin/Superadmin only.
      await api.post('/bk/vendor-duplicates/ack', { fingerprint: g.fingerprint })
      setGroups((prev) => prev.filter((x) => x.fingerprint !== g.fingerprint))
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(null) }
  }

  // Keyboard review over the LIST: ↑↓ move · → merge · ← skip · S swap ·
  // C custom name · A alias only · D not duplicates.
  //
  // Kept, but it is no longer the primary review flow — the deck is, and it can
  // undo a merge, which this cannot. What this still uniquely offers is the two
  // actions the deck deliberately omits: a custom third name (a text field fights
  // a keyboard deck) and alias-only (keep both names, record the relationship).
  // Suspended while the deck is open, or both handlers would fire on one keypress.
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || !groups.length || deckOpen) return
      const g = groups[Math.min(cursor, groups.length - 1)]
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setCursor((c) => Math.min(c + 1, groups.length - 1)) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor((c) => Math.min(c + 1, groups.length - 1)) }
      else if (e.key === 'ArrowRight' && g) { e.preventDefault(); merge(g) }
      else if ((e.key === 's' || e.key === 'S') && g) { e.preventDefault(); setTargets((prev) => ({ ...prev, [g.fingerprint]: sourceOf(g) })) }
      else if ((e.key === 'c' || e.key === 'C') && g) { e.preventDefault(); setCustomEdit(g.fingerprint); setCustomName(targetOf(g)) }
      else if ((e.key === 'a' || e.key === 'A') && g) { e.preventDefault(); aliasOnly(g) }
      else if ((e.key === 'd' || e.key === 'D' || e.key === 'n' || e.key === 'N') && g) { e.preventDefault(); notDuplicates(g) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // re-binds each render so handlers see fresh groups/cursor/targets

  // Keep the cursor row in view and clamp it when the list shrinks
  useEffect(() => {
    if (cursor > groups.length - 1) setCursor(Math.max(0, groups.length - 1))
    cursorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor, groups.length])

  if (!isAdminRole) {
    return <div className="p-6 text-sm text-gray-500">Admin access required.</div>
  }

  return (
    <div className={embedded ? '' : 'p-4 sm:p-6 max-w-4xl mx-auto'}>
      {!embedded && (
        <>
          <div className="flex items-center gap-2 mb-1">
            <Flag size={20} className="text-boom-600" />
            <h1 className="text-xl font-extrabold text-ink">Vendor Flags</h1>
            {groups.length > 0 && (
              <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{groups.length} likely duplicates</span>
            )}
          </div>
          <p className="text-sm text-gray-500 mb-1">Vendors that look like the same company under two names. Merging renames every entry and records the alias, so submissions and matching treat them as one going forward.</p>
        </>
      )}
      {/* The deck leads: 56 pairs is a queue, and a queue wants one card at a
          time with an undo, not a list to scan. The list stays underneath for
          the two things the deck deliberately does not do — a custom third name
          and alias-only — and for picking off a single pair you can see. */}
      {groups.length > 0 && (
        <div className="mb-3">
          <button onClick={() => setDeckOpen(true)}
            title="Work the duplicates one card at a time — pick the surviving name, merge, or mark them different. Every merge is undoable from inside the deck."
            className="inline-flex items-center gap-1.5 bg-ink text-card rounded-lg px-3.5 py-2 text-[13px] font-bold hover:opacity-85 transition">
            <Zap size={13} /> Review {groups.length}
          </button>
        </div>
      )}
      <p className="text-[11px] text-gray-400 mb-4">or work the list: ↑ ↓ move · → merge · ← skip · S swap · C custom name · A alias only · D not duplicates</p>

      {autoMerged > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 text-sm mb-3">
          {autoMerged} exact formatting variant{autoMerged === 1 ? '' : 's'} (case/punctuation/spacing) auto-merged just now — no review needed for those.
        </div>
      )}
      {groups.filter((g) => g.score >= 85).length > 0 && (
        <div className="mb-4">
          <button onClick={mergeAllHigh} disabled={busy === 'bulk'}
            className="inline-flex items-center gap-1.5 bg-boom-600 hover:bg-boom-700 text-white rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50">
            {busy === 'bulk' ? <Loader size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            Merge all {groups.filter((g) => g.score >= 85).length} high-confidence (≥85%)
          </button>
        </div>
      )}

      {deckOpen && groups.length > 0 && (
        <VendorDupeDeck
          pairs={groups}
          onClose={() => setDeckOpen(false)}
          onChanged={fetchGroups}
        />
      )}

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm mb-4">{error}</div>}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Scanning vendors…</div>
      ) : groups.length === 0 ? (
        <div className="text-sm text-gray-400 py-10 text-center border border-dashed border-rule rounded-xl">
          No likely duplicates — every vendor name stands alone.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g, i) => {
            const target = targetOf(g)
            const source = sourceOf(g)
            const active = i === Math.min(cursor, groups.length - 1)
            return (
              <div key={g.fingerprint} ref={active ? cursorRef : null}
                onClick={() => setCursor(i)}
                className={`bg-card border rounded-xl p-4 ${active ? 'border-boom-600 ring-1 ring-boom-600' : 'border-rule'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded ${g.score >= 95 ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{g.score}%</span>
                  <span className="text-[12px] text-gray-500">{g.reason}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {g.vendors.map((v) => (
                    <div key={v.payee}
                      className={`flex-1 min-w-[200px] border rounded-lg px-3 py-2 ${v.payee === target ? 'border-emerald-300 bg-emerald-50/40' : 'border-rule'}`}>
                      <div className="text-[13px] font-bold text-ink truncate">{v.payee}</div>
                      <div className="text-[11px] text-gray-400">{v.invoices} entr{v.invoices === 1 ? 'y' : 'ies'} · {fmt(v.total)}</div>
                      {v.payee === target && <div className="text-[10px] font-bold text-emerald-700 mt-0.5">keeps this name</div>}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <button onClick={() => merge(g)} disabled={busy === g.fingerprint}
                    className="inline-flex items-center gap-1.5 bg-boom-600 hover:bg-boom-700 text-white rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50">
                    {busy === g.fingerprint ? <Loader size={12} className="animate-spin" /> : <ArrowRight size={13} />}
                    Merge "{source?.slice(0, 24)}" into "{target?.slice(0, 24)}"
                  </button>
                  <button onClick={() => setTargets((prev) => ({ ...prev, [g.fingerprint]: sourceOf(g) }))}
                    title="Keep the other name instead"
                    className="inline-flex items-center gap-1 border border-rule text-gray-500 hover:text-ink rounded-lg px-2.5 py-1.5 text-xs font-bold">
                    <ArrowLeftRight size={12} /> Swap
                  </button>
                  <button onClick={() => { setCustomEdit(customEdit === g.fingerprint ? null : g.fingerprint); setCustomName(targetOf(g)); setCursor(i) }}
                    title="Merge both into a name you type (fix capitalization, spacing…)"
                    className="border border-rule text-gray-500 hover:text-ink rounded-lg px-2.5 py-1.5 text-xs font-bold">
                    Custom name…
                  </button>
                  <button onClick={() => aliasOnly(g)} disabled={busy === g.fingerprint}
                    title="Keep both names on their entries, but record them as the same vendor (alias)"
                    className="border border-rule text-gray-500 hover:text-ink rounded-lg px-2.5 py-1.5 text-xs font-bold">
                    Alias only
                  </button>
                  <button onClick={() => notDuplicates(g)} disabled={busy === g.fingerprint}
                    className="ml-auto text-xs font-bold text-gray-400 hover:text-gray-600 px-2 py-1.5">
                    Not duplicates
                  </button>
                </div>
                {customEdit === g.fingerprint && (
                  <div className="flex items-center gap-2 mt-2">
                    <input autoFocus value={customName} onChange={(e) => setCustomName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') mergeCustom(g); if (e.key === 'Escape') setCustomEdit(null) }}
                      placeholder="Final vendor name…"
                      className="flex-1 max-w-xs border border-rule rounded-lg px-3 py-1.5 text-[13px] bg-card text-ink outline-none" />
                    <button onClick={() => mergeCustom(g)} disabled={busy === g.fingerprint || !customName.trim()}
                      className="bg-boom-600 hover:bg-boom-700 text-white rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40">
                      Merge both into this name
                    </button>
                    <button onClick={() => setCustomEdit(null)} className="text-xs text-gray-400 hover:text-gray-600">cancel</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
