// Which roster row does this artist NAME mean? For pages keyed by name — the
// budget sheet, Recoupments, Campaigns — so their breadcrumb can link back to
// the profile. Resolved through GET /artists/resolve, which folds spellings
// the way every money surface does (artistBucketKey), and cached per name for
// the session: a breadcrumb is rendered on every visit and the roster changes
// rarely. Returns null while resolving or when the name is not on the roster;
// the caller then renders the name as plain text.
import { useEffect, useState } from 'react'
import api from '../api'

const cache = new Map()

export default function useArtistLink(name) {
  const key = String(name || '').trim()
  const [hit, setHit] = useState(() => (key && cache.has(key) ? cache.get(key) : null))
  useEffect(() => {
    if (!key) { setHit(null); return undefined }
    if (cache.has(key)) { setHit(cache.get(key)); return undefined }
    let alive = true
    api.get('/artists/resolve', { params: { name: key } })
      .then((r) => {
        // Only a roster row counts — an empty list or a bare success is no link.
        const d = r.data?.data; const row = d && !Array.isArray(d) && d.id ? d : null
        cache.set(key, row); if (alive) setHit(row)
      })
      .catch(() => { cache.set(key, null); if (alive) setHit(null) })
    return () => { alive = false }
  }, [key])
  return hit
}
