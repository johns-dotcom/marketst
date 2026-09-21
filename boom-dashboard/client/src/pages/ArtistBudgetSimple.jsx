// The artist budget sheet, the simple one.
//
// John, 2026-09-18, on the 32-category grid: "budget sheets should be basic
// and editable. this is too much to start. there should be total artist budgets
// (advance, total marketing) and release budgets inside that."
//
//                        BUDGET      SPENT       LEFT
//   Advance           [ 25,000 ]    25,000          —
//   Total marketing   [ 40,000 ]    18,200     21,800    allocated 30,000 of 40,000
//     Night Drive     [ 20,000 ]    12,400      7,600
//     Late Message    [ 10,000 ]     5,800      4,200
//     Not tied to a release    —         —          —
//   Other spend              —      1,250          —    read-only
//   ──────────────────────────────────────────────────
//   Total               65,000     44,450     20,550
//
// Three columns (John: "Budget · Spent · Left"). Spent is what the ledger has
// PAID; unpaid invoices show as a small note under it, never as the headline.
// Release budgets are independent of Total marketing, with the gap shown.
// Typing in a cell saves it on blur or Enter; Esc puts the old value back.
// The category grid this replaced is one click away ("Full breakdown") and
// nothing typed there is lost.
import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Table2, AlertTriangle, Loader } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import Breadcrumb from '../components/Breadcrumb'
import { useToast } from '../context/ToastContext'
import { formatDate } from '../utils'

const usd = (v) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(Number(v) || 0)
const money = (v) => (Math.abs(Number(v) || 0) < 0.5 ? '—' : usd(v))
const parseAmount = (raw) => {
  const s = String(raw ?? '').replace(/[$,\s]/g, '')
  if (s === '') return 0
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// One editable dollar cell. Saves the parsed number on blur or Enter when it
// changed; Esc reverts. `escaped` is a ref so the blur that follows Esc does
// not read the stale input and save what the user just threw away.
function BudgetInput({ value, onSave, saving, label }) {
  const [draft, setDraftState] = useState(null)   // null = not editing
  // The draft lives in a ref as well as in state. commit() runs from a blur
  // handler whose closure may hold a stale draft — and a blur can follow an
  // Esc (or a second blur can follow the first) before React has re-rendered.
  // Reading the ref, and clearing it synchronously, makes a repeat commit a
  // no-op instead of a save of text the user already threw away.
  const draftRef = useRef(null)
  const escaped = useRef(false)
  const setDraft = (v) => { draftRef.current = v; setDraftState(v) }
  const shown = draft ?? (value ? String(Math.round(value)) : '')
  const commit = () => {
    const current = draftRef.current
    if (escaped.current) { escaped.current = false; setDraft(null); return }
    if (current == null) return
    setDraft(null)
    const n = parseAmount(current)
    if (n == null || n === Number(value || 0)) return
    onSave(n)
  }
  return (
    <span className="relative inline-flex items-center justify-end">
      {saving && <Loader size={11} className="absolute -left-4 animate-spin text-gray-400" />}
      <input
        type="text" inputMode="decimal" aria-label={label}
        value={shown}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { if (draftRef.current == null) setDraft(value ? String(Math.round(value)) : '') }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
          if (e.key === 'Escape') { escaped.current = true; e.target.blur() }
        }}
        className="w-28 text-right tabular-nums text-[13px] font-semibold text-ink bg-transparent border border-transparent hover:border-rule focus:border-boom-500 focus:bg-card rounded px-2 py-1 focus:outline-none"
      />
    </span>
  )
}

function Cell({ children, right = true, muted, cls = '' }) {
  return (
    <td className={`py-2 px-3 tabular-nums text-[13px] ${right ? 'text-right' : ''} ${muted ? 'text-gray-400' : 'text-ink'} ${cls}`}>
      {children}
    </td>
  )
}

function OpenNote({ line }) {
  if (!line || !(line.open > 0)) return null
  return (
    <span className="block text-[10.5px] text-amber-700 font-normal leading-tight">
      +{usd(line.open)} unpaid
    </span>
  )
}

