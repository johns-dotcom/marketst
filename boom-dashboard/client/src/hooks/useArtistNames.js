import { useEffect, useState } from 'react'
import api from '../api'

// Every name an artist picker should offer: the signed roster UNION the names
// already in the ledger.
//
// `/artists` alone is the ROSTER — 50 names — while `expenses.artist` is free
// text holding ~107, so the artists with spend that the roster has never heard
// of could not be picked at all and had to be retyped. That is precisely how a
// fourth spelling of an existing artist gets created, which is the thing every
// artist control in this app exists to stop. See the header of
// `GET /bk/artist-names` for the measurement.
//
// Four pages already do this fetch inline (BkBankMatching, Reports,
// ArtistCampaigns, BkVendors). This hook exists because the approval checklist
// is the FIFTH caller and is a shared component with two hosts — writing it
// there would have been the fifth and sixth copies. Converting the four is a
// separate change: they each hold the list in their own state and hand it to
// several controls, and moving them buys nothing a user can see.
//
// ── Fetched ONCE per session, not once per mount ──
// The approval deck mounts every time somebody opens it and Add Invoice mounts
// on every visit. The list changes when an artist is signed or a new spelling
// reaches the ledger — neither of which happens inside a review session — so a
// module-level cache is the right lifetime, and `inFlight` means two components
// mounting in the same tick make one request rather than two.
let cache = null
let inFlight = null

function load() {
  if (cache) return Promise.resolve(cache)
  if (inFlight) return inFlight
  inFlight = api.get('/bk/artist-names')
    .then((r) => {
      const l = r.data?.data?.names
      if (!Array.isArray(l)) throw new Error('unexpected shape')
      return l
    })
    // The roster alone is a worse list, but it IS a list — better than a picker
    // with nothing in it. Same fallback the four pages use.
    .catch(() => api.get('/artists').then((r) => {
      const l = r.data?.data ?? r.data ?? []
      return Array.isArray(l) ? l.map((a) => a.name).filter(Boolean) : []
    }))
    // A failed fetch must not poison the cache, or one blip costs the picker
    // for the whole session. It returns [], and ArtistSelect degrades to what
    // the field was before this existed: a box you type a name into.
    .then((l) => { if (l.length) cache = l; return l })
    .catch(() => [])
    .finally(() => { inFlight = null })
  return inFlight
}

export default function useArtistNames() {
  const [names, setNames] = useState(cache || [])
  useEffect(() => {
    if (cache) return
    let alive = true
    load().then((l) => { if (alive) setNames(l) })
    return () => { alive = false }
  }, [])
  return names
}
