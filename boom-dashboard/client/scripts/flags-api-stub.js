// The Flags page's data, stubbed at the api boundary. Scenario picked by
// globalThis.__FLAGS_SCENARIO__ (set by the entry before render):
//
//   admin    a Superadmin: setup + workflow + compliance register categories,
//            data-quality categories with tracking, one capped category, one
//            dismissed register row, a sweep error to disclose
//   section  same data, page opened on /flags?tab=approval_stale&focus=108
//   empty    every category present and ZERO; the all-clear card must list
//            what is watched, and the rail must show only "checks clear" lines
//   user     a /releases-only User: only the release kinds arrive
export const calls = { get: [], post: [], put: [], del: [] }
const scenario = () => globalThis.__FLAGS_SCENARIO__ || 'admin'
const ok = (data, meta) => Promise.resolve({ data: { success: true, data, ...(meta ? { meta } : {}) } })
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

// The viewer last looked 2 days ago; rows first seen since are NEW.
const SEEN_AT = daysAgo(2)

const reg = (kind, label, group, page, items, extra = {}) => ({
  kind, label, group, page, description: `${label} — what fills it.`, register: true,
  severity: items.some((i) => i.severity === 'high') ? 'high' : 'medium',
  count: items.filter((i) => !i.dismissed && !i.snoozed).length, items,
  tracking: { new: items.filter((i) => !i.dismissed && new Date(i.first_seen) > new Date(SEEN_AT)).length, oldest_days: items.filter((i) => !i.dismissed).length ? Math.max(...items.filter((i) => !i.dismissed).map((i) => i.age_days)) : null, owner: null },
  ...extra,
})
const item = (key, title, o = {}) => ({ key: String(key), title, detail: o.detail || null, to: o.to || '/bk/payments', usd: o.usd ?? null, severity: o.severity || 'medium',
  first_seen: o.first_seen || daysAgo(1), age_days: o.age_days ?? 1, is_new: true, dismissed: !!o.dismissed, dismissed_at: o.dismissed ? ago(30) : null, dismissed_by_name: o.dismissed ? 'Sam Chen' : null,
  snoozed: false, snooze_until: null, task: o.task || null })

const dq = (kind, label, severity, items, extra = {}) => ({ kind, label, severity, description: `${label}.`, count: items.length, items, tracking: { new: 0, oldest_days: null, owner: null }, ...extra })

