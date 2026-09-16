import { Link } from 'react-router-dom'
import useReconciledThrough from '../hooks/useReconciledThrough'

// The soft-close watermark, rendered wherever money is reported.
//
// Renders NOTHING when there's no qualifying month or the viewer can't see
// statements — so it's safe to drop onto any page unconditionally. That also
// means "no badge" is ambiguous by design (not reconciled vs not permitted);
// the page must still make sense without it.
//
// `linkTo` turns it into a jump to the Statements month list. Off by default
// because not every viewer of a money page can open Statements (it's
// Admin/Superadmin only) and a dead link is worse than a plain badge.
export default function ReconciledBadge({ linkTo = false, className = '' }) {
  const { label } = useReconciledThrough()
  if (!label) return null

  const cls = `inline-block text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 ${className}`
  const tip = 'Every month up to and including this one is marked reconciled on the Statements page — numbers through here are bank-verified.'
  const text = `Reconciled through ${label}`

  if (linkTo) {
    return <Link to="/bk/statements" className={`${cls} hover:bg-emerald-100`} title={tip}>{text}</Link>
  }
  return <span className={cls} title={tip}>{text}</span>
}
