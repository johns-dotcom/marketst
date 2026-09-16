// Archive view for rejected + soft-deleted invoices. Reached via the
// "View archive" link on the Approvals page header. Read-only for
// rejected rows (they can only be un-rejected by editing status to
// approved from the ledger); Deleted rows expose a Restore action.
//
// Both categories persist in Postgres — nothing is ever hard-deleted
// through the UI. This page just exposes them so operators can:
//   • recover a mis-deleted invoice
//   • re-read a rejection reason
//   • audit what got rejected / deleted and by whom

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Search, XCircle, Trash2, Undo2, Loader, ChevronDown, ChevronRight, FileText, ShieldAlert } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import FilePreview from '../components/FilePreview'
import { useAuth } from '../context/AuthContext'
import { formatDate, fmtMoney } from '../utils'

// Admin-only (Admin / Superadmin): archived rows carry rejection reasons
// and deleted financial history. This client gate pairs with the
// server-side gate on GET /bk/entries?deleted=true.

// One chip per attached document — opens in the shared FilePreview
// overlay. W9 follows the cross-entry rule (w9_entry_id || id).
function FileChip({ label, entryId, filename, type, onPreview }) {
  const url = `/api/bk/entries/${entryId}/file/${type}?token=${localStorage.getItem('token')}`
  return (
    <button
      onClick={() => onPreview({ url, filename: filename || `${label}-${entryId}` })}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 ring-1 ring-blue-200/60 hover:bg-blue-100"
      title={`View ${label.toLowerCase()}${filename ? ` — ${filename}` : ''}`}
    >
      <FileText size={9} /> {label}
    </button>
  )
}