function categories() {
  const sc = scenario()
  if (sc === 'user') {
    return [
      reg('release_unassigned', 'Releases with nobody on them', 'Workflow', '/releases', [item(9, 'Rosa Vale — Night Drive releases 2026-09-29 with no owner', { to: '/releases', first_seen: daysAgo(0), age_days: 0 })]),
      reg('release_behind', 'Releases behind on the checklist', 'Workflow', '/releases', []),
    ]
  }
  if (sc === 'empty') {
    return [
      dq('duplicate_invoices', 'Potential Duplicate Invoices', 'high', []), dq('duplicate_vendors', 'Potential Duplicate Vendors', 'high', []),
      dq('releases_missing_genre', 'Releases Missing Genre', 'medium', [], { of_total: 0 }), dq('artist_unknown', 'Ledger — Unknown Artist', 'medium', []),
      reg('label_incomplete', 'Label record incomplete', 'Setup', '/settings', []), reg('mail_setup', 'Mail not connected', 'Setup', '/settings', []),
      reg('approval_stale', 'Approvals waiting too long', 'Workflow', '/bk/approvals', []), reg('payment_overdue', 'Payments past due', 'Workflow', '/bk/payments', []),
      reg('w9_missing', 'Vendors with no W-9', 'Compliance', '/bk/vendors', []), reg('statement_overdue', 'Bank statement never came', 'Money', '/bk/statements', []),
    ]
  }
  return [
    // data-quality, with tracking from the register
    dq('duplicate_invoices', 'Potential Duplicate Invoices', 'high', [], { groups: [{ group_key: '1,2', reasons: ['same invoice number'], entries: [{ id: 1, payee: 'Northgate', amount: 500, currency: 'USD' }, { id: 2, payee: 'Northgate', amount: 500, currency: 'USD' }], first_seen: daysAgo(0), is_new: true, dismissed: false }], count: 1, tracking: { new: 1, oldest_days: 0, owner: null } }),
    dq('artist_unknown', 'Ledger — Unknown Artist', 'medium', [{ id: 44, payee: 'Studio X', artist: 'Zzq Nobody', song: 'Song', amount: 55, currency: 'USD', suggestion: null, first_seen: daysAgo(5), age_days: 5, is_new: false }], { tracking: { new: 0, oldest_days: 5, owner: { task_id: 7, user_id: 2, user_name: 'Sam Chen', status: 'To Do' } } }),
    // capped: the header says 10, the body holds 3
    dq('releases_missing_genre', 'Releases Missing Genre', 'medium', [{ id: 1, project_name: 'A', artist_name: 'X' }, { id: 2, project_name: 'B', artist_name: 'X' }, { id: 3, project_name: 'C', artist_name: 'X' }], { count: 10, of_total: 40, truncated: true, shown: 3 }),
    // register
    reg('label_incomplete', 'Label record incomplete', 'Setup', '/settings', [item('label', '5 label fields blank', { detail: 'Legal name, Address line 1, Contact email, Signatory email, EIN', to: '/settings?tab=label', severity: 'high', first_seen: daysAgo(9), age_days: 9 })]),
    reg('mail_setup', 'Mail not connected', 'Setup', '/settings', [item('none', 'No mailbox connected', { to: '/settings?tab=integrations', first_seen: daysAgo(9), age_days: 9 })]),
    reg('approval_stale', 'Approvals waiting too long', 'Workflow', '/bk/approvals', [
      item(108, 'Northgate Studios #INV-7 waiting 9 days', { detail: 'pending approval', to: '/bk/approvals', usd: 1500, severity: 'high', first_seen: daysAgo(0), age_days: 0 }),
      item(109, 'Blue Room #22 waiting 4 days', { detail: 'pending approval', to: '/bk/approvals', usd: 300, first_seen: daysAgo(4), age_days: 4, task: { id: 5, status: 'To Do', user_id: 2, user_name: 'Sam Chen' } }),
      item(110, 'Old Vendor #1 waiting 30 days', { detail: 'pending approval', to: '/bk/approvals', usd: 90, dismissed: true, first_seen: daysAgo(30), age_days: 30 }),
    ]),
    reg('payment_overdue', 'Payments past due', 'Workflow', '/bk/payments', []),
    reg('w9_missing', 'Vendors with no W-9', 'Compliance', '/bk/vendors', [item('northgate', 'Northgate Studios: no W-9 on file', { detail: '2 open invoices', to: '/bk/vendors?q=Northgate', first_seen: daysAgo(1), age_days: 1 })]),
    reg('statement_overdue', 'Bank statement never came', 'Money', '/bk/statements', []),
  ]
}
const META = () => ({
  seen_at: scenario() === 'user' ? null : SEEN_AT,
  swept_at: ago(12), sweep_trigger: 'hourly',
  sweep_errors: scenario() === 'admin' || scenario() === 'section' ? { attachment_missing: 'column e.nope does not exist' } : {},
  sweep_counts: {}, detectors: [],
})

const api = {
  get(url, opts) {
    calls.get.push(url)
    if (url.startsWith('/flags/artist-issues')) return ok({ buckets: {}, dismissed: [] })
    if (url.startsWith('/flags')) {
      // The server drops dismissed / snoozed register rows unless asked.
      const inc = /include_dismissed=1/.test(url)
      return ok(categories().map((c) => c.register && !inc ? { ...c, items: c.items.filter((i) => !i.dismissed && !i.snoozed) } : c), META())
    }
    if (url.startsWith('/statements')) return Promise.reject(Object.assign(new Error('403'), { response: { status: 403 } }))
    if (url === '/team') return ok([{ id: 1, name: 'John Skead' }, { id: 2, name: 'Sam Chen' }, { id: 3, name: 'Rosa Lind' }])
    if (url.startsWith('/artists')) return ok([])
    return ok([])
  },
  post(url, body) { calls.post.push({ url, body }); return ok({ id: 99, ...body }) },
  put(url, body) { calls.put.push({ url, body }); return ok(body) },
  delete(url, opts) { calls.del.push({ url, params: opts?.params }); return ok({}) },
}
export default api
