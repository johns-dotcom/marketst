// A stubbed api for scripts/addinvoice-dom-entry.jsx.
//
// POST /bk/entries mirrors the real route's two answers that matter here:
// it REFUSES an incomplete checklist with the server's own wording (the client's
// disabled button is a courtesy, not the gate), and it reports `checklist_stored`
// so a caller cannot imply an invoice was reviewed when it was not.
export const calls = { get: [], post: [], put: [], del: [] }
export const lastEntry = () => calls.post.filter((c) => c.url === '/bk/entries').slice(-1)[0] || null

const CONFIRM = ['artist', 'song', 'amount', 'category']
const ANSWER = ['bulk_deal', 'cobrand', 'recoupable', 'campaign']

const api = {
  get: async (url) => {
    calls.get.push(String(url))
    if (String(url).includes('/bk/vendors')) return { data: { success: true, data: [] } }
    return { data: { success: true, data: [] } }
  },
  post: async (url, body) => {
    calls.post.push({ url: String(url), body })
    if (String(url) === '/bk/entries') {
      const ck = body?.checklist
      if (ck) {
        const missing = CONFIRM.filter((k) => ck[k] !== true)
        if (missing.length) {
          const e = new Error('bad checklist')
          e.response = { status: 400, data: { success: false, error: 'Not confirmed: ' + missing.join(', ') } }
          throw e
        }
        const implied = ck.cobrand === true
        const un = ANSWER.filter((k) => (k === 'campaign' && implied ? false : typeof ck[k] !== 'boolean'))
        if (un.length) {
          const e = new Error('bad checklist')
          e.response = { status: 400, data: { success: false, error: 'Not answered: ' + un.join(', ') } }
          throw e
        }
      }
      return { data: { success: true, data: { id: 4242 }, checklist_stored: !!ck } }
    }
    return { data: { success: true, data: {} } }
  },
  put: async (url, body) => { calls.put.push({ url: String(url), body }); return { data: { success: true, data: {} } } },
  delete: async (url) => { calls.del.push(String(url)); return { data: { success: true, data: {} } } },
}
export default api