function InvoiceRow({ row, kind, onRestore, restoring, onPreview }) {
  const currency = row.currency || 'USD'
  return (
    <tr className="border-t border-divider text-xs hover:bg-gray-50/60">
      <td className="px-3 py-2 text-gray-500 whitespace-nowrap tabular-nums">
        {formatDate(row.invoice_date)}
      </td>
      <td className="px-3 py-2 font-semibold text-gray-900 truncate max-w-[220px]" title={row.payee}>
        {row.payee || '—'}
        {row.invoice_number && (
          <span className="ml-1 text-[10px] text-gray-400">#{row.invoice_number}</span>
        )}
      </td>
      <td className="px-3 py-2 text-gray-700 truncate max-w-[160px]" title={row.artist}>
        {row.artist || <span className="text-gray-300">—</span>}
      </td>
      <td className="px-3 py-2 text-gray-700 truncate max-w-[200px]" title={row.song}>
        {row.song || <span className="text-gray-300">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-bold tabular-nums text-gray-900 whitespace-nowrap">
        {fmtMoney(row.amount, currency)}
      </td>
      <td className="px-3 py-2 text-gray-500 truncate max-w-[300px]">
        {kind === 'rejected' ? (
          <span title={row.reject_reason || ''}>
            {row.rejected_by_name && <span className="font-semibold text-gray-700">{row.rejected_by_name}</span>}
            {row.rejected_at && <span className="text-gray-400 ml-1">· {formatDate(row.rejected_at)}</span>}
            {row.reject_reason && <span className="ml-2 italic text-gray-500">— {row.reject_reason}</span>}
            {!row.rejected_by_name && !row.rejected_at && !row.reject_reason && <span className="text-gray-300">—</span>}
          </span>
        ) : (
          <span title={row.deleted_by || ''}>
            {row.deleted_by && <span className="font-semibold text-gray-700">{row.deleted_by}</span>}
            {row.deleted_at && <span className="text-gray-400 ml-1">· {formatDate(row.deleted_at)}</span>}
            {!row.deleted_by && !row.deleted_at && <span className="text-gray-300">—</span>}
          </span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          {row.has_invoice && (
            <FileChip label="Invoice" entryId={row.id} type="invoice" filename={row.invoice_filename} onPreview={onPreview} />
          )}
          {(row.has_w9 || row.w9_entry_id) && (
            <FileChip label="W9" entryId={row.w9_entry_id || row.id} type="w9" filename={row.w9_filename} onPreview={onPreview} />
          )}
          {row.has_proof && (
            <FileChip label="Proof" entryId={row.id} type="proof" filename={row.proof_filename} onPreview={onPreview} />
          )}
          {row.receipt_filename && (
            <FileChip label="Receipt" entryId={row.id} type="receipt" filename={row.receipt_filename} onPreview={onPreview} />
          )}
          {!row.has_invoice && !row.has_w9 && !row.w9_entry_id && !row.has_proof && !row.receipt_filename && (
            <span className="text-gray-300 text-[10px]">—</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {/* Both kinds restore, but to different places, so the labels differ. A
            deleted invoice returns to the ledger as it was; a rejected one goes
            back to Pending for an approver to decide again — a rejection was a
            decision, and undoing it should restore the question, not answer it
            the other way. */}
        <button
          onClick={() => onRestore(row.id)}
          disabled={restoring}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          title={kind === 'rejected'
            ? 'Send this back to Approvals as Pending — the rejection reason is kept in the history'
            : 'Restore this invoice back to the ledger'}
        >
          {restoring ? <Loader size={11} className="animate-spin" /> : <Undo2 size={11} />}
          {kind === 'rejected' ? 'Back to Pending' : 'Restore'}
        </button>
      </td>
    </tr>
  )
}

function ArchiveSection({ title, subtitle, icon: Icon, iconClass, rows, loading, kind, search, onRestore, restoringId, onPreview }) {
  const [collapsed, setCollapsed] = useState(false)
  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      const hay = [r.payee, r.artist, r.song, r.invoice_number, r.description, r.reject_reason, r.rejected_by_name, r.deleted_by]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [rows, search])

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-gray-50/60 transition-colors"
      >
        {collapsed
          ? <ChevronRight size={14} className="text-gray-400" />
          : <ChevronDown size={14} className="text-gray-400" />}
        <Icon size={16} className={iconClass} />
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-gray-900">{title}</h2>
            <span className="text-[10px] font-bold text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
              {loading ? '…' : (search.trim() ? `${filtered.length}/${rows.length}` : rows.length)}
            </span>
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
      </button>
      {!collapsed && (
        <div className="border-t border-divider">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-xs text-gray-500 py-8">
              <Loader size={13} className="animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">
              {search.trim() ? `Nothing matches "${search.trim()}".` : `Nothing ${kind} yet.`}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="bg-gray-50/60 text-[10px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-bold">Date</th>
                    <th className="px-3 py-2 text-left font-bold">Payee</th>
                    <th className="px-3 py-2 text-left font-bold">Artist</th>
                    <th className="px-3 py-2 text-left font-bold">Song</th>
                    <th className="px-3 py-2 text-right font-bold">Amount</th>
                    <th className="px-3 py-2 text-left font-bold">{kind === 'rejected' ? 'Rejection' : 'Deletion'}</th>
                    <th className="px-3 py-2 text-left font-bold">Files</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(row => (
                    <InvoiceRow
                      key={row.id}
                      row={row}
                      kind={kind}
                      onRestore={onRestore}
                      restoring={restoringId === row.id}
                      onPreview={onPreview}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function BkArchive() {
  const { user } = useAuth()
  const isAdmin = ['Admin', 'Superadmin'].includes(user?.role)
  const [rejected, setRejected] = useState([])
  const [rejectedLoading, setRejectedLoading] = useState(true)
  const [deleted, setDeleted] = useState([])
  const [deletedLoading, setDeletedLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [restoringId, setRestoringId] = useState(null)
  const [error, setError] = useState('')
  const [previewFile, setPreviewFile] = useState(null)

  const fetchRejected = async () => {
    setRejectedLoading(true)
    try {
      const res = await api.get('/bk/invoices?status=rejected')
      setRejected(res.data?.data || [])
    } catch (err) {
      console.warn('Failed to load rejected:', err.message)
      setRejected([])
    } finally { setRejectedLoading(false) }
  }
  const fetchDeleted = async () => {
    setDeletedLoading(true)
    try {
      // /bk/entries?deleted=true returns soft-deleted rows. Include
      // status=all so a row that was Pending when deleted still shows.
      const res = await api.get('/bk/entries?status=all&deleted=true')
      setDeleted(res.data?.data || [])
    } catch (err) {
      console.warn('Failed to load deleted:', err.message)
      setDeleted([])
    } finally { setDeletedLoading(false) }
  }

  useEffect(() => {
    if (!isAdmin) { setRejectedLoading(false); setDeletedLoading(false); return }
    fetchRejected(); fetchDeleted()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  const handleRestore = async (id) => {
    setRestoringId(id)
    setError('')
    try {
      await api.post(`/bk/entries/${id}/restore`)
      // Optimistic: strip from the deleted list.
      setDeleted(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      setError(`Couldn't restore: ${err?.response?.data?.error || err.message}`)
    } finally {
      setRestoringId(null)
    }
  }

  // A rejected invoice goes back to Pending, not straight to Approved — see the
  // note on the button. Separate handler from handleRestore because it hits a
  // different endpoint and removes the row from a different list.
  const [restoredNote, setRestoredNote] = useState('')
  const handleUnreject = async (id) => {
    setRestoringId(id)
    setError('')
    try {
      const res = await api.post(`/bk/entries/${id}/unreject`)
      const kids = res.data?.data?.children_restored || 0
      setRejected(prev => prev.filter(r => r.id !== id))
      setRestoredNote(kids > 0
        ? `Sent back to Approvals as Pending, with ${kids} split ${kids === 1 ? 'row' : 'rows'}.`
        : 'Sent back to Approvals as Pending.')
    } catch (err) {
      setError(`Couldn't restore: ${err?.response?.data?.error || err.message}`)
    } finally {
      setRestoringId(null)
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-5">
        <Link
          to="/bk/approvals"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-white border border-rule hover:border-gray-300"
        >
          <ArrowLeft size={13} /> Back to Approvals
        </Link>
        <div className="card p-12 text-center">
          <ShieldAlert size={26} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm font-bold text-gray-700">Admins only</p>
          <p className="text-xs text-gray-400 mt-1">
            The archive holds rejected and deleted financial records — ask an admin if you need something restored.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <Link
        to="/bk/approvals"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-white border border-rule hover:border-gray-300"
      >
        <ArrowLeft size={13} /> Back to Approvals
      </Link>
      <PageHeader
        title="Archived Invoices"
        subtitle="Rejected and soft-deleted invoices — kept indefinitely for reference and recoverable when needed."
      />
      <div className="relative max-w-md">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search payee / artist / song / reason…"
          className="pl-7 pr-2 py-1.5 text-xs rounded-md border border-rule bg-card focus:outline-none focus:ring-1 focus:ring-boom-500 w-full"
        />
      </div>
      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      {/* Where it went. The row vanishes from this page on success, so without
          this it isn't obvious anything happened — or where to go next. */}
      {restoredNote && (
        <div className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
          <Undo2 size={13} className="shrink-0 text-emerald-600" />
          <span className="flex-1">{restoredNote}</span>
          <Link to="/bk/approvals" className="font-bold text-emerald-800 hover:text-emerald-900 whitespace-nowrap">
            Go to Approvals →
          </Link>
        </div>
      )}
      <ArchiveSection
        title="Rejected invoices"
        subtitle="Vendor submissions that an admin rejected on the Approvals page. Restoring one sends it back to Approvals as Pending; the rejection reason is kept in its history."
        icon={XCircle}
        iconClass="text-rose-500"
        rows={rejected}
        loading={rejectedLoading}
        kind="rejected"
        search={search}
        onRestore={handleUnreject}
        restoringId={restoringId}
        onPreview={setPreviewFile}
      />
      <ArchiveSection
        title="Deleted invoices"
        subtitle="Soft-deleted invoices. Restore to bring them back to the ledger in their original state."
        icon={Trash2}
        iconClass="text-gray-500"
        rows={deleted}
        loading={deletedLoading}
        kind="deleted"
        search={search}
        onRestore={handleRestore}
        restoringId={restoringId}
        onPreview={setPreviewFile}
      />
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
