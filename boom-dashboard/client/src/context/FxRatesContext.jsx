// FX rates context. Single fetch at app mount; all currency-aware pages
// pull from this so we don't hit /api/fx/rates per-page or per-render.
//
// Usage:
//     const { rates, fetchedAt } = useFxRates()
//     <span>{fmtMoney(amt, cur)}{usdSuffix(amt, cur, rates)}</span>
//
// The provider keeps a fallback rate table on hand so any page that
// renders before the fetch resolves still gets approximate USD numbers
// (replaced once the server responds with live ECB data).
import { createContext, useContext, useState, useEffect } from 'react'
import api from '../api'

const FALLBACK_RATES = {
  USD: 1,
  EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.51, MXN: 17.2,
  JPY: 156, BRL: 5.6, CHF: 0.91, SEK: 10.7, NOK: 10.8, DKK: 6.86,
}

const FxRatesContext = createContext({
  rates: { ...FALLBACK_RATES },
  fetchedAt: null,
  source: 'fallback',
})

export function FxRatesProvider({ children }) {
  const [state, setState] = useState({
    rates: { ...FALLBACK_RATES },
    fetchedAt: null,
    source: 'fallback',
  })

  useEffect(() => {
    let cancelled = false
    api.get('/fx/rates')
      .then(r => {
        if (cancelled) return
        const data = r.data?.data
        if (data?.rates) setState(data)
      })
      .catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [])

  return <FxRatesContext.Provider value={state}>{children}</FxRatesContext.Provider>
}

export function useFxRates() {
  return useContext(FxRatesContext)
}
