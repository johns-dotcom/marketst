import { useEffect, useState } from 'react'
import api from '../api'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// "Reconciled through June 2026" — the soft-close watermark from the
// Statements page, for any page that reports money.
//
// The rule is deliberately strict: it returns the latest month such that it
// AND EVERY earlier statement-month is marked reconciled. It stops at the
// first gap rather than reporting the newest reconciled month, because a
// later month closed over an unreconciled earlier one is not a watermark you
// can trust a P&L against.
//
// Returns { label, monthKey } — both null when nothing qualifies, which is
// also what non-admins get: /statements/months is admin-gated, and the
// rejection is swallowed so the badge simply doesn't render rather than
// erroring a page that otherwise works fine without it.
export default function useReconciledThrough() {
  const [state, setState] = useState({ label: null, monthKey: null })

  useEffect(() => {
    let alive = true
    api.get('/statements/months').then((res) => {
      if (!alive) return
      const months = Array.isArray(res.data?.data) ? res.data.data : []
      if (!months.length) return
      const ascending = [...months].sort((a, b) => a.month_key.localeCompare(b.month_key))
      let last = null
      for (const m of ascending) {
        if (m.reconciled_at) last = m.month_key
        else break // first gap wins — see above
      }
      if (!last) return
      const [y, mo] = last.split('-')
      setState({ label: `${MONTH_NAMES[Number(mo) - 1]} ${y}`, monthKey: last })
    }).catch(() => { /* non-admin or statements unavailable — no badge */ })
    return () => { alive = false }
  }, [])

  return state
}
