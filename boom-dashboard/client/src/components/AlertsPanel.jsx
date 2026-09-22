// The CEO's alerts on Home (2026-09-22): no release in 2+ months, an option or
// contract period ending soon, deliverables still owed, an advance triggered.
// GET /dashboard/alerts (gated per page on the server); renders nothing when
// there is nothing, never a bare zero.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Music, FileSignature, ListChecks, Banknote, ChevronRight } from 'lucide-react'
import api from '../api'

const ICON = { release_gap: Music, option_expiring: FileSignature, deliverable_due: ListChecks, advance_triggered: Banknote }
const LABEL = { release_gap: 'No release in 2+ months', option_expiring: 'Option period ending', deliverable_due: 'Deliverables due', advance_triggered: 'Advance triggered' }
const TONE = { high: 'text-rose-600', medium: 'text-amber-600', low: 'text-gray-500' }

export default function AlertsPanel({ canView }) {
  const [alerts, setAlerts] = useState(null)
  useEffect(() => { api.get('/dashboard/alerts').then((r) => setAlerts(r.data?.data || [])).catch(() => setAlerts([])) }, [])
  if (!alerts || alerts.length === 0) return null
  const visible = alerts.filter((a) => !canView || canView(a.kind === 'advance_triggered' ? '/bk/payments' : a.kind === 'option_expiring' ? '/contracts' : '/artists'))
  if (!visible.length) return null
  const byKind = {}
  for (const a of visible) (byKind[a.kind] = byKind[a.kind] || []).push(a)
  return (
    <div className="card p-4" data-tour="home-alerts" data-home-alerts>
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={15} className="text-amber-500" />
        <p className="text-sm font-semibold text-gray-900">Alerts</p>
        <span className="text-[11px] text-gray-400">· {visible.length} on signed artists</span>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        {Object.entries(byKind).map(([kind, rows]) => {
          const Icon = ICON[kind] || AlertTriangle
          return (
            <div key={kind} data-alert-kind={kind}>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 inline-flex items-center gap-1"><Icon size={11} /> {LABEL[kind] || kind} · {rows.length}</p>
              <ul className="divide-y divide-divider border border-rule rounded-lg">
                {rows.slice(0, 5).map((a) => (
                  <li key={`${a.kind}-${a.key}`}>
                    <Link to={a.to} className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50/70" data-alert={`${a.kind}:${a.key}`}>
                      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.severity === 'high' ? 'bg-rose-500' : a.severity === 'medium' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                      <span className="min-w-0 flex-1"><span className={`block text-sm ${TONE[a.severity] || 'text-gray-800'} font-medium truncate`}>{a.title}</span>{a.detail && <span className="block text-[11px] text-gray-500 truncate">{a.detail}</span>}</span>
                      <ChevronRight size={14} className="text-gray-300 flex-shrink-0 mt-1" />
                    </Link>
                  </li>
                ))}
                {rows.length > 5 && <li className="px-3 py-1.5 text-[11px] text-gray-400">and {rows.length - 5} more on Flags</li>}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
