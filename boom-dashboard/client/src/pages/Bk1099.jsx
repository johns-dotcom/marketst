import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader, Download, ScanLine, AlertTriangle, CheckCircle2, Ban, Mail, FileText, Lock,
} from 'lucide-react'
import api from '../api'
import FilePreview from '../components/FilePreview'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

// The 1099 run.
//
// `GET /bk/1099` has computed the money correctly for a while — payments made in
// the calendar year, alias-folded, locked FX, reimbursements excluded — and had
// NO page. So the numbers existed and nobody could see them, which is the same
// as not having them in January.
//
// Three questions, in the order they get asked:
//
//   1. who has to get a form            → Reportable
//   2. what is stopping us filing       → Needs attention (the chase list)
//   3. who was left out, and why        → Excluded
//
// The exclusions are ON THIS PAGE rather than implied by absence, because an
// exclusion nobody can see reads exactly like an omission — and the corporation
// rule has an exception (attorney and medical payments) that a person has to be
// able to check.

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function Bk1099() {
  const { user } = useAuth()
  const toast = useToast()
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('reportable')
  // Which W-9 is open. The 1099 page lists VENDORS, so the id comes from the
  // server's w9_entry_id — the entry that actually holds the document, resolved
  // through the alias walk in lib/w9-owner. Building the URL from anything else
  // is the mistake the "use entry.w9_entry_id || entry.id" rule exists to stop.
  const [previewW9, setPreviewW9] = useState(null)
  // The W-9 read: 10 vendors per call, driven in a loop from here.
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [remaining, setRemaining] = useState(null)

  const canSeeFullTin = ['Admin', 'Superadmin'].includes(user?.role)

  const load = async (y = year) => {
    setLoading(true); setError('')
    try {
      const r = await api.get(`/bk/1099?year=${y}`)
      setData(r.data?.data || [])
      setMeta(r.data?.meta || null)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load(year) }, [year]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read the TIN and line 3 off every W-9 that has not been read yet.
  //
  // Batched server-side at 10, so this loops until it says there are none left.
  // Stops on the first failure rather than spinning: a scan that cannot reach
  // Claude will not start working on attempt forty.
  const scanW9s = async () => {
    setScanning(true); setScanned(0)
    try {
      for (let i = 0; i < 200; i += 1) {
        const r = await api.post('/bk/vendors/scan-w9-tax')
        const d = r.data?.data || {}
        setScanned((n) => n + (d.scanned || 0))
        setRemaining(d.remaining ?? 0)
        if (!d.remaining) break
        // Nothing scanned but work remaining means every form in that batch
        // failed to read. Stamped as attempted server-side, so the loop would
        // still terminate — but there is no point hammering it.
        if (!d.scanned) break
      }
      toast('W-9s read — reloading the run')
      await load(year)
    } catch (err) {
      toast.error('Scan stopped: ' + (err.response?.data?.error || err.message))
    } finally { setScanning(false) }
  }

  const download = (includeTin) => {
    const q = new URLSearchParams({ year: String(year), token: localStorage.getItem('token') || '' })
    if (includeTin) q.set('include_tin', '1')
    window.open(`/api/bk/1099/export?${q}`, '_blank', 'noopener,noreferrer')
  }

  const buckets = useMemo(() => {
    const all = data || []
    const over = all.filter((v) => v.needs_1099)
    return {
      reportable: over.filter((v) => !v.exempt),
      excluded: over.filter((v) => v.exempt),
      // Everything a filing needs and does not have. A vendor can be in both
      // this and Reportable: it is the same row, seen as a problem.
      chase: over.filter((v) => !v.exempt && (!v.has_tin || !v.address || !v.w9_on_file || !v.entity_type_known)),
      under: all.filter((v) => !v.needs_1099),
    }
  }, [data])

  const Stat = ({ label, value, sub, tone }) => (
    <div className="card p-4">
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`mt-1 text-[22px] font-black tabular-nums ${tone || 'text-ink'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-400">{sub}</div>}
    </div>
  )

  const years = [thisYear, thisYear - 1, thisYear - 2]

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 data-tour="tax-header" className="text-[22px] font-black text-ink flex items-center gap-2">
            <FileText size={20} className="text-gray-400" /> 1099 Filing
          </h1>
          <p className="mt-1 text-[12.5px] text-gray-500 max-w-[760px]">
            Cash basis — payments that actually left in the calendar year, by payment date. Vendors
            filed under several spellings are one recipient. Foreign currency converts at the rate
            locked on the payment day.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select data-tour="tax-year" value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="border border-rule rounded-lg px-3 py-2 text-[13px] font-bold bg-card text-ink">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={scanW9s} disabled={scanning}
            title="Read the TIN and the tax classification off every W-9 on file that has not been read yet"
            className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-3 py-2 text-[12.5px] font-bold text-ink hover:border-gray-300 disabled:opacity-40">
            {scanning ? <Loader size={13} className="animate-spin" /> : <ScanLine size={13} />}
            {scanning ? `Reading W-9s… ${scanned} done${remaining ? `, ${remaining} left` : ''}` : 'Read the W-9s'}
          </button>
          <button onClick={() => download(false)}
            className="inline-flex items-center gap-1.5 bg-ink text-card rounded-lg px-3 py-2 text-[12.5px] font-bold">
            <Download size={13} /> Download workbook
          </button>
          {canSeeFullTin && (
            <button data-tour="tax-download"
              onClick={() => {
                if (!window.confirm(
                  'Download with FULL taxpayer ID numbers?\n\n'
                  + 'The file will contain unmasked SSNs and EINs. It is logged as a deliberate '
                  + 'export, and it is what a filing service needs — treat the file accordingly.')) return
                download(true)
              }}
              title="Unmasked TINs. Admin only, and the download is recorded in the audit log."
              className="inline-flex items-center gap-1.5 border border-rule rounded-lg px-3 py-2 text-[12.5px] font-bold text-gray-500 hover:text-ink">
              <Lock size={13} /> …with full TINs
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 card p-4 text-[13px] text-rose-600 flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {previewW9 && (
        <FilePreview
          url={previewW9.url}
          filename={previewW9.filename}
          onClose={() => setPreviewW9(null)}
        />
      )}

      {loading ? (
        <div className="mt-8 text-center text-gray-400 text-[13px]">
          <Loader size={18} className="animate-spin mx-auto mb-2" /> Working out the year…
        </div>
      ) : !meta ? null : (
        <>
          <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            <Stat label="Gets a form" value={meta.reportable_count}
              sub={`${usd(meta.reportable_total)} · threshold ${usd(meta.threshold)}`} />
            <Stat label="Cannot file yet" value={meta.unfilable_count}
              sub={usd(meta.unfilable_total)}
              tone={meta.unfilable_count ? 'text-rose-600' : 'text-emerald-600'} />
            <Stat label="No W-9 on file" value={meta.missing_w9}
              tone={meta.missing_w9 ? 'text-amber-600' : 'text-emerald-600'} />
            <Stat label="W-9 never read" value={meta.needs_entity_review}
              sub={meta.needs_entity_review ? 'press “Read the W-9s”' : 'every form has been read'}
              tone={meta.needs_entity_review ? 'text-amber-600' : 'text-emerald-600'} />
            <Stat label="Excluded by their W-9" value={meta.exempt_count} sub={usd(meta.exempt_total)} />
          </div>

          <p className="mt-3 text-[11.5px] text-gray-400 max-w-[900px]">
            {meta.threshold_note} {meta.exempt_note}
          </p>

          <div data-tour="tax-buckets" className="mt-5 flex items-center gap-1 border-b border-divider">
            {[
              ['reportable', `Reportable (${buckets.reportable.length})`],
              ['chase', `Needs attention (${buckets.chase.length})`],
              ['excluded', `Excluded (${buckets.excluded.length})`],
              ['under', `Under the threshold (${buckets.under.length})`],
            ].map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-2 text-[12.5px] font-bold border-b-2 -mb-px ${tab === k
                  ? 'border-ink text-ink' : 'border-transparent text-gray-400 hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 card overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-divider text-left">
                  {['Recipient', 'Paid this year', 'TIN', 'Tax classification', 'W-9', 'Address',
                    tab === 'excluded' ? 'Why it is out' : 'What is missing'].map((h) => (
                    <th key={h} className="px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-gray-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets[tab].map((v) => {
                  // An EIN or an SSN both clear "TIN" — they are the same
                  // field, and `has_tin` is true once either is stored.
                  //
                  // The one case that would otherwise read as a contradiction:
                  // a number was READ off the form but could not be stored
                  // (no encryption key), so the TIN column shows ••1234 while
                  // the row still cannot be filed. Saying "TIN" there looks
                  // like the column is ignoring the number next to it, so it
                  // says what is actually wrong instead. Zero rows are in that
                  // state today; it is one env var away from being all of them.
                  const missing = [
                    v.w9_on_file ? null : 'W-9',
                    v.has_tin ? null : (v.tin_last4 ? 'TIN read but not stored' : 'TIN'),
                    v.address ? null : 'address',
                    v.entity_type_known ? null : 'line 3',
                  ].filter(Boolean)
                  return (
                    <tr key={v.payee} className="border-b border-divider last:border-0">
                      <td className="px-3 py-2 font-bold text-ink">
                        <Link to={`/bk/vendors/${encodeURIComponent(v.payee)}`} className="hover:underline">
                          {v.payee}
                        </Link>
                        {v.vendor_email && (
                          <span className="ml-2 text-[11px] text-gray-400 font-normal">{v.vendor_email}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums font-bold text-ink whitespace-nowrap">{usd(v.total)}</td>
                      <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                        {v.tin_last4
                          ? <span className="text-gray-600">•••••{v.tin_last4}{v.tin_type ? ` ${v.tin_type}` : ''}</span>
                          : <span className="text-rose-600 font-bold">none</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{v.tax_classification || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {/* The document itself, not just a tick. Reading a W-9
                            is what settles the two questions this page cannot
                            answer for you — is that TIN right, and is line 3
                            what we recorded — so it opens here rather than
                            sending you to the vendor page to find it. */}
                        {v.w9_entry_id ? (
                          <button
                            onClick={() => setPreviewW9({
                              url: `/api/bk/entries/${v.w9_entry_id}/file/w9?token=${localStorage.getItem('token')}`,
                              filename: v.w9_filename || `W9-${v.payee}`,
                              payee: v.payee,
                            })}
                            title={v.w9_filename ? `Open ${v.w9_filename}` : 'Open the W-9 on file'}
                            className="inline-flex items-center gap-1 text-[11.5px] font-bold text-emerald-600 hover:underline">
                            <CheckCircle2 size={13} /> View
                          </button>
                        ) : v.w9_on_file
                          // On file, but the entry holding it could not be
                          // resolved — worth showing as present rather than
                          // claiming they never sent one.
                          ? <CheckCircle2 size={14} className="text-emerald-500" title="On file" />
                          : <span className="text-[11px] font-bold text-rose-600">NO</span>}
                      </td>
                      <td className="px-3 py-2 max-w-[260px] truncate text-gray-500" title={v.address || ''}>
                        {v.address || <span className="text-rose-600 font-bold text-[11px]">none</span>}
                      </td>
                      <td className="px-3 py-2 text-[11.5px]">
                        {tab === 'excluded'
                          ? <span className="text-gray-500">{v.exempt_reason}</span>
                          : v.exempt_code === 'corp_but_reportable'
                            ? <span className="text-amber-600" title={v.exempt_reason}>corporation, still reportable</span>
                            : missing.length
                              ? <span className="text-rose-600 font-semibold">{missing.join(', ')}</span>
                              : <span className="text-emerald-600 font-semibold">ready</span>}
                      </td>
                    </tr>
                  )
                })}
                {!buckets[tab].length && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-[12.5px] text-gray-400">
                    {tab === 'chase' ? 'Nothing is missing — every reportable vendor has what a filing needs.'
                      : tab === 'excluded' ? 'No vendor is excluded by their W-9 this year.'
                        : 'Nothing here.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {tab === 'chase' && buckets.chase.length > 0 && (
            <div className="mt-3 card p-4 text-[12.5px] text-gray-500 flex items-start gap-2">
              <Mail size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <span>
                These are the emails to send before filing. A vendor with a W-9 on file but no TIN
                means the form is on file and could not be read — worth opening it yourself; the
                <strong className="text-ink"> Vendors</strong> page has the document.
              </span>
            </div>
          )}

          <div className="mt-4 text-[11px] text-gray-400 flex items-start gap-2">
            <Ban size={13} className="mt-0.5 shrink-0" />
            <span>Excluded from every figure on this page: {(meta.excludes || []).join(' · ')}.</span>
          </div>
        </>
      )}
    </div>
  )
}
