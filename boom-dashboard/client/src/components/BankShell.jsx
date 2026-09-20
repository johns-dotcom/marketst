// One header over the four banking tabs — the account, the month, and whether
// it adds up.
//
// John, 2026-09-02: "i want to combine the bank matching and bank ledger pages
// and make it more like quickbooks … it just feels messy right now." The mess
// was not the tables. It was that /bk/bank-matching and /bk/bank-ledger are two
// views of ONE bank month and each carried its own month selector, its own
// toolbar and its own idea of how much was left — so moving between them meant
// re-choosing the month and re-reading two different summaries of it.
//
// QuickBooks answers this with one Banking page: the account and its balance
// across the top, then For review / Categorized / Excluded underneath. This is
// that shape, with the constraint this codebase actually has — see below.
//
// ── Why a wrapper around TabbedShell, and not a prop on it ───────────────────
//
// The decisive line is TabbedShell's own:
//
//     if (tabs.length < 2) return children
//
// A user who can reach only one banking tab gets no tab bar. If the header were
// a TabbedShell prop it would vanish with the bar — and the account picker and
// the tie-out are exactly what that user still needs. Composing outward keeps
// it. TabbedShell is left owning the one thing it should own: the bar, with its
// canView/adminOnly filter, its longest-path-wins active rule and that <2 case,
// none of which get a second copy here.
//
// ── Why Tailwind and not getDarkColors ───────────────────────────────────────
//
// This band sits directly above the tab bar, which is Tailwind. Matching the
// component it is welded to matters more than matching either page beneath it —
// a band and a bar drawn by two conventions read as two components, which is
// the problem being fixed. getDarkColors is scoped by CLAUDE.md to the six
// inline-styled Bk pages for pixel-precise table control (frozen columns,
// stripes, row hover); a header has none of that. Both conventions read the
// same CSS variables, so `bg-card` here and `C.cardBg` on the table below are
// the same colour by construction rather than by coincidence.
//
// The band itself is PORTED from BkLedger.jsx, where it was inline in the bank
// half and therefore invisible from the other three tabs. Its three literal
// hexes became semantic classes on the way (#047857 → emerald-700, #e11d48 →
// rose-600, #b45309 → amber-700), which also picks up the dark-mode flat-tint
// those raw values never got.

import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import TabbedShell from './TabbedShell'
import {
  useBankScope, setBankStatement, fetchStatements, fetchCompletion, fetchStatementDetail,
} from '../lib/bankScope'
import { stmtLabel, stmtOptionLabel, fmt } from '../utils/bankDisplay'

// Rules is the one tab with no month. It is standing config — a rule applies to
// every future statement — so a tie-out beside it would invite the reading that
// the rule is scoped to the month showing, which it is not.
const SCOPELESS = new Set(['/bk/rules'])

