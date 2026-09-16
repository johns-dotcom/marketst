import { useState, useMemo } from 'react'
import { Check, ChevronRight, FileText, Zap } from 'lucide-react'
import ApprovalChecklistFields from './ApprovalChecklistFields'
import SocialHandlesEditor from './SocialHandlesEditor'
import { answerCobrand as nextCobrand, checklistComplete, checklistPayload, checklistOutstanding }
  from '../lib/approvalChecklist'
import ReviewDeck, { useDeckPreview } from './ReviewDeck'
import InlineFilePreview from './InlineFilePreview'
import { fileUrl, pickDoc } from '../utils/entryFiles'
import api from '../api'

// The checklist an approver completes before an invoice is accepted.
//
// John, 2026-08-19: "a checklist that approvers have to confirm before they can
// accept an invoice… correct artist? correct song? correct amount? correct
// category? bulk deal? on cobrand? It should pop up like a review deck."
//
// ── Two kinds of question, deliberately not styled alike ────────────────────
// The four CONFIRMATIONS are checkboxes: only "yes, that's right" is an answer.
// The two ANSWERS are Yes/No pairs, because "no" is a real answer there and it
// gets WRITTEN to is_bulk_deal / cobrand. That distinction is the point of the
// whole feature for those two fields: both columns are BOOLEAN DEFAULT FALSE
// across ~3,500 rows, so until now nothing separated "someone decided no" from
// "nobody ever looked".
//
// ── Editing un-ticks ────────────────────────────────────────────────────────
// Change a field and its confirmation clears. Not tidiness — correctness. The
// server forces category = 'Marketing' whenever cobrand is true (the same rule
// PUT /entries/:id has always had), so an approver can confirm "category:
// Services", then answer "yes, cobrand", and the row saves as Marketing —
// contradicting the checklist they just completed. Re-arming the tick makes
// that visible instead of silent.
//
// The server enforces all of this independently (validateApprovalChecklist in
// routes/bookkeeping.js). The disabled button here is a courtesy, not the gate.

