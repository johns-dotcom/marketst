// A stubbed api for scripts/approval-deck-dom-entry.jsx.
//
// PUT /bk/entries/:id echoes back the row the way the real route does — it
// RETURNS the updated entry, and the deck reads social_handles off that answer
// rather than trusting its own draft. A stub that returned nothing would let a
// card display something the database does not hold, which is the failure this
// harness is meant to catch rather than create.
export const calls = { get: [], put: [], post: [], del: [] }
const api = {
  // The artist picker's vocabulary: the signed roster UNION the names already in
  // the ledger, which is what GET /bk/artist-names returns. Shaped to carry the
  // case the checklist's old text box created — a canonical "Manila Killa" the
  // entry's own lowercase "manila killa" has to be correctable TO, plus two
  // names close enough that filtering has to do real work.
  ARTIST_NAMES: ['Ashade', 'Kaidro', 'Manila Killa', 'Manila Killa x Robokid', 'Oxis', 'nikko'],
  get: async (url) => {
    calls.get.push(String(url))
    if (/\/bk\/artist-names$/.test(String(url))) {
      return { data: { success: true, data: { names: api.ARTIST_NAMES, roster_count: 5, ledger_only_count: 1 } } }
    }
    return { data: { success: true, data: [] } }
  },
  put: async (url, body) => {
    calls.put.push({ url: String(url), body })
    // MIRRORS lib/socials.js normalizeSocialRows: trims, keeps artist/amount,
    // drops rows with no handle. A looser stub would pass a client that sends
    // the wrong shape.
    const rows = Array.isArray(body?.social_handles) ? body.social_handles : null
    const cleaned = rows && rows
      .map((r) => {
        const out = { platform: String(r.platform || '').trim(), handle: String(r.handle || '').trim() }
        if (String(r.artist || '').trim()) out.artist = String(r.artist).trim()
        if (Number.isFinite(Number(r.amount)) && Number(r.amount) > 0) out.amount = Number(r.amount)
        return out
      })
      .filter((r) => r.handle)
    return { data: { success: true, data: { id: 10408, ...body, ...(rows ? { social_handles: cleaned } : {}) } } }
  },
  post: async (url, body) => {
    calls.post.push({ url: String(url), body })
    if (/\/rush$/.test(String(url))) {
      return { data: { success: true, data: {
        rush_requested: true, rush_reason: body?.reason || null,
        rush_requested_by: 'John', rush_requested_at: '2026-08-27T00:00:00Z',
        on_hold: false,
      } } }
    }
    return { data: { success: true, data: {} } }
  },
  delete: async (url) => {
    calls.del.push(String(url))
    return { data: { success: true, data: {
      rush_requested: false, rush_reason: null, rush_requested_by: null, rush_requested_at: null,
    } } }
  },
}
export default api
