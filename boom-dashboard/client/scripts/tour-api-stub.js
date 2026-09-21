export const calls = { get: [], put: [] }
import { TOURS } from '../src/tours'
const WELCOME_V = TOURS.find((t) => t.id === 'welcome').version   // 'done' means done at the CURRENT version
const ok = (data) => Promise.resolve({ data: { success: true, data } })
const scenario = () => globalThis.__TOUR_SCENARIO__ || 'fresh'
const api = {
  get(url) { calls.get.push(url); if (url === '/settings/me') return ok({ id: 1, name: 'John', tours_done: scenario() === 'fresh' || scenario() === 'mobile' ? {} : scenario() === 'user' ? { welcome: { version: WELCOME_V } } : scenario() === 'detail' ? { welcome: { version: '2000-01-01', skipped: true } } : { welcome: { version: WELCOME_V }, home: { version: '2000-01-01' } } }); return ok([]) },
  put(url, body) { calls.put.push({ url, body }); const list = Array.isArray(body.tours) ? body.tours : [body]; return ok({ ...(scenario() === 'fresh' ? {} : { welcome: { version: WELCOME_V } }), ...Object.fromEntries(list.map((t) => [t.id, { version: t.version }])) }) },
  post() { return ok({}) }, delete() { return ok({}) },
}
export default api