const money = (a, c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(a || 0)

export default function ApprovalChecklistDeck({
  items = [],
  categories = [],
  breakdownFor = () => null,
  notifyFor = () => false,
  onApproved,
  onEntryPatched,
  onClose,
}) {
  const [index, setIndex] = useState(0)
  const [checks, setChecks] = useState({})     // { [entryId]: { artist: true, cobrand: false, … } }
  const [drafts, setDrafts] = useState({})     // { [entryId]: { amount: '123', … } } — in-flight edits
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Socials being edited, per entry. Kept OUT of `drafts` because that map feeds
  // `pending`, which is what the four confirmations are checked against — a
  // handle is not one of the things being confirmed, and putting it there would
  // silently widen what a tick means.
  const [socialDrafts, setSocialDrafts] = useState({})   // { [entryId]: [row, …] }
  const [rushBusy, setRushBusy] = useState(false)
  const [rushState, setRushState] = useState({})         // { [entryId]: {rush_requested, …} }
  const [approved, setApproved] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [previewOn, togglePreview] = useDeckPreview()

  const entry = items[index]
  const done = index >= items.length
  const c = (entry && checks[entry.id]) || {}
  // The row's rush state as it stands now — the server's answer once this deck
  // has touched it, the loaded row's until then.
  const rushNow = (entry && rushState[entry.id]) || entry || {}

  // What the row WILL hold once this checklist is applied — the card has to show
  // the value the approver is actually confirming, not the stored one.
  const pending = useMemo(() => {
    if (!entry) return {}
    const d = drafts[entry.id] || {}
    const category = c.cobrand === true ? 'Marketing' : (d.category ?? entry.category)
    return {
      artist: d.artist ?? entry.artist,
      song: d.song ?? entry.song,
      amount: d.amount ?? entry.amount,
      category,
    }
  }, [entry, drafts, c.cobrand])

  const setCheck = (key, val) => setChecks((p) => ({ ...p, [entry.id]: { ...(p[entry.id] || {}), [key]: val } }))

  // Answering cobrand changes the category, so the category confirmation is no
  // longer about the value that will be stored.
  // The implication (category re-armed, campaign forced) lives in
  // lib/approvalChecklist so Add Invoice's copy of this card cannot answer
  // cobrand differently from the deck's.
  const answerCobrand = (val) =>
    setChecks((p) => ({ ...p, [entry.id]: nextCobrand(p[entry.id] || {}, val) }))

  // Persist a field edit and clear its confirmation.
  const saveField = async (field, value) => {
    setBusy(true); setErr('')
    try {
      const body = { [field]: field === 'amount' ? Number(value) : (value || null) }
      if (field === 'amount' && !(Number(value) > 0)) throw new Error('Amount must be greater than zero')
      await api.put(`/bk/entries/${entry.id}`, body)
      setDrafts((p) => ({ ...p, [entry.id]: { ...(p[entry.id] || {}), [field]: body[field] } }))
      setChecks((p) => { const cur = { ...(p[entry.id] || {}) }; delete cur[field]; return { ...p, [entry.id]: cur } })
      onEntryPatched?.(entry.id, body)
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  // ── Socials: editable, and addable ────────────────────────────────────────
  //
  // Read-only was the wrong call. These are the handles the campaign is verified
  // against later, approval is the last point at which anybody looks at the
  // submission whole, and a vendor who typed their handle wrong (or left one
  // out) could only be fixed by leaving the deck for the ledger.
  //
  // The WHOLE row object is carried through an edit, not just platform+handle.
  // A social row may also hold `artist` (which artist of a split invoice this
  // handle belongs to) and `amount` (the per-creator carve-out of the invoice
  // total) — rebuilding rows as {platform, handle} is exactly how per-artist
  // scoping was lost before, which is why lib/socials.js normalizeSocialRows
  // exists as the one shape on the server.
  const socialsOf = (e) => {
    if (!e) return []
    if (socialDrafts[e.id]) return socialDrafts[e.id]
    return Array.isArray(e.social_handles) ? e.social_handles : []
  }
  const editSocial = (i, patch) => setSocialDrafts((p) => {
    const rows = [...socialsOf(entry)]
    rows[i] = { ...rows[i], ...patch }
    return { ...p, [entry.id]: rows }
  })
  const addSocial = () => setSocialDrafts((p) => ({
    ...p, [entry.id]: [...socialsOf(entry), { platform: '', handle: '' }],
  }))
  // Saved on blur, like every other field on this card. A row with no handle is
  // dropped by the server's normalizer, so an empty row someone added and did
  // not fill simply never lands — that is the same rule, not a second one.
  //
  // `rows` is passed IN rather than read back out of state. Removing a handle
  // has to save the list without that row, and a save that read state would run
  // on the previous render's copy — React has not flushed the setState by the
  // time the handler continues, so the removed handle would be written straight
  // back. (The first version hung the save on onMouseUp for this reason, which
  // is worse: mouseup fires BEFORE click, so it saved the list unchanged.)
  const persistSocials = async (rows) => {
    if (!rows) return
    setBusy(true); setErr('')
    try {
      const body = { social_handles: rows.filter((r) => String(r?.handle || '').trim()) }
      const { data } = await api.put(`/bk/entries/${entry.id}`, body)
      // Read the SERVER's normalized rows back rather than trusting the draft:
      // it trims, caps lengths and drops empties, and a card showing something
      // the database does not hold is how a wrong handle survives a review.
      const saved = Array.isArray(data?.data?.social_handles)
        ? data.data.social_handles
        : body.social_handles
      setSocialDrafts((p) => ({ ...p, [entry.id]: saved }))
      onEntryPatched?.(entry.id, { social_handles: saved })
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }
  const saveSocials = () => persistSocials(socialDrafts[entry.id])
  const removeSocial = (i) => {
    const rows = socialsOf(entry).filter((_, n) => n !== i)
    setSocialDrafts((p) => ({ ...p, [entry.id]: rows }))
    return persistSocials(rows)
  }

  // ── Rush ──────────────────────────────────────────────────────────────────
  //
  // The same two endpoints the Approvals page and the Payment Dashboard use, so
  // there is one meaning of "rush" and one place the AP team reads it. The
  // server enforces the rush/hold mutex (setting rush clears any hold) and
  // refuses a rush on a Paid row, so this mirrors what it did rather than
  // deciding anything itself.
  const rushOf = (e) => (e && rushState[e.id]) ? rushState[e.id] : (e || {})
  const toggleRush = async () => {
    if (!entry || rushBusy) return
    const now = rushOf(entry)
    const next = !now.rush_requested
    let reason = null
    if (next) {
      const r = window.prompt(
        'Rush reason (optional) — shows on the Payment Dashboard for the AP team.', '')
      if (r === null) return                       // cancelled, not "no reason"
      reason = r.trim() || null
    }
    setRushBusy(true); setErr('')
    try {
      const { data } = next
        ? await api.post(`/bk/payments/${entry.id}/rush`, { reason: reason || '' })
        : await api.delete(`/bk/payments/${entry.id}/rush`)
      const patch = data?.data || (next
        ? { rush_requested: true, rush_reason: reason, rush_requested_at: new Date().toISOString() }
        : { rush_requested: false, rush_reason: null, rush_requested_at: null })
      setRushState((p) => ({ ...p, [entry.id]: { ...rushOf(entry), ...patch } }))
      onEntryPatched?.(entry.id, patch)
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setRushBusy(false) }
  }

  const complete = checklistComplete(c)

  // The staged split for this card. Same source the approval posts, so what is
  // shown and what is applied cannot disagree.
  const splitRows = (entry && breakdownFor(entry.id)) || []
  const splitTotal = splitRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  const splitMismatch = splitRows.length > 1
    && Math.abs(splitTotal - (Number(pending.amount) || 0)) > 0.005

  const approve = async () => {
    if (!complete || busy) return
    setBusy(true); setErr('')
    try {
      const payload = {
        checklist: checklistPayload(c),
        notify: notifyFor(entry.id),
      }
      // A split staged on the row travels with the approval, so building a
      // breakdown on the page and reviewing it here is still one operation.
      const bd = breakdownFor(entry.id)
      if (bd && Array.isArray(bd) && bd.length > 1) payload.artist_breakdown = bd
      const r = await api.post(`/bk/entries/${entry.id}/approve`, payload)
      setApproved((n) => n + 1)
      onApproved?.(entry, r.data?.pending_email || null)
      setIndex((i) => i + 1)
    } catch (e) {
      setErr(e.response?.data?.error || e.message)
    } finally { setBusy(false) }
  }

  const skip = () => { setSkipped((n) => n + 1); setIndex((i) => i + 1) }

  const doc = entry ? pickDoc(entry) : null

  return (
    <ReviewDeck
      index={index}
      total={items.length}
      label={entry ? entry.payee : ''}
      onClose={onClose}
      closeLabel={approved > 0 ? 'Close' : 'Cancel'}
      z={90}
      done={done}
      doneTitle={approved ? `${approved} invoice${approved === 1 ? '' : 's'} approved` : 'Nothing approved'}
      doneSummary={skipped ? `${skipped} skipped — they stay pending on the page.` : ''}
      aside={previewOn && doc ? (
        <InlineFilePreview
          url={fileUrl(entry, doc.type)}
          filename={entry[doc.name]}
          label={doc.label}
          meta={entry.payee}
          emptyText="No document on this invoice." />
      ) : null}
      hint="P preview · Esc close"
    >
      {/* A FUNCTION, not a node — on the last card `index` runs one past the end
          and `entry` is undefined. */}
      {() => (
        <div className="bg-card rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-rule">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[15px] font-black text-ink truncate">{entry.payee}</div>
              <div className="text-[15px] font-black text-ink tabular-nums shrink-0">
                {money(pending.amount, entry.currency)}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="text-[11px] text-gray-400 truncate">
                {entry.invoice_number ? `inv ${entry.invoice_number} · ` : ''}
                {entry.vendor_submitted ? 'vendor-submitted' : 'entered by hand'}
                {doc ? '' : ' · no document attached'}
              </div>
              {/* RUSH — the same two endpoints the Approvals page and the
                  Payment Dashboard use, so "rush" means one thing and the AP
                  team reads it in one place. Here because an approver deciding
                  an invoice is fine is usually the person who also knows it is
                  urgent, and until now saying so meant closing the deck.

                  Not part of the checklist: it is a note to AP, not an answer
                  about the invoice, so it never gates Approve. */}
              <button
                type="button"
                onClick={toggleRush}
                disabled={rushBusy}
                title={rushNow.rush_requested
                  ? `Rush requested${rushNow.rush_requested_by ? ` by ${rushNow.rush_requested_by}` : ''}`
                    + `${rushNow.rush_reason ? ` — ${rushNow.rush_reason}` : ''}. Click to clear.`
                  : 'Mark this invoice RUSH — it surfaces on the Payment Dashboard for the AP team'}
                className={`ml-auto shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider border disabled:opacity-40 ${
                  rushNow.rush_requested
                    ? 'border-orange-400 bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300'
                    : 'border-rule text-gray-400 hover:text-ink hover:border-gray-300'}`}>
                <Zap size={10} className={rushNow.rush_requested ? 'fill-current' : ''} />
                Rush
              </button>
            </div>
          </div>

          {/* ── The split, when there is one ──────────────────────────────
              John, 2026-08-31: "split invoices don't show as split inside the
              reviews."

              The four confirmations show ONE artist, ONE song and the FULL
              amount, because that is what the parent row holds. On a split
              invoice that reads as a complete description and is not one: a
              $1,000 invoice covering Kaidro ($500) and Oxis ($500) asked the
              approver to confirm "Kaidro / $1,000.00" with the second artist
              nowhere on screen. The approver was ticking a box about a row that
              is about to become three rows.

              Read-only on purpose. The rows are edited on the card, where there
              is space for it; here they are shown so the tick means something.
              The total is checked against the invoice amount because a split
              that does not sum is a real and silent error class — the parent
              keeps its share and the difference simply disappears. */}
          {splitRows.length > 1 && (
            <div className="px-5 pt-3">
              <div className="rounded-xl border border-rule overflow-hidden">
                <div className="flex items-baseline justify-between gap-2 px-3 py-2 bg-gray-50 dark:bg-white/5 border-b border-rule">
                  <span className="text-[10px] font-black uppercase tracking-wider text-gray-500">
                    Splits across {splitRows.length} artists
                  </span>
                  <span className={`text-[11px] font-bold tabular-nums ${
                    splitMismatch ? 'text-red-600' : 'text-gray-400'}`}>
                    {money(splitTotal, entry.currency)}
                    {splitMismatch && ` ≠ ${money(pending.amount, entry.currency)}`}
                  </span>
                </div>
                <div className="divide-y divide-rule">
                  {splitRows.map((r, i) => (
                    <div key={i} className="flex items-baseline gap-2 px-3 py-1.5 text-[12px]">
                      <span className="font-bold text-ink truncate flex-1">{r.artist || '(no artist)'}</span>
                      <span className="text-gray-400 truncate flex-1">{r.song || '(no song)'}</span>
                      <span className="tabular-nums font-semibold text-ink shrink-0">
                        {money(Number(r.amount) || 0, entry.currency)}
                      </span>
                    </div>
                  ))}
                </div>
                {splitMismatch && (
                  <div className="px-3 py-2 text-[11px] text-red-700 bg-red-50 dark:bg-red-500/10 border-t border-rule">
                    The rows do not add up to the invoice amount. Approving will keep the
                    difference on the first artist&rsquo;s row.
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="px-5 py-3">
            {/* The questions themselves live in ApprovalChecklistFields, shared
                with Add Invoice's review — an admin's add files as `approved`
                without ever passing through this queue, so it has to ask the
                same things in the same way or the checklist means two things. */}
            <ApprovalChecklistFields
              values={pending}
              checks={c}
              onCheck={setCheck}
              onCobrand={answerCobrand}
              onFieldChange={saveField}
              categories={categories}
              context={entry}
              disabled={busy}
              fieldKey={String(entry.id)} />
          </div>

          {/* ── Socials ────────────────────────────────────────────────────────
              What the vendor gave us to find the work with. Editable, and
              addable: the handle is what campaign spend gets verified against
              later, approval is the last point at which anybody looks at the
              submission whole, and a typo could otherwise only be fixed by
              leaving the deck for the ledger. 319 of the live rows carry them.

              The editor is shared with Add Invoice's review. Persistence is not:
              here a change is a PUT on a saved row, there it is a draft that has
              not been created yet. */}
          <div className="px-5 pb-3">
            <SocialHandlesEditor
              rows={socialsOf(entry)}
              onChange={(next) => setSocialDrafts((p) => ({ ...p, [entry.id]: next }))}
              onCommit={persistSocials}
              disabled={busy}
              currency={entry.currency}
              listId="approval-social-platforms" />
          </div>

          {err && <div className="px-5 pb-2"><p className="text-[11px] text-rose-600">{err}</p></div>}

          <div className="px-5 py-3 border-t border-rule flex items-center gap-2">
            <button
              type="button"
              onClick={skip}
              disabled={busy}
              className="px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 disabled:opacity-40 inline-flex items-center gap-1"
              title="Leave this one pending and move on"
            >
              Skip <ChevronRight size={13} />
            </button>
            {doc && (
              <button
                type="button"
                onClick={togglePreview}
                className="px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 inline-flex items-center gap-1"
                title="Show or hide the document panel"
              >
                <FileText size={13} /> {previewOn ? 'Hide' : 'Show'}
              </button>
            )}
            {/* A real labelled button, NOT DeckButton — that one is a round icon
                button and a sentence inside it wraps into a blob. */}
            <button
              type="button"
              onClick={approve}
              disabled={!complete || busy}
              className="ml-auto px-4 py-2 rounded-lg text-[13px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              title={complete ? 'Approve this invoice' : 'Every item has to be answered first'}
            >
              {busy ? 'Approving…' : <><Check size={14} strokeWidth={3} /> Approve</>}
            </button>
          </div>
          {!complete && (
            <div className="px-5 pb-3 -mt-1">
              <p className="text-[11px] text-gray-400">
                {checklistOutstanding(c).join(' · ')} still to answer
              </p>
            </div>
          )}
        </div>
      )}
    </ReviewDeck>
  )
}
