// Data for the hand-off harness: a roster without Rosa Vale, an empty
// contracts and releases list, and writes that echo back a created row.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })

let artists = [{ id: 1, name: 'Darci', genre: 'Pop' }, { id: 2, name: 'Oxis', genre: 'Electronic' }]

const api = {
  get(url) {
    calls.get.push(url)
    if (url === '/deals/5') return ok({ id: 5, artist_name: 'Rosa Vale', deal_type: 'Master License', advance: 25000, royalty_split: 50, term_months: 24, territory: 'World', num_releases: 3, option_periods: 1 })
    if (url.startsWith('/artists')) return ok(artists)
    if (url.startsWith('/contracts/missing')) return ok([])
    if (url.startsWith('/contracts/expiring')) return ok([])
    if (url.startsWith('/contracts')) return ok([])
    if (url.startsWith('/releases')) return ok([])
    if (url.startsWith('/team')) return ok([])
    if (url.startsWith('/notifications')) return ok([])
    return ok([])
  },
  post(url, body) {
    calls.post.push({ url, body })
    if (url === '/artists') { const a = { id: 9, name: body.name, genre: body.genre || null }; artists = [...artists, a]; return ok(a) }
    if (url === '/releases') return ok({ id: 41, project_name: body.project_name, artist_name: body.artist_name, release_date: body.release_date || null })
    if (url === '/contracts') return ok({ id: 77, ...body })
    return ok({})
  },
  put(url, body) { calls.put.push({ url, body }); return ok(body) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
