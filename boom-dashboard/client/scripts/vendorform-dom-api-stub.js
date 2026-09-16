// `../api` for the vendor-form DOM harness.
//
// VendorSubmit itself never imports this — it is a PUBLIC page and talks to the
// server with bare `fetch`, which the entry stubs instead. This exists for the
// providers the page is wrapped in (CategoriesContext, BoomRepsContext), which
// do use the axios client and would otherwise hit the network on mount and
// blank their dropdowns when it failed.
export const calls = { get: [], post: [], put: [], delete: [] }

const api = {
  get: async (url) => {
    calls.get.push({ url: String(url) })
    if (String(url).includes('/categories')) {
      return { data: { success: true, data: { expense: ['Marketing', 'Production', 'Travel'], income: ['Royalties'] } } }
    }
    if (String(url).includes('/reps')) {
      // STRINGS. `GET /api/reps` is `rows.map(r => r.name)`, and the form does
      // `BOOM_REPS.map(r => <option>{r}</option>)` — handing it objects throws
      // "Objects are not valid as a React child" and blanks the page. This stub
      // returned `[{id, name, active}]` until 2026-09-15 and nothing caught it,
      // because no scenario had ever rendered step 3 where the rep select lives.
      return { data: { success: true, data: ['John', 'Felipe', 'Tyler'] } }
    }
    return { data: { success: true, data: [] } }
  },
  post: async (url, body) => { calls.post.push({ url: String(url), body }); return { data: { success: true, data: {} } } },
  put: async (url, body) => { calls.put.push({ url: String(url), body }); return { data: { success: true, data: {} } } },
  patch: async () => ({ data: { success: true, data: {} } }),
  delete: async (url) => { calls.delete.push({ url: String(url) }); return { data: { success: true, data: {} } } },
}
export default api
