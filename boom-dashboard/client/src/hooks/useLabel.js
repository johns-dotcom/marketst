// The label's own details (Settings › Label), masked, cached for the session.
// Returns null until loaded. `refreshLabel()` re-reads after a save.
import { useEffect, useState } from 'react'
import api from '../api'

let cache = null
let inflight = null
const listeners = new Set()
export function refreshLabel() {
  inflight = api.get('/label').then((r) => { cache = r.data?.data || null; listeners.forEach((fn) => fn(cache)); return cache }).catch(() => cache).finally(() => { inflight = null })
  return inflight
}
export default function useLabel() {
  const [label, setLabel] = useState(cache)
  useEffect(() => {
    listeners.add(setLabel)
    if (!cache && !inflight) refreshLabel()
    else if (cache) setLabel(cache)
    return () => { listeners.delete(setLabel) }
  }, [])
  return label
}
// Address lines as the documents print them.
export const labelAddressLines = (l) => [l?.legal_name || l?.display_name, l?.address_line1, l?.address_line2].filter(Boolean)
