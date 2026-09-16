// A stubbed api: resolves with the shape /team/my-work really returns, so the
// page's data branches run. Measured earlier on John's own account: 26 tasks,
// 8 open, 18 done, three with a short body, releases + upcoming empty.
const tasks = []
for (let i = 1; i <= 26; i += 1) {
  const done = i > 8
  tasks.push({
    id: i,
    description: i === 1 ? 'cobrand sync' : `task ${i}`,
    notes: i <= 3 ? 'have dylan do?' : '',
    status: done ? 'Done' : (i === 2 ? 'In Progress' : 'To Do'),
    priority: ['Urgent', 'High', 'Medium', 'Low'][i % 4],
    category: ['General', 'Release', 'Marketing', 'Finance'][i % 4],
    due_date: i % 3 === 0 ? '2026-08-20' : (i % 3 === 1 ? '2026-09-05' : null),
    release_id: null,
    assigned_to_id: 1,
    created_at: '2026-08-01T00:00:00Z',
  })
}
const DATA = { tasks, releases: [], upcoming: [], activity: [
  { id: 1, action: 'created', entity: 'task', created_at: '2026-08-20T00:00:00Z', user_name: 'John' },
] }
const resp = (url) => {
  if (url.includes('/team/my-work')) return { data: { success: true, data: DATA } }
  if (url.includes('/releases')) return { data: { success: true, data: [] } }
  if (url.includes('/team')) return { data: { success: true, data: [
    { id: 1, name: 'John', email: 'j@b.co' },
    { id: 2, name: 'Dylan', email: 'dylan@b.co' },
    { id: 3, name: 'Felipe', email: 'felipe@b.co' },
  ] } }
  return { data: { success: true, data: [] } }
}
// Counted, so a test can assert that typing does NOT trigger a refetch. The
// notes pane used to `await fetchData()` after every debounced write, and
// fetchData sets loading=true — which renders the skeleton and tears the
// textarea out of the DOM mid-sentence.
export const calls = { get: [], put: [], post: [] }
const api = {
  get: async (url) => { calls.get.push(String(url)); return resp(String(url)) },
  post: async (url, body) => {
    calls.post.push({ url: String(url), body })
    // A real create returns the row, with an id — the page selects by it.
    if (String(url).includes('/team/tasks')) {
      // MIRRORS THE SERVER: POST /team/tasks refuses a falsy description with
      // "Description required". The first version of this stub accepted '' and
      // happily reported the New Task button working, when the real endpoint
      // would have 400'd. A stub that is more permissive than the thing it
      // stands in for does not test the code, it agrees with it.
      if (!body || !body.description) {
        const err = new Error('Request failed with status code 400')
        err.response = { status: 400, data: { success: false, error: 'Description required' } }
        throw err
      }
      const id = 9000 + calls.post.length
      return { data: { success: true, data: { id, description: '', status: 'To Do',
        priority: 'Medium', category: 'General', due_date: null, notes: '', ...(body || {}) } } }
    }
    return { data: { success: true, data: {} } }
  },
  put: async (url, body) => {
    calls.put.push({ url: String(url), body })
    // The assign route answers with the moved task AND a notification preview,
    // which is what raises the email modal.
    if (/\/tasks\/\d+\/assign$/.test(String(url))) {
      return { data: { success: true, data: { id: 1, user_id: body?.user_id },
        pending_email: { kind: 'task_assigned', context: { assigneeName: 'Dylan' }, subject: 'x', html: 'y' } } }
    }
    return { data: { success: true, data: {} } }
  },
  patch: async () => ({ data: { success: true, data: {} } }),
  delete: async () => ({ data: { success: true, data: {} } }),
}
export default api
