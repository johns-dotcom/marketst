import { useState, useEffect } from 'react'

/**
 * Fetch a protected file and hand back a blob URL you can put in an iframe or img.
 *
 * The document endpoints need an Authorization header (or a ?token=), so a file
 * cannot simply be an <iframe src>. It has to be fetched and turned into a blob
 * URL first. That logic lived inside FilePreview; it now lives here because a
 * second viewer needs it, and two copies of fetch-and-blob WILL drift — the same
 * duplicated-rule failure that produced four ad-hoc alias resolvers and a
 * pairing rule one module knew nothing about.
 *
 * ── Two things the original was missing ──────────────────────────────────────
 *
 * ABORT + LAST-WRITE-WINS. FilePreview fired a fetch per url with no
 * AbortController and no check that the response still belonged to the url being
 * asked about. In a modal you open deliberately that is invisible: one file, one
 * request. In a review deck that auto-loads as you flip cards it is the normal
 * case — hold the arrow key and a slow response for card 40 can land after card
 * 43's, leaving the WRONG INVOICE on screen next to the row you are about to
 * approve. Same class as every silent-false-record bug in this app, so the guard
 * is not optional: the effect aborts on change, and a resolved fetch that is no
 * longer current is dropped even if the abort lost the race.
 *
 * REVOCATION. The old cleanup read `blobUrl` from the closure while `blobUrl` was
 * not in the dependency array, so it revoked whatever the value had been when the
 * effect ran — i.e. the PREVIOUS blob or null — and leaked the one it had just
 * created. Fourteen pages use this. Here the URL is held in the effect's own
 * scope, so cleanup revokes exactly what that run made.
 *
 * @param {string|null} url  the file endpoint, or null/undefined to fetch nothing
 * @returns {{loading: boolean, blobUrl: string|null, mimeType: string|null, error: string|null}}
 */
export default function useFileBlob(url) {
  const [state, setState] = useState({ loading: !!url, blobUrl: null, mimeType: null, error: null })

  useEffect(() => {
    if (!url) {
      setState({ loading: false, blobUrl: null, mimeType: null, error: null })
      return undefined
    }
    let cancelled = false
    let created = null
    const ctl = new AbortController()
    setState({ loading: true, blobUrl: null, mimeType: null, error: null })

    fetch(url, { signal: ctl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load file')
        const ct = res.headers.get('content-type') || ''
        return res.blob().then((blob) => ({ blob, ct }))
      })
      .then(({ blob, ct }) => {
        // The abort should have prevented this, but a fetch that has already
        // resolved cannot be called back — so the flag is what actually
        // guarantees a superseded response never reaches the screen.
        if (cancelled) return
        created = URL.createObjectURL(blob)
        setState({ loading: false, blobUrl: created, mimeType: ct, error: null })
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return
        setState({ loading: false, blobUrl: null, mimeType: null, error: err.message })
      })

    return () => {
      cancelled = true
      ctl.abort()
      // `created` is this run's own blob, not a value read out of a stale render.
      if (created) URL.revokeObjectURL(created)
    }
  }, [url])

  return state
}

// What the blob can be shown as. Both viewers ask the same question, so they ask
// it in one place rather than each re-deriving "is this a PDF".
export const isPdfMime = (m) => !!m && m.includes('pdf')
export const isImageMime = (m) => !!m && (m.startsWith('image/') || m.includes('image'))