function LeftCell({ line, bold }) {
  if (!line.budget) return <Cell muted>—</Cell>
  const cls = line.left < 0 ? 'text-rose-600' : 'text-emerald-700'
  return <Cell cls={`${cls} ${bold ? 'font-bold' : ''}`}>{line.left < 0 ? `−${usd(-line.left)}` : usd(line.left)}</Cell>
}

export default function ArtistBudgetSimple() {
  const { artistKey } = useParams()
  const [searchParams] = useSearchParams()
  const openedAs = searchParams.get('name') || ''
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState('')
  const toast = useToast()

  const load = async () => {
    try {
      const r = await api.get(`/artist-budgets/${encodeURIComponent(artistKey)}/simple`)
      setData(r.data?.data || null)
    } catch (e) { setErr(e.response?.data?.error || e.message) }
  }
  useEffect(() => { setData(null); load() /* eslint-disable-next-line */ }, [artistKey])

  const save = async (what, body, id) => {
    setSaving(id)
    try {
      await api.put(`/artist-budgets/${encodeURIComponent(artistKey)}/${what}`, body)
      await load()
    } catch (e) {
      toast?.error?.(e.response?.data?.error || e.message)
    } finally { setSaving('') }
  }

  if (err) {
    return (
      <div className="card p-6">
        <p className="text-[13px] font-bold text-rose-600">{err}</p>
        <Link to="/artist-budgets" className="text-[12px] text-gray-500 hover:text-ink inline-flex items-center gap-1 mt-2">
          <ArrowLeft size={12} /> All budgets
        </Link>
      </div>
    )
  }
  if (!data) return <div className="space-y-5"><Skeleton.PageHeader /><Skeleton.Block h="h-64" /></div>

  const { advance, marketing, other, totals } = data
  const title = data.artist === artistKey && openedAs ? openedAs : data.artist
  const nothingYet = !totals.budget && !totals.spent && !totals.open

  return (
    <div className="space-y-5" data-simple-sheet data-tour="budget-simple-page">
      <Breadcrumb items={[
        { label: 'Artists', path: '/artists' },
        data.artist_id ? { label: title, path: `/artists/${data.artist_id}` } : { label: title },
        { label: 'Budget' },
      ]} />
      <PageHeader tour="budget-simple-header"
        title={title}
        subtitle="Two totals and the releases under them. Type a budget in a cell; it saves when you leave it."
        actions={(
          <>
            <Link to="/artist-budgets"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300">
              <ArrowLeft size={13} /> All budgets
            </Link>
            <Link to={`/artist-budgets/${encodeURIComponent(artistKey)}/detail${openedAs ? `?name=${encodeURIComponent(openedAs)}` : ''}`}
              data-action="full-breakdown"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300"
              title="Every expense category as its own row, with spend matched by category">
              <Table2 size={13} /> Full breakdown
            </Link>
          </>
        )}
      />

      {nothingYet && (
        <div className="card p-3 text-[12.5px] text-gray-500">
          Nothing on this artist yet. Type the advance and the marketing total below; releases appear here as they are added on Releases.
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-divider text-[10px] font-bold uppercase tracking-wider text-gray-400">
              <th className="text-left py-2 px-3 font-bold">&nbsp;</th>
              <th className="text-right py-2 px-3 font-bold w-36">Budget</th>
              <th className="text-right py-2 px-3 font-bold w-36">Spent</th>
              <th className="text-right py-2 px-3 font-bold w-36">Left</th>
            </tr>
          </thead>
          <tbody>
            {/* Advance */}
            <tr className="border-b border-divider" data-line="advance">
              <Cell right={false} cls="font-bold">Advance</Cell>
              <Cell><BudgetInput label="Advance budget" value={advance.budget} saving={saving === 'advance'}
                onSave={(amount) => save('advance', { amount }, 'advance')} /></Cell>
              <Cell>{money(advance.spent)}<OpenNote line={advance} /></Cell>
              <LeftCell line={advance} />
            </tr>

            {/* Total marketing */}
            <tr className="border-b border-divider bg-gray-50/60" data-line="marketing">
              <Cell right={false} cls="font-bold">
                Total marketing
                {marketing.budget > 0 && (
                  <span className={`block text-[10.5px] font-normal leading-tight ${marketing.over_allocated ? 'text-rose-600' : 'text-gray-400'}`} data-allocated>
                    {marketing.over_allocated && <AlertTriangle size={10} className="inline mr-1 -mt-0.5" />}
                    allocated {usd(marketing.allocated)} of {usd(marketing.budget)} to releases
                    {marketing.over_allocated ? ' — more than the total' : marketing.unallocated > 0 ? ` · ${usd(marketing.unallocated)} not yet allocated` : ''}
                  </span>
                )}
              </Cell>
              <Cell><BudgetInput label="Total marketing budget" value={marketing.budget} saving={saving === 'marketing'}
                onSave={(amount) => save('marketing', { amount }, 'marketing')} /></Cell>
              <Cell>{money(marketing.spent)}<OpenNote line={marketing} /></Cell>
              <LeftCell line={marketing} />
            </tr>
            {marketing.releases.map((r) => (
              <tr key={r.release_id} className="border-b border-divider" data-release={r.release_id}>
                <Cell right={false} cls="pl-8">
                  <Link to={`/releases/${r.release_id}`} className="text-gray-700 hover:text-boom-600 hover:underline">{r.title}</Link>
                  {r.release_date && <span className="ml-2 text-[10.5px] text-gray-400">{formatDate(r.release_date)}</span>}
                </Cell>
                <Cell><BudgetInput label={`${r.title} budget`} value={r.budget} saving={saving === `rel:${r.release_id}`}
                  onSave={(amount) => save('release', { release_id: r.release_id, amount }, `rel:${r.release_id}`)} /></Cell>
                <Cell>{money(r.spent)}<OpenNote line={r} /></Cell>
                <LeftCell line={r} />
              </tr>
            ))}
            {marketing.releases.length === 0 && (
              <tr className="border-b border-divider">
                <Cell right={false} cls="pl-8 text-gray-400 text-[12px]" muted>
                  No releases yet — add one on <Link to="/releases" className="underline hover:text-ink">Releases</Link> and it appears here with its own budget cell.
                </Cell>
                <Cell muted>—</Cell><Cell muted>—</Cell><Cell muted>—</Cell>
              </tr>
            )}
            {(marketing.unassigned.spent > 0 || marketing.unassigned.open > 0) && (
              <tr className="border-b border-divider" data-line="unassigned">
                <Cell right={false} cls="pl-8 text-gray-500" muted>Not tied to a release</Cell>
                <Cell muted>—</Cell>
                <Cell>{money(marketing.unassigned.spent)}<OpenNote line={marketing.unassigned} /></Cell>
                <Cell muted>—</Cell>
              </tr>
            )}

            {/* Everything else the ledger spent on this artist — read-only, so the sheet still ties to the ledger */}
            <tr className="border-b border-divider" data-line="other">
              <Cell right={false} cls="text-gray-600">
                Other spend
                {other.categories.length > 0 && (
                  <span className="block text-[10.5px] text-gray-400 font-normal leading-tight">
                    {other.categories.map((c) => `${c.category} ${usd(c.spent)}`).join(' · ')}
                  </span>
                )}
              </Cell>
              <Cell muted title="Other spend has no budget line on this sheet. Open Full breakdown to budget by category.">—</Cell>
              <Cell>{money(other.spent)}<OpenNote line={other} /></Cell>
              <Cell muted>—</Cell>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-rule" data-line="total">
              <Cell right={false} cls="font-bold">Total</Cell>
              <Cell cls="font-bold">{money(totals.budget)}</Cell>
              <Cell cls="font-bold">{money(totals.spent)}<OpenNote line={totals} /></Cell>
              <LeftCell line={totals} bold />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">
        Spent is what the ledger has paid. Left is Budget minus Spent. Release budgets are independent of Total marketing; the line under it shows how much of the total they add up to.
      </p>
    </div>
  )
}
