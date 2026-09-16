// A PROXYING api for scripts/bankmatch-dom-entry.jsx — not a fixture.
//
// Bank Matching reads a dozen endpoints (/statements, /statements/:id,
// completion, rematch candidates, rule suggestions, funding pairs, the artist
// roster, the category vocabulary) and the shapes are deep: one hand-written
// fixture for /statements/:id is a guess at `matched`, `suggestions`,
// `vendor_hint` and `no_invoice_expected` all at once, and a harness that guesses
// the shape can only ever confirm the guess.
//
// So this talks to a REAL server on 127.0.0.1:3011 — booted from server/ against
// the dev database — with a real JWT. What the page renders is what the routes
// send, and a POST the page makes is a POST the database receives, which is the
// only version of "the button works" worth having: the shipped Add-Invoice button
// posted into a 400 for a month because the check stopped at the click.
//
// Every call is recorded in `calls` so a scenario can assert the BODY, not just
// that something happened.
const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api'
const TOKEN = process.env.API_TOKEN || ''

export const calls = { get: [], post: [], put: [], del: [] }

const url = (path, config) => {
  const qs = config?.params
    ? '?' + new URLSearchParams(Object.entries(config.params).filter(([, v]) => v != null)).toString()
    : ''
  return BASE + path + qs
}

// Axios-shaped: resolve with { data }, reject with { response: { status, data } },
// because the page branches on err.response?.status (409 duplicate speed bump)
// and on err.response?.data?.error for its messages.
const send = async (method, path, body, config) => {
  const res = await fetch(url(path, config), {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.response = { status: res.status, data }
    throw err
  }
  return { data }
}

const api = {
  get: (path, config) => { calls.get.push({ url: path }); return send('GET', path, undefined, config) },
  post: (path, body, config) => { calls.post.push({ url: path, body }); return send('POST', path, body ?? {}, config) },
  put: (path, body, config) => { calls.put.push({ url: path, body }); return send('PUT', path, body ?? {}, config) },
  delete: (path, config) => { calls.del.push({ url: path }); return send('DELETE', path, undefined, config) },
}

export default api
