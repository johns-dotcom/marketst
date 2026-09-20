// An EMPTY label at the api boundary: every list is [], every object is bare.
// The anchors harness renders the real pages against this and asks whether
// each tour step's target exists — the bug class where a spotlight anchor
// only renders once there is data.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const shapes = [
  [/^\/dashboard\/loop/, () => ok({ approvals: { count: 0, usd: 0, to: '/bk/approvals' }, payments: { count: 0, usd: 0, to: '/bk/payments' }, bank: { count: 0, usd: 0, to: '/bk/bank' }, releases: { count: 0, to: '/releases' }, onboarding: { count: 0, to: '/artists?onboarding=1' }, tasks: { count: 0 } })],
  [/^\/dashboard\/activity/, () => ok([])],
  [/^\/dashboard\/notifications/, () => ok([])],
  [/^\/dashboard\/stats/, () => ok({})],
  [/^\/calendar/, () => ok([], { sources: { releases: true, tasks: 'team', payments: true, renewals: true, signings: true } })],
  [/^\/team\/my-work/, () => ok({ tasks: [], releases: [], invites_pending: [], mentions: [] })],
  [/^\/team\/(velocity|workload)/, () => ok([])],
  [/^\/team$/, () => ok([{ id: 1, name: 'John', email: 'john@deanst.co', role: 'Superadmin' }])],
  [/^\/settings\/me\/notifications/, () => ok({}, { keys: [], delivery: { gmail: false } })],
  [/^\/settings\/me\/sessions/, () => ok([])],
  [/^\/settings\/me$/, () => ok({ id: 1, name: 'John', email: 'john@deanst.co', role: 'Superadmin', tours_done: {} })],
  [/^\/settings\/people/, () => ok([])],
  [/^\/settings\/integrations/, () => ok([])],
  [/^\/settings\/reps/, () => ok([])],
  [/^\/label$/, () => ok({})],
  [/^\/mail\/mailboxes/, () => ok([], { purposes: [], configured: false })],
  [/^\/mail\/status/, () => ok([], { configured: false })],
  [/^\/quickbooks\/status/, () => ok({ configured: false, connected: false, queue: {}, settings: {} })],
  [/^\/docusign\/status/, () => ok({ configured: false, connected: false, label_signer: {} })],
  [/^\/docusign\/envelopes/, () => ok([])],
  [/^\/artists\/onboarding/, () => ok([])],
  [/^\/artists\/\d+\/stats/, () => ok({ sources: { spotify: false, chartmetric: false }, spotify: null, chartmetric: null, days: 90 })],
  [/^\/artists\/\d+\/spotify/, () => Promise.reject(Object.assign(new Error('no spotify'), { response: { status: 503, data: { error: 'Spotify not configured' } } }))],
  [/^\/artists\/\d+\/(onboarding|files|links|releases|contracts|expenses|devlog)/, () => ok([])],
  [/^\/artists\/\d+$/, () => ok({ id: 1, name: 'Empty Artist', genre: 'Test', links: [], releases: [], contracts: [], expenses: [], devlog: [], signed_at: null })],
  [/^\/artists\/resolve/, () => Promise.reject(Object.assign(new Error('404'), { response: { status: 404, data: {} } }))],
  [/^\/artists/, () => ok([], { total: 0, page: 1, pages: 1, artists: [] })],
  [/^\/releases/, () => ok([], { total: 0 })],
  [/^\/deals/, () => ok([])],
  [/^\/contracts\/(expiring|missing)/, () => ok([])],
  [/^\/contracts/, () => ok([])],
  [/^\/bk\/approval-history/, () => ok([])],
  [/^\/bk\/w9-reviews/, () => ok([])],
  [/^\/bk\/vendors/, () => ok([])],
  [/^\/bk\/approvals/, () => ok([])],
  [/^\/bk\/payments/, () => ok([])],
  [/^\/brand/, () => ok([])],
  [/^\/notifications/, () => ok([])],
]
const api = {
  get(url) { calls.get.push(url); const hit = shapes.find(([re]) => re.test(url)); return hit ? hit[1](url) : ok([]) },
  post(url, body) { calls.post.push({ url, body }); return ok({}) },
  put(url, body) { calls.put.push({ url, body }); return ok({}) },
  patch(url, body) { calls.put.push({ url, body }); return ok({}) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
