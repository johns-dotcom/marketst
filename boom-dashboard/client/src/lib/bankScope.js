// The bank month, held OUTSIDE the component tree.
//
// The four banking surfaces — For review (/bk/bank-matching), Categorized
// (/bk/bank-ledger), Statements (/bk/statements) and Rules (/bk/rules) — are
// one page with a tab bar over four routes. Four routes means four separate
// mounts: switching tabs UNMOUNTS the page you were on, so anything held in
// component state is gone. "I selected June, clicked Categorized, and it went
// back to every statement" is that unmount, and it is what made the two pages
// feel like two pages.
//
// So the selection lives in this module. A module is loaded once per session
// and survives every unmount, which is precisely the lifetime the selection
// needs — longer than a component, shorter than a browser profile.
//
// ── Why not the alternatives ─────────────────────────────────────────────────
//
//   The URL alone.  It is still the deep-link contract (three live callers:
//     BkStatements' openStatement, and BkLedger's Statement and Bank-line
//     cells), and this module seeds from it and mirrors back to it. But it
//     cannot be the carrier, because TWO of the four tabs strip the query
//     string on mount — BkBankMatching and BkStatements both call
//     replaceState(pathname) after reading their deep-link params — so a value
//     handed over by a <Link> is erased a tick later.
//
//   localStorage.  Persists too long. Come back tomorrow and Categorized is
//     silently scoped to April, a mode nobody chose. (The Out/In/Both toggle
//     IS in localStorage, correctly: that is a preference. Which month you are
//     working is a selection.)
//
//   A provider above <Routes>.  Wrong altitude — every page in the app pays for
//     it — and App.jsx's provider stack is mirrored in seven harness files.
//     Fatal objection: bankmatch-dom-entry.jsx and ledgervendor-dom-entry.jsx
//     mount these pages with no provider at all, so both harnesses would need
//     editing to keep passing. A module store works with nothing mounted above
//     it, which is why those two harnesses are untouched by this change.
//
// ── The one canonical value ──────────────────────────────────────────────────
//
// `statementId` is null (every statement) or a String id. NEVER 'all', never
// ''. Both pages have their own token for "everything" — BkBankMatching uses
// the string 'all' because /statements/all is a real endpoint, BkLedger uses ''
// because that is its <option> value — and both translate at their own edge.
// Letting either token into the store is not cosmetic: BkLedger filters rows
// with `String(e.bank_evidence?.statement_id) !== String(stmtId)`, so a scope of
// 'all' matches no row and empties the bank ledger with no error at all.
//
// String, because ids arrive from a URL as strings and from JSON as numbers,
// and every existing comparison in both pages is String(a) === String(b).

import { useSyncExternalStore } from 'react'
import api from '../api'
import { summariseStatement } from './statementLens'

// ── Internal state ───────────────────────────────────────────────────────────

let statementId = null
let statements = []
let statementsLoaded = false
let completion = null // null | 'error' | payload
let completionScope = undefined // which statementId the completion above is for

// Per-id response cache. 'all' is a legitimate key (BkBankMatching's queue-first
// default) and is deliberately never summarised — it is 5.5MB and has no single
// statement to tie against.
const detailCache = new Map()
const inFlight = new Map()

const subs = new Set()

// The snapshot MUST be returned by identity when nothing changed. Building a
// fresh object literal inside getSnapshot is an infinite render loop under
// useSyncExternalStore — React compares snapshots with Object.is.
let snapshot = build()

function build() {
  const detail = statementId == null ? null : detailCache.get(statementId) || null
  return {
    statementId,
    statements,
    statementsLoaded,
    detail,
    detailLoading: statementId != null && inFlight.has(statementId),
    // Memoised with the detail it came from: summariseStatement walks every
    // transaction, and the header re-renders on any store write.
    summary: detail ? summariseStatement(detail.statement, detail.transactions) : null,
    completion: completionScope === statementId ? completion : null,
  }
}

function emit() {
  snapshot = build()
  for (const fn of [...subs]) fn()
}

// ── URL ──────────────────────────────────────────────────────────────────────

// Seeded once, at module load, from ?statement=. Runs before any page mounts,
// so a reload on /bk/bank-ledger?statement=42 lands scoped.
try {
  const seed = new URLSearchParams(window.location.search).get('statement')
  if (seed && seed !== 'all') statementId = String(seed)
  snapshot = build()
} catch { /* no window: the smoke renderer */ }

