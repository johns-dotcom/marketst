// Market Street Reps registry — pulled from /api/reps once on app mount + on tab
// focus. Replaces the static BOOM_REPS constant from src/constants.js so
// admins can add or deactivate reps via Settings without a code deploy.
//
// The constant is kept as a last-resort fallback in case the fetch fails
// before the user interacts with a rep dropdown — better to show the
// historical seven than an empty list.
//
// VendorSubmit is unauth but the /api/reps endpoint is deliberately public,
// so it gets the same provider data path. The fetch isn't gated on having
// a user logged in.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import api from '../api'
import { BOOM_REPS as FALLBACK_REPS } from '../constants'

const BoomRepsContext = createContext({
  reps: FALLBACK_REPS,
  loading: true,
  refresh: () => {},
})

export function BoomRepsProvider({ children }) {
  const [reps, setReps] = useState(FALLBACK_REPS)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/reps')
      const list = Array.isArray(res.data?.data) ? res.data.data : null
      // Only overwrite when the fetch succeeded with a real array;
      // network blips shouldn't blank the dropdowns.
      if (list && list.length) setReps(list)
    } catch (err) {
      console.warn('Failed to fetch boom reps:', err?.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Refetch on tab focus so admins adding a rep on one tab see it on
    // another without a hard refresh. Throttled by the API itself —
    // /api/reps is cheap (small table, no joins).
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return (
    <BoomRepsContext.Provider value={{ reps, loading, refresh }}>
      {children}
    </BoomRepsContext.Provider>
  )
}

// Returns the active rep names array. Always returns something (the
// fallback constant if the fetch hasn't completed or failed) so callers
// can render unconditionally.
export function useBoomReps() {
  return useContext(BoomRepsContext).reps
}

// For callers that need the loading state or manual refresh (Settings UI
// after add/toggle).
export function useBoomRepsContext() {
  return useContext(BoomRepsContext)
}
