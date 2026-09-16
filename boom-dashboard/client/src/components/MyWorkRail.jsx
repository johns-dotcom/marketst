import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Flag, AtSign, Inbox, CalendarClock, Package, ChevronRight } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

// "Waiting on you" rail for the My Work page — aggregates the cross-app
// work that isn't a self-authored task: review items assigned to you,
// unread @mentions, the Approvals queue (bookkeeping-admin tier), the
// monthly statement cutoff, and stalled bulk deals. Everything deep
// links to its page. Sections with nothing to show hide themselves;
// the whole rail collapses to a slim all-clear card when empty.
export default function MyWorkRail() {
  const { user } = useAuth()
  const isBkAdmin = ['Admin', 'Superadmin', 'Approver'].includes(user?.role)
  const [reviews, setReviews] = useState([])     // items assigned to me
  const [mentions, setMentions] = useState([])
  const [stalled, setStalled] = useState([])
  const [pendingCount, setPendingCount] = useState(null)

  useEffect(() => {
    api.get('/artist-campaigns/review-feed')
      .then(r => {
        const d = r.data?.data || {}
        const assignments = d.assignments || {}
        const byId = new Map()
        for (const f of d.flags || []) byId.set(f.id, { ...f, kind: 'flag' })
        for (const c of d.comments || []) if (!byId.has(c.id)) byId.set(c.id, { ...c, kind: 'comment' })
        const mine = [...byId.values()].filter(it =>
          (assignments[it.id] || []).some(a => a.user_id === user?.id))
        setReviews(mine)
      })
      .catch(() => {})
    api.get('/notifications')
      .then(r => {
        const d = r.data?.data || {}
        setMentions(d.mentions || [])
        setStalled((d.smart_alerts || []).filter(a => a.type === 'bulk_deal_stalled'))
      })
      .catch(() => {})
    if (isBkAdmin) {
      api.get('/bk/pending-count')
        .then(r => setPendingCount(r.data?.data?.count ?? r.data?.count ?? null))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Statement cutoff — recoupment statements go out on the 20th; show a
  // countdown while it's a week or less away.
  const cutoff = useMemo(() => {
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth(), 20)
    if (now.getDate() > 20) target.setMonth(target.getMonth() + 1)
    const days = Math.ceil((target - now) / 86400000)
    return { days, show: days <= 7 }
  }, [])

  const fmt = (v, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(Number(v) || 0)
  const hasAnything = reviews.length || mentions.length || stalled.length || (pendingCount || 0) > 0 || cutoff.show

  // Compact strip card for the mobile layout — one small tappable tile
  // per section, laid out in a horizontal scroll row.
  const StripCard = ({ to, icon: Icon, iconClass, label, count }) => (
    <Link
      to={to}
      className="shrink-0 card px-3 py-2.5 flex items-center gap-2 min-w-[150px] hover:shadow-sm"
    >
      <Icon size={14} className={iconClass} />
      <span className="text-xs font-bold text-gray-800 leading-tight">{label}</span>
      {count != null && (
        <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-gray-100 text-gray-700 text-[10px] font-bold">{count}</span>
      )}
    </Link>
  )

  // Mobile (<lg): a horizontal strip that sits ABOVE the task column —
  // costs one row of vertical space instead of a full sidebar's worth.
  // Hidden entirely when there's nothing waiting. Desktop keeps the
  // vertical rail below. Both render from the same fetched state.
  const mobileStrip = (
    <div className="lg:hidden">
      {hasAnything ? (
        <>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1 mb-2">Waiting on you</h2>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" style={{ WebkitOverflowScrolling: 'touch' }}>
            {reviews.length > 0 && (
              <StripCard to="/artist-campaigns" icon={Flag} iconClass="text-amber-600" label="Reviews" count={reviews.length} />
            )}
            {mentions.length > 0 && (
              <StripCard to={mentions[0]?.room_path || '/artist-campaigns'} icon={AtSign} iconClass="text-boom-600" label="Mentions" count={mentions.length} />
            )}
            {isBkAdmin && (pendingCount || 0) > 0 && (
              <StripCard to="/bk/approvals" icon={Inbox} iconClass="text-violet-500" label="Approvals" count={pendingCount} />
            )}
            {cutoff.show && (
              <StripCard to="/recoupments/planning" icon={CalendarClock} iconClass="text-sky-500" label={cutoff.days === 0 ? 'Cutoff today' : `Cutoff in ${cutoff.days}d`} />
            )}
            {stalled.length > 0 && (
              <StripCard to="/bk/bulk-deals" icon={Package} iconClass="text-teal-600" label="Stalled deals" count={stalled.length} />
            )}
          </div>
        </>
      ) : null}
    </div>
  )

  return (
    <>
    {mobileStrip}
    <div className="hidden lg:block space-y-4">
      <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">Waiting on you</h2>

      {!hasAnything && (
        <div className="card p-5 text-center">
          <p className="text-sm text-gray-400">Nothing waiting on you across the app.</p>
        </div>
      )}

      {/* Review items assigned to me */}
      {reviews.length > 0 && (
        <div className="card overflow-hidden">
          <Link to="/artist-campaigns" className="px-4 py-2.5 flex items-center gap-2 bg-amber-50/60 border-b border-amber-100 hover:bg-amber-50">
            <Flag size={12} className="text-amber-600" />
            <span className="text-xs font-bold text-amber-800">Assigned to you for review</span>
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">{reviews.length}</span>
            <ChevronRight size={12} className="text-amber-400" />
          </Link>
          {reviews.slice(0, 5).map(it => (
            <Link
              key={it.id}
              to={`/artist-campaigns/${encodeURIComponent((it.artist || '').trim() || 'unassigned')}`}
              className="px-4 py-2 flex items-baseline gap-2 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/60"
            >
              <span className="text-xs font-bold text-gray-900 truncate max-w-[140px]">{it.payee || `#${it.id}`}</span>
              <span className="text-xs font-bold text-gray-700 tabular-nums">{fmt(it.amount, it.currency)}</span>
              <span className="text-[11px] text-gray-400 truncate">{(it.artist || '').trim()}</span>
            </Link>
          ))}
          {reviews.length > 5 && (
            <Link to="/artist-campaigns" className="block px-4 py-2 text-[11px] font-bold text-boom-600 hover:bg-gray-50/60">
              +{reviews.length - 5} more in the review inbox
            </Link>
          )}
        </div>
      )}

      {/* Unread mentions */}
      {mentions.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 flex items-center gap-2 bg-boom-50/60 border-b border-boom-100">
            <AtSign size={12} className="text-boom-600" />
            <span className="text-xs font-bold text-boom-800">Mentions</span>
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-boom-100 text-boom-800 text-[10px] font-bold">{mentions.length}</span>
          </div>
          {mentions.slice(0, 4).map(m => (
            <Link
              key={m.id}
              to={m.room_path || '/artist-campaigns'}
              className="block px-4 py-2 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/60"
            >
              <p className="text-xs font-semibold text-gray-900">{m.actor_name || 'Someone'}{m.room_title ? ` · ${m.room_title}` : ''}</p>
              <p className="text-[11px] text-gray-500 truncate">“{m.snippet}”</p>
            </Link>
          ))}
        </div>
      )}

      {/* Approvals queue — bookkeeping admins only */}
      {isBkAdmin && (pendingCount || 0) > 0 && (
        <Link to="/bk/approvals" className="card px-4 py-3 flex items-center gap-2.5 hover:border-violet-200 hover:shadow-sm transition-all">
          <Inbox size={14} className="text-violet-500" />
          <span className="text-sm font-semibold text-gray-800">
            {pendingCount} invoice{pendingCount === 1 ? '' : 's'} awaiting approval
          </span>
          <ChevronRight size={13} className="text-gray-300 ml-auto" />
        </Link>
      )}

      {/* Statement cutoff countdown */}
      {cutoff.show && (
        <Link to="/recoupments/planning" className="card px-4 py-3 flex items-center gap-2.5 hover:border-sky-200 hover:shadow-sm transition-all">
          <CalendarClock size={14} className="text-sky-500" />
          <span className="text-sm font-semibold text-gray-800">
            Statement cutoff {cutoff.days === 0 ? 'is today' : `in ${cutoff.days} day${cutoff.days === 1 ? '' : 's'}`}
            <span className="text-gray-400 font-normal"> — the 20th</span>
          </span>
          <ChevronRight size={13} className="text-gray-300 ml-auto" />
        </Link>
      )}

      {/* Stalled bulk deals */}
      {stalled.length > 0 && (
        <div className="card overflow-hidden">
          <Link to="/bk/bulk-deals" className="px-4 py-2.5 flex items-center gap-2 bg-teal-50/60 border-b border-teal-100 hover:bg-teal-50">
            <Package size={12} className="text-teal-600" />
            <span className="text-xs font-bold text-teal-800">Stalled bulk deals</span>
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-teal-100 text-teal-800 text-[10px] font-bold">{stalled.length}</span>
            <ChevronRight size={12} className="text-teal-400" />
          </Link>
          {stalled.slice(0, 3).map(a => (
            <Link key={a.id} to="/bk/bulk-deals" className="block px-4 py-2 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/60">
              <p className="text-[11px] text-gray-600 leading-snug">{a.title}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
    </>
  )
}
