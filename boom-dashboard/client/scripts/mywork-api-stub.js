// My Work stub: my tasks in four due buckets, one done; a release assigned to
// me; a calendar with my deadline, my release, someone else's task, a payment
// due; approvals in the loop; an unused invite I sent; one unread mention.
export const calls = { get: [], post: [], put: [], del: [] }
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
const now = new Date()
const iso = (n) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const scenario = () => globalThis.__MW_SCENARIO__ || 'full'
export const TASKS = [
  { id: 1, description: 'Chase the W-9 from Northgate', status: 'To Do', priority: 'High', category: 'Finance', due_date: iso(-2), user_id: 1, assigned_by: 2, assigned_by_name: 'Sam Chen' },
  { id: 2, description: 'Approve the Night Drive artwork', status: 'In Progress', priority: 'Urgent', category: 'Release', due_date: iso(0), user_id: 1, assigned_by: 1 },
  { id: 3, description: 'Draft the Q4 marketing plan', status: 'To Do', priority: 'Medium', category: 'Marketing', due_date: iso(3), user_id: 1, assigned_by: 1 },
  { id: 4, description: 'Read the distributor contract', status: 'To Do', priority: 'Low', category: 'Legal', due_date: null, user_id: 1, assigned_by: 1 },
  { id: 5, description: 'Send the welcome pack', status: 'Done', priority: 'Medium', category: 'General', due_date: iso(-5), user_id: 1, assigned_by: 1 },
]
const api = {
  get(url) {
    calls.get.push(url)
    if (url.startsWith('/team/my-work')) return ok({ tasks: scenario() === 'empty' ? [] : TASKS, releases: [{ id: 9, project_name: 'Night Drive', release_date: iso(2) }], upcoming: [], invites_pending: scenario() === 'empty' ? [] : [{ id: 1, user_id: 3, name: 'Rosa Lind', email: 'rosa@example.test' }], activity: [] })
    if (url === '/team') return ok([{ id: 1, name: 'John Skead', department: 'Operations' }, { id: 2, name: 'Sam Chen', department: 'Finance' }, { id: 3, name: 'Rosa Lind', department: 'A&R' }])
    if (url.startsWith('/calendar')) return Promise.resolve({ data: { events: [
      { id: 'task-2', type: 'deadline', title: 'Approve the Night Drive artwork', date: iso(0), meta: 'Urgent', to: '/my-work', sourceId: 2 },
      { id: 'task-77', type: 'deadline', title: "Sam's task", date: iso(1), to: '/team/2', sourceId: 77 },
      { id: 'release-9', type: 'release', title: 'Night Drive', date: iso(2), meta: 'Single', to: '/releases', sourceId: 9 },
      { id: 'release-10', type: 'release', title: 'Not mine', date: iso(2), to: '/releases', sourceId: 10 },
      { id: 'payment-5', type: 'payment_due', title: 'Northgate — $1,500 due', date: iso(4), to: '/bk/payments', sourceId: 5 },
    ], sources: {} } })
    if (url.startsWith('/dashboard/loop')) return ok({ approvals: scenario() === 'empty' ? { count: 0 } : { count: 3, usd: 900, to: '/bk/approvals' } })
    if (url.startsWith('/notifications')) return ok({ mentions: scenario() === 'empty' ? [] : [{ id: 1 }] })
    if (url === '/settings/me') return ok({ tours_done: { welcome: { version: '2026-09-19' }, 'my-work': { version: '2026-09-19' } } })
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({ id: 99, ...body, status: 'To Do' }) },
  put(url, body) { calls.put.push({ url, body }); return ok(body) },
  delete(url) { calls.del.push(url); return ok({}) },
}
export default api
