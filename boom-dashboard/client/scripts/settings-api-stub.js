// Data for the settings harness: my profile, sessions, prefs, the label row,
// integrations, and the People directory. Role comes from the auth stub.
import { PRESETS } from '../src/lib/navPresets'
export const calls = { get: [], post: [], put: [] }
export const BOOKKEEPER_PAGES = PRESETS.find((p) => p.key === 'bookkeeper').paths
const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })
export const PEOPLE = [
  { id: 1, name: 'John Skead', email: 'john@deanst.co', role: 'Superadmin', department: 'Operations', pages: null, last_sign_in: new Date().toISOString(), open_tasks: 3, invite_pending: false },
  { id: 2, name: 'Sam Chen', email: 'sam@example.test', role: 'User', department: 'Finance', pages: BOOKKEEPER_PAGES, last_sign_in: new Date(Date.now() - 2 * 86400000).toISOString(), open_tasks: 7, invite_pending: false },
  { id: 3, name: 'Rosa Lind', email: 'rosa@example.test', role: 'User', department: 'A&R', pages: ['/releases'], last_sign_in: null, open_tasks: 0, invite_pending: true },
]
const api = {
  get(url) {
    calls.get.push(url)
    if (url === '/settings/me') return ok({ id: 1, name: 'John Skead', email: 'john@deanst.co', role: 'Superadmin', department: 'Operations', title: '', phone: '', nav_hidden: null, has_password: globalThis.__HOME_ROLE__ !== 'User' })
    if (url === '/settings/department-navs') return ok({ navs: [{ department: 'Marketing', pages: ['/', '/my-work', '/messages', '/campaigns', '/releases'], hidden: ['/messages'], updated_by_name: 'John Skead', updated_at: '2026-09-22T00:00:00Z' }], members: { Marketing: [{ id: 3, name: 'Rosa Lind', role: 'User', department: 'Marketing', customised: true }, { id: 4, name: 'Dev Patel', role: 'User', department: 'Marketing', customised: false }], Operations: [{ id: 1, name: 'John Skead', role: 'Superadmin', department: 'Operations', customised: false }] } })
    if (/^\/settings\/users\/\d+\/nav$/.test(url)) return ok({ hidden: ['/calendar'], pages: ['/', '/my-work', '/messages', '/calendar', '/releases'], department: 'Marketing', department_nav: { department: 'Marketing', pages: ['/', '/my-work', '/messages', '/campaigns', '/releases'], hidden: ['/messages'] } })
    if (url === '/settings/me/sessions') return ok([{ id: 1, logged_in_at: new Date().toISOString(), ip_address: '10.0.0.1', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/128 Safari/537' }])
    if (url === '/settings/me/notifications') return ok({ approvals_waiting: false, payments_due: true, tasks_assigned: false, renewals_coming: false, weekly_digest: false }, { delivery: { gmail: false } })
    if (url === '/label') return ok({ id: 1, legal_name: 'Market Street Records LLC', display_name: 'Market Street', address_line1: '', address_line2: '', contact_name: '', contact_email: 'ap@marketst.test', contact_phone: '', bank_name: '', bank_address: '', bank_account_name: '', bank_account_type: '', bank_routing_ach: '', bank_routing_wire: '', bank_swift: '', signatory_name: 'John Skead', signatory_title: 'Managing Member', default_payment_terms: 'Net 30', ein_set: true, ein_last4: '6789', bank_account_set: false, bank_account_last4: null })
    if (url === '/quickbooks/status') return ok({ configured: false, connected: false, queue: {}, settings: {} })
    if (url === '/docusign/status') return ok({ configured: false, connected: false, label_signer: { name: 'Market Street', email: null } })
    if (url.startsWith('/docusign/envelopes')) return ok([])
    if (url === '/settings/integrations') return ok([
      { key: 'gmail', label: 'Gmail', configured: false, powers: 'payment confirmations', detail: null, last_used: null },
      { key: 'storage', label: 'File storage (R2)', configured: true, powers: 'invoices and documents', detail: 'bucket ms-files', last_used: null },
    ])
    if (url === '/settings/people') return ok(PEOPLE)
    if (url === '/team') return ok(PEOPLE.map(({ pages, ...p }) => p))
    if (/^\/team\/\d+\/tasks/.test(url)) return ok([])
    if (url.startsWith('/team/workload') || url.startsWith('/team/velocity')) return ok([])
    if (url.startsWith('/settings/reps')) return ok([])
    return ok([])
  },
  post(url, body) {
    if (url === '/auth/change-password') { calls.post.push({ url, body }); return ok({}, { first_password: body.current_password === undefined }) } calls.post.push({ url, body }); if (/\/invite$/.test(url)) return ok({ token: 'abc', path: '/invite/abcdefghijklmnopqrstuvwx', expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }); return ok({}) },
  put(url, body) { calls.put.push({ url, body }); if (url === '/settings/me') return ok({ id: 1, ...body }); if (/\/department-navs\//.test(url)) return ok({ department: decodeURIComponent(url.split('/').pop()), pages: body.pages, hidden: body.hidden }, { applied: body.apply ? 1 : 0, sidebar_set: body.apply ? 1 : 0, customised_kept: body.apply ? 1 : 0, admins_untouched: 0 }); if (/\/users\/\d+\/nav$/.test(url)) return ok({ hidden: body.hidden }); if (url === '/label') return ok({ ...body, ein_set: true, ein_last4: '6789', bank_account_set: !!body.bank_account_number, bank_account_last4: body.bank_account_number ? body.bank_account_number.slice(-4) : null }); return ok(body) },
  patch() { return ok({}) }, delete() { return ok({}) },
}
export default api
