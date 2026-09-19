export const calls = { get: [], put: [] }
const ok = (data) => Promise.resolve({ data: { success: true, data } })
const scenario = () => globalThis.__TOUR_SCENARIO__ || 'fresh'
const api = {
  get(url) { calls.get.push(url); if (url === '/settings/me') return ok({ id: 1, name: 'John', tours_done: scenario() === 'fresh' ? {} : { welcome: { version: '2026-09-19' }, home: { version: '2000-01-01' } } }); return ok([]) },
  put(url, body) { calls.put.push({ url, body }); return ok({ ...(scenario() === 'fresh' ? {} : { welcome: { version: '2026-09-19' } }), [body.id]: { version: body.version } }) },
  post() { return ok({}) }, delete() { return ok({}) },
}
export default api
