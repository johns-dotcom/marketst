import axios from 'axios'
import { resolveMock } from './mock/mockApi'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3001/api')
})

// Demo-mode passthroughs: auth + current-user prefs still hit the real backend
// even when the user is a test account, so login and /auth/me keep working.
// Everything else for test users is served by the mock adapter below.
const TEST_USER_PASSTHROUGHS = [
  /^\/auth\//,
  /^\/settings\/me(\b|\/)/,
  /^\/settings\/change-password$/,
  /^\/settings\/theme$/,
  /^\/settings\/my-nav(\/|$)/,
]

function currentUserIsTest() {
  try {
    const raw = localStorage.getItem('boom_user_cache')
    if (!raw) return false
    return !!JSON.parse(raw)?.is_test
  } catch { return false }
}

function shouldPassThrough(url) {
  const u = (url || '').split('?')[0]
  return TEST_USER_PASSTHROUGHS.some(re => re.test(u))
}

// Custom axios adapter that short-circuits the request with a mocked response.
// When set on config.adapter, axios skips XHR/fetch and resolves with our data.
// Matchers may return a bare payload (served as 200) OR an envelope of the
// shape { status, data } — used for mock 404s (which must REJECT so client
// .catch rollbacks fire) and Blob placeholders (which must unwrap so demo
// exports don't download "[object Object]").
const mockAdapter = (config) => new Promise((resolve, reject) => {
  const body = typeof config.data === 'string'
    ? (() => { try { return JSON.parse(config.data) } catch { return config.data } })()
    : config.data
  const result = resolveMock((config.method || 'get').toUpperCase(), config.url, body)
  const isEnvelope = result && typeof result === 'object' && !Array.isArray(result)
    && typeof result.status === 'number' && 'data' in result
  const status = isEnvelope ? result.status : 200
  const data = isEnvelope ? result.data : result
  const response = { data, status, statusText: status >= 400 ? 'Error' : 'OK', headers: {}, config, request: {} }
  if (status >= 400) {
    const err = new Error(`Request failed with status code ${status}`)
    err.response = response
    err.config = config
    reject(err)
  } else {
    resolve(response)
  }
})

// Add JWT token to all requests + route test users through the mock adapter
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  if (currentUserIsTest() && !shouldPassThrough(config.url)) {
    config.adapter = mockAdapter
  }
  return config
}, error => {
  return Promise.reject(error)
})

// Handle 401 responses — session expired
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 && localStorage.getItem('token')) {
      // Clear auth state
      localStorage.removeItem('token')
      localStorage.removeItem('admin_token')
      // Redirect to login with message (avoid infinite loop by checking current path)
      if (window.location.pathname !== '/login' && window.location.pathname !== '/submit') {
        window.location.href = '/login?expired=1'
      }
    }
    return Promise.reject(error)
  }
)

export default api