// MERGES rather than replaces. BkBankMatching writes ?view / ?filter / ?by from
// its own effect; clobbering the whole query string here would drop them.
function mirrorToUrl() {
  try {
    const q = new URLSearchParams(window.location.search)
    if (statementId == null) q.delete('statement')
    else q.set('statement', statementId)
    const qs = q.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  } catch { /* no window */ }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getBankScope() { return snapshot }

export function subscribeBankScope(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function useBankScope() {
  return useSyncExternalStore(subscribeBankScope, getBankScope, getBankScope)
}

/**
 * Select a statement. Pass null / '' / 'all' for every statement — all three
 * normalise to null, so a caller cannot leak its own token into the store.
 */
export function setBankStatement(id) {
  const next = id == null || id === '' || id === 'all' ? null : String(id)
  if (next === statementId) return
  statementId = next
  // The completion figures are scoped, so the old ones are wrong the instant
  // the scope moves. Dropped rather than left stale: a review count that
  // belongs to another month is worse than a moment with no count.
  if (completionScope !== statementId) { completion = null; completionScope = undefined }
  mirrorToUrl()
  emit()
  if (statementId != null && !detailCache.has(statementId)) fetchStatementDetail(statementId)
  fetchCompletion()
}

/** The statement list. One fetch per session — four tabs shared four copies. */
export async function fetchStatements({ force = false } = {}) {
  if (statementsLoaded && !force) return statements
  try {
    const r = await api.get('/statements')
    statements = Array.isArray(r.data?.data) ? r.data.data : []
  } catch {
    statements = []
  }
  statementsLoaded = true
  emit()
  return statements
}

/**
 * One statement's transactions — 0.44s / 703KB for a 436-row month, which is
 * why it is cached and single-flighted rather than re-fetched per surface.
 *
 * Single-flight: the header's effect and the page's own effect fire in the same
 * tick, and without this that is two 703KB reads for one screen.
 *
 * `force` busts the cache after a mutation. Every writer on both pages already
 * re-reads the statement rather than patching locally (the server decides the
 * new disposition), so this keeps that rule at ONE refetch feeding both the
 * header and the table instead of two that can disagree.
 */
export async function fetchStatementDetail(id, { force = false, rethrow = false } = {}) {
  const key = id == null ? 'all' : String(id)
  if (!force && detailCache.has(key)) return detailCache.get(key)
  if (inFlight.has(key)) return inFlight.get(key)

  // `rethrow` exists because the two callers want opposite things on failure,
  // and defaulting either way silently breaks the other:
  //
  //   Bank Matching AWAITS this inside its own try/catch and renders an error
  //   banner. Swallowing the rejection there means `detail` goes null, the
  //   table's `detail && (…)` guard renders nothing, and the page goes blank
  //   with no message — worse than the error it replaced.
  //
  //   The header and the Bank Ledger fire it unawaited from an effect and want
  //   the last good data left on screen. A rejection there is an unhandled
  //   promise rejection, so those pass nothing and get the swallow.
  const req = api.get(`/statements/${key}`)
    .then((r) => {
      const payload = r.data?.data || null
      detailCache.set(key, payload)
      return payload
    })
    .finally(() => { inFlight.delete(key); emit() })

  // The in-flight entry is the SWALLOWING one, so a second caller joining a
  // request it did not start never inherits a rejection it cannot handle.
  inFlight.set(key, req.catch(() => null))
  emit() // detailLoading
  return rethrow ? req : req.catch(() => null)
}

/** Re-read whatever is currently scoped. No-op on "every statement". */
export function reloadBankDetail() {
  if (statementId == null) return Promise.resolve(null)
  return fetchStatementDetail(statementId, { force: true })
}

/**
 * The review-remaining figures. ONE definition — GET /statements/completion is
 * what both the header band and Bank Matching's own Coverage line read, so they
 * cannot disagree about how much is left.
 */
export async function fetchCompletion({ force = false } = {}) {
  if (!force && completionScope === statementId && completion != null) return completion
  const scopeAtRequest = statementId
  try {
    const q = scopeAtRequest == null ? '' : `?statement_id=${scopeAtRequest}`
    const { data } = await api.get(`/statements/completion${q}`)
    // The scope can move while this is in flight. Answering the old question
    // into the new scope is the "19 beside a badge saying 1,765" bug.
    if (scopeAtRequest !== statementId) return completion
    completion = data.data || null
  } catch (err) {
    if (scopeAtRequest !== statementId) return completion
    completion = err.response?.status === 403 ? null : 'error'
  }
  completionScope = scopeAtRequest
  emit()
  return completion
}

/** After a write that could change how much is left to review. */
export function reloadBankCompletion() { return fetchCompletion({ force: true }) }

// Test seam: the DOM harnesses mount a page twice in one process.
export function __resetBankScope() {
  statementId = null; statements = []; statementsLoaded = false
  completion = null; completionScope = undefined
  detailCache.clear(); inFlight.clear()
  snapshot = build()
}
