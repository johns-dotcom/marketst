// API stub for scripts/chatattach-dom-run.mjs.
//
// Fully offline: no server, no database. The fixture pins the four attachment
// shapes that render differently, because the thing under test is which BRANCH
// each one takes:
//
//   image + presigned url  → <img src="https://…">, straight from the bucket
//   image + inline (no url) → blob fetched through the authenticated endpoint
//   pdf   + presigned url  → download chip pointing at the bucket
//   pdf   + inline         → download chip that fetches, then saves client-side
//
// The rule being protected is that a session token NEVER appears in a URL the
// browser puts in an attribute. That is invisible in code review and trivial to
// assert here.
export const calls = []

const CHANNELS = [{
  id: 1, name: 'general', type: 'channel', is_private: false, topic: 'Company-wide chatter',
  unread: 0, muted: false, created_at: '2026-09-01T10:00:00Z', members: [{ id: 1, name: 'John' }],
  display_name: 'general', peer: null, last_message: null,
}]

const MESSAGES = [
  {
    id: 101, channel_id: 1, user_id: 1, author_name: 'John', body: 'cover art, straight from the bucket',
    created_at: '2026-09-14T10:00:00Z', edited_at: null, is_system: false, meta: null,
    thread_root_id: null, reply_count: 0, reactions: [],
    attachments: [{
      id: 11, filename: 'cover.png', mime: 'image/png', size_bytes: 2048, stored: 'r2',
      url: 'https://fake-r2.example.com/entity_files/chat_attachment/101/cover.png?X-Amz-Expires=21600&X-Amz-Signature=abc',
    }],
  },
  {
    id: 102, channel_id: 1, user_id: 1, author_name: 'John', body: 'and this one is stored in the database',
    created_at: '2026-09-14T10:01:00Z', edited_at: null, is_system: false, meta: null,
    thread_root_id: null, reply_count: 0, reactions: [],
    attachments: [{ id: 12, filename: 'inline-shot.png', mime: 'image/png', size_bytes: 1024, stored: 'inline' }],
  },
  {
    id: 103, channel_id: 1, user_id: 1, author_name: 'John', body: 'the signed contract',
    created_at: '2026-09-14T10:02:00Z', edited_at: null, is_system: false, meta: null,
    thread_root_id: null, reply_count: 0, reactions: [],
    attachments: [{
      id: 13, filename: 'contract.pdf', mime: 'application/pdf', size_bytes: 91234, stored: 'r2',
      url: 'https://fake-r2.example.com/entity_files/chat_attachment/103/contract.pdf?X-Amz-Signature=def',
    }],
  },
  // A bot event — no author, is_system, meta carries the icon and the deep link.
  {
    id: 105, channel_id: 1, user_id: null, author_name: null,
    body: '*John* approved *Spotify Ads* — USD 12,500',
    created_at: '2026-09-14T10:04:00Z', edited_at: null, is_system: true,
    meta: { icon: 'check', link: '/bk/ledger?entry=41' },
    thread_root_id: null, reply_count: 0, reactions: [], attachments: [],
  },
  // A bot event with no link — the "View →" affordance must not render.
  {
    id: 106, channel_id: 1, user_id: null, author_name: null,
    body: 'A vendor submitted an invoice',
    created_at: '2026-09-14T10:05:00Z', edited_at: null, is_system: true,
    meta: { icon: 'inbox', link: null },
    thread_root_id: null, reply_count: 0, reactions: [], attachments: [],
  },
  {
    id: 104, channel_id: 1, user_id: 1, author_name: 'John', body: null,
    created_at: '2026-09-14T10:03:00Z', edited_at: null, is_system: false, meta: null,
    thread_root_id: null, reply_count: 0, reactions: [],
    attachments: [{ id: 14, filename: 'invoice archive.pdf', mime: 'application/pdf', size_bytes: 4096, stored: 'inline' }],
  },
]

const ok = (data, extra = {}) => Promise.resolve({ data: { success: true, data, ...extra } })

const api = {
  get(url, config) {
    calls.push({ method: 'GET', url, config })
    if (url === '/chat/channels') return ok(CHANNELS)
    if (url === '/chat/users') return ok([{ id: 1, name: 'John', role: 'Superadmin' }, { id: 2, name: 'Soli', role: 'Approver' }])
    if (url === '/chat/unread') return ok({ total: 0 })
    if (/^\/chat\/channels\/\d+\/messages/.test(url)) return ok(MESSAGES, { has_more: false })
    if (/^\/chat\/attachments\/\d+$/.test(url)) {
      // What the authenticated endpoint returns for an inline-stored file.
      return Promise.resolve({ data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }) })
    }
    return ok([])
  },
  post(url, body, config) { calls.push({ method: 'POST', url, body, config }); return ok({ id: 999 }) },
  patch(url, body) { calls.push({ method: 'PATCH', url, body }); return ok({}) },
  delete(url) { calls.push({ method: 'DELETE', url }); return ok({}) },
}
export default api