const money = (v) => Number(v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function BankShell({ children }) {
  const scope = useBankScope()
  const { statementId, statements, detail, detailLoading, summary, completion } = scope

  // From the ROUTER, not window.location. They agree under BrowserRouter, so
  // this looked fine in the app and was wrong anyway: window.location is not
  // reactive, so a client-side tab change would not re-evaluate it, and under
  // MemoryRouter (both DOM harnesses) it reports the wrong page entirely. The
  // Rules variant below silently never rendered until a harness mounted that
  // route and asked for it.
  const { pathname } = useLocation()
  const scopeless = SCOPELESS.has(pathname)

  useEffect(() => { fetchStatements() }, [])
  useEffect(() => { fetchCompletion() }, [statementId])
  // Cached and single-flighted, so this costs nothing when the page below has
  // already asked for the same statement in the same tick.
  useEffect(() => { if (statementId != null) fetchStatementDetail(statementId) }, [statementId])

  const compOk = completion && completion !== 'error'
  // `by_statement` is ALWAYS every statement — the server builds it that way so
  // the selector and the headline read one definition — which also means
  // `left_all` is global even when the request was scoped. So the scoped figure
  // has to be taken from by_statement rather than assumed off left_all: quoting
  // a whole-ledger number beside a one-month picker is precisely the mismatch
  // that once put 19 next to a badge saying 1,765.
  const byStmt = compOk ? (completion.by_statement || {}) : {}
  const here = compOk && statementId != null ? byStmt[statementId] : null
  const leftAll = compOk ? (statementId != null ? (here?.left ?? 0) : completion.left_all) : null
  const leftAllValue = compOk ? (statementId != null ? (here?.left_value ?? 0) : completion.left_all_value) : null
  const leftOf = (st) => byStmt[st.id]?.left ?? st.open_debits ?? 0

  // Counts on the tabs. The rule, and it is worth keeping: a count that is only
  // sometimes available shows only sometimes; a count that always shows must
  // always be right.
  //
  //   For review   /statements/completion — the ONE definition, identical to
  //                the figure in this band and to the page's own Coverage line.
  //                Never `unmatched.length`, which is debits-with-no-entry only
  //                and is what once read 19 beside a badge saying 1,765.
  //   Categorized  the complement, from summariseStatement. Only computable
  //                with a statement selected, so it is absent otherwise.
  //   Statements   files not yet ready — free from the list already held.
  //   Rules        none. A rule count is not a queue.
  const counts = {}
  if (leftAll != null && leftAll > 0) counts['/bk/bank-matching'] = leftAll
  if (summary) {
    const by = summary.moneyOut.by
    const done = (by.booked?.n || 0) + (by.matched?.n || 0) + (by.creator?.n || 0)
    if (done > 0) counts['/bk/bank-ledger'] = done
  }
  const notReady = statements.filter((s) => s.status !== 'ready').length
  if (notReady > 0) counts['/bk/statements'] = notReady

  const ready = statements.filter((st) => st.status === 'ready')

  return (
    <>
      <div data-tour="bank-scope" className="bg-card border border-rule rounded-xl px-3.5 py-2.5 mb-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <select
            value={statementId ?? ''}
            onChange={(e) => setBankStatement(e.target.value)}
            title="Scope every banking tab to one statement — its own lines, and whether the month adds up"
            className={`text-[13px] rounded-lg border px-2 py-1 bg-card ${
              statementId ? 'border-boom-500 text-ink font-bold' : 'border-rule text-gray-600'
            }`}
          >
            <option value="">
              All statements{compOk && completion.left_all ? ` — ${completion.left_all} left` : ''}
            </option>
            {ready.map((st) => {
              // "N left" only where there IS work. Silence on a finished
              // statement is the signal, and it is the same definition as the
              // figure to the right of this control.
              const left = leftOf(st)
              return (
                <option key={st.id} value={st.id}>
                  {stmtOptionLabel(st)}{left > 0 ? ` · ${left} left` : ''}
                </option>
              )
            })}
          </select>

          {/* The tie-out — beginning + credits − debits against the closing
              balance the statement itself prints. The parser already refuses a
              parse that does not reconcile, so agreement here is confirmation
              rather than a fresh claim, and DISagreement means rows changed
              after upload, which is worth saying loudly. */}
          {statementId != null && detailLoading && !summary && (
            <span className="text-[12px] text-gray-400">Reading the statement…</span>
          )}
          {statementId != null && summary && (
            summary.hasBalances ? (
              <span className="text-[11.5px] text-gray-500 tabular-nums">
                opened <b className="text-ink">{money(summary.begin)}</b>
                {' · '}in <b className="text-emerald-700">{money(summary.moneyIn.usd)}</b>
                {' · '}out <b className="text-ink">{money(summary.moneyOut.usd)}</b>
                {' · '}closed <b className="text-ink">{money(summary.end)}</b>{' '}
                {summary.ties ? (
                  <span className="text-emerald-700 font-extrabold"
                    title="Beginning + credits − debits equals the closing balance the statement prints, to the cent.">
                    ✓ ties
                  </span>
                ) : (
                  <span className="text-rose-600 font-extrabold"
                    title="The rows on this statement do not add up to its printed closing balance. The parser reconciles at upload, so a drift here means rows changed afterwards.">
                    off by {money(Math.abs(summary.drift))}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[11.5px] text-gray-400"
                title="This account's statements are parsed without beginning and ending balances, so there is nothing to tie the rows against. Not a discrepancy.">
                no balances on this account's statements — nothing to tie against
              </span>
            )
          )}

          {/* How much is left, and honest about its scope. Quoting a
              whole-ledger figure beside a one-month selector is the mismatch
              this page has shipped before. */}
          {leftAll > 0 && (
            <span className="ml-auto text-[13px] text-gray-500 tabular-nums">
              <strong className="font-bold text-ink">{leftAll.toLocaleString()}</strong>
              {' '}left to review
              {statementId != null && detail?.statement ? ` in ${stmtLabel(detail.statement)}` : ' across every statement'}
              {leftAllValue ? <span className="text-gray-400"> · {fmt(leftAllValue)}</span> : null}
            </span>
          )}
        </div>

        {scopeless && (
          <div className="mt-1.5 text-[11px] text-gray-400">
            Rules are standing decisions — they apply to every future statement and are not scoped to the one above.
          </div>
        )}

        {/* Where the month's lines actually are. The honest part: the bank
            ledger used to show only the booked debits — 1,964 of 3,175 — with
            no indication the rest existed. */}
        {statementId != null && summary && !scopeless && (
          <div className="flex items-center gap-2.5 mt-2 flex-wrap">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">
              money out · {summary.moneyOut.n} line{summary.moneyOut.n === 1 ? '' : 's'} · {money(summary.moneyOut.usd)}
            </span>
            {[
              ['booked', 'booked here', 'text-ink'],
              ['matched', 'matched to an invoice', 'text-gray-500'],
              ['income', 'booked as income', 'text-emerald-700'],
              ['dismissed', 'dismissed', 'text-gray-400'],
              ['open', 'still open', 'text-amber-700'],
            ].map(([k, label, cls]) => {
              const v = summary.moneyOut.by[k]
              if (!v) return null
              return (
                <span key={k} className={`text-[11px] tabular-nums ${cls}`}>
                  {v.n} {label} <span className="text-gray-400">{money(v.usd)}</span>
                </span>
              )
            })}
            {summary.moneyIn.by.open?.n > 0 && (
              <Link to="/bk/bank-ledger"
                className="text-[11px] font-bold text-amber-700 underline decoration-dotted underline-offset-2"
                title="Credits with no answer yet — not booked as income, not dismissed as a transfer">
                {summary.moneyIn.by.open.n} credit{summary.moneyIn.by.open.n === 1 ? '' : 's'} unanswered
              </Link>
            )}
          </div>
        )}
      </div>

      <TabbedShell family="banking" counts={counts}>{children}</TabbedShell>
    </>
  )
}
