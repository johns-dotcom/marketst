# TODO — Audit Findings (2026-06-17)

Backlog from the full code audit. Severity tiered. Each entry includes file:line, root cause, and the action to take.

`#1 — Release comments broken` was fixed in commit landing this file.

---

## CRITICAL

### #2 — `EXPENSE_LIGHT_COLS` missing R2 key columns — **already fixed** (all three keys present)
- **Where:** `server/routes/bookkeeping.js:176–193`
- **Bug:** `invoice_r2_key`, `w9_r2_key`, `proof_r2_key` exist on the table but are absent from the column list. Every `expenseCols()` consumer fetches rows without these keys.
- **Impact:** `PUT /entries/:id` pre-edit fetch (line ~710) and `POST /entries/:id/split` (line ~1084) return `undefined` for the R2 keys. Any client building a file URL from the response falls back to `entry.id` instead.
- **Fix:** Add the three keys to `EXPENSE_LIGHT_COLS`.

### #3 — Proof upload skips FX-rate stamp AND split-family cascade
- **Where:** `server/routes/bookkeeping.js:1554–1562` (sync), `1622–1652` (background AI scan)
- **Bug:** `UPDATE expenses SET payment_status = 'Paid'` with no `stampFxRateAsync` call, and `WHERE id = $2` (single row, not the family).
- **Impact:** Proof-uploaded rows never lock their FX rate → live-rate drift forever. On split families, siblings stay Unpaid; Payment Dashboard shows partial payment.
- **Fix:** Call `stampFxRateAsync(entryId)` after the UPDATE. Replace `WHERE id = $N` with the split-family cascade WHERE clause used by `PUT /payments/:id`.

### #4 — DELETE/restore `/bk/entries/:id` ignore visibility allow-list — **FIXED 2026-09-01**
- **Where:** `server/routes/bookkeeping.js:983` (delete), `1002` (restore)
- **Bug:** No `userCanActOnEntry` call. Any authenticated user can soft-delete or restore any expense by ID.
- **Fix:** Wrap both handlers in `findInvisibleEntry` / `userCanActOnEntry` like the approve/reject/payments endpoints already do.

### #5 — Several read endpoints leak data across rep boundaries — **FIXED 2026-09-01**
- Row filter on `/bk/entries`, `/bk/invoices`, `/bk/vendors`; role gate on
  `/bk/analytics`, `/bk/approval-history`, `/bk/w9s` (`/bk/1099` already had
  one). `/bk/vendors/:payee` reads a single vendor a User can already name and
  is left for the same pass as the remaining aggregate routes. Covered by
  `server/scripts/bk-visibility-fixture.cjs`. NOTE: the entry above claimed
  Approvers were the exposure — they are not, `userVisibleRepsClause` is a
  deliberate no-op for them. The exposure was any `User` holding a bk page grant.
- **Where:** `server/routes/bookkeeping.js`
  - `GET /bk/entries` line 416
  - `GET /bk/vendors` line 2478
  - `GET /bk/vendors/:payee` line 2767
  - `GET /bk/invoices` line 4475
  - `GET /bk/w9s` line 4416
  - `GET /bk/1099` line 4441
  - `GET /bk/analytics` line 4352
  - `GET /bk/approval-history` line 4396
- **Bug:** No `userVisibleRepsClause` applied. An Approver scoped to one rep can still enumerate every expense / vendor / artist-level spend through these endpoints.
- **Fix:** Add `userVisibleRepsClause` to each query for non-admin roles. Or gate the analytics + approval-history endpoints behind `isBkAdmin`.

### #6 — Batch and auto-split endpoints have no transaction
- **Where:** `server/routes/bookkeeping.js:580–666` (batch), `536–563` (auto-split on create), `1088–1120` (explicit split)
- **Bug:** Sequential `pool.query()` calls with no `BEGIN`/`COMMIT`/`ROLLBACK`. A mid-loop failure leaves partial state committed.
- **Fix:** Wrap in `client = await pool.connect()` + `BEGIN/COMMIT` like `split-fee-reimb` at line ~1185.

### #7 — Currency-blind SUMs on Financials / Analytics / 1099 / Excel export
- **Where:**
  - `server/routes/bookkeeping.js:4366, 4447, 6400` — `SUM(amount)` across mixed currencies
  - `server/routes/financials.js:135–151` — JS `reduce` without currency conversion
  - `server/routes/bookkeeping.js:4598–4605` — Excel export's local `toUsd` ignores `fx_rate_to_usd`
  - `client/src/pages/Financials.jsx:13` — doesn't import any USD helpers
- **Bug:** Native amounts (EUR + GBP + USD …) added together and displayed as USD. Paid rows in the Excel export recalculate at today's rate, contradicting the locked-rate guarantee.
- **Fix:** Server: compute USD per-row using `COALESCE(fx_rate_to_usd, live_rate)` and sum that. Client Financials: use the items-aware helpers (`fmtUsdItems`, `itemsToUsd`) from `utils.js`.

### #8 — `token_version` not bumped on role/permission change
- **Where:** `server/routes/settings.js:108–188, 256`
- **Bug:** Server-side role/permission updates take effect immediately, but the client's React state holds the stale role+permissions until refresh. Demoted Admin sees full nav until they reload.
- **Fix:** Bump `token_version` (or call `setPagePermissions` over a server-push channel) on role/permission writes — the existing 401 interceptor will force re-login.

---

## MAJOR

### #9 — `PUT /entries/:id` bypasses split-family cascade for payment fields
- **Where:** `server/routes/bookkeeping.js:778–781`
- **Bug:** Inline ledger edits go through the generic PUT and only update the single row. Only `PUT /payments/:id` cascades.
- **Fix:** When payment fields are present in the PUT body, replace `WHERE id = $1` with the same split-family cascade SQL.

### #10 — `PUT /entries/:id`, `POST /entries/:id/split`, `POST /entries/:id/approve` — no visibility check
- **Where:** `server/routes/bookkeeping.js:669, 1067, 2043`
- **Bug:** These mutation endpoints don't call `userCanActOnEntry`. PATCH endpoints already do.
- **Fix:** Wrap in `findInvisibleEntry` / `userCanActOnEntry`.

### #11 — `requirePagePermission` OR-logic enables cross-path bypass
- **Where:** `server/routes/contracts.js:20–22`
- **Bug:** `requirePagePermission('/contracts', '/pending-contracts', '/renewals', '/contracts/create')` passes if ANY one is granted. A User with only `/renewals` (read-only) can hit `/contracts/create` (write).
- **Fix:** Per-route gates, narrowed to the specific page being accessed.

### #12 — `/api/auth/google` has no `loginLimiter`
- **Where:** `server/index.js:158–159`
- **Bug:** `loginLimiter` on `/auth/login` and `/auth/register` only. Google SSO is unthrottled.
- **Fix:** Add `loginLimiter` to the Google route.

### #13 — Login response doesn't include `boom_rep` or `pagePermissions`
- **Where:** `server/routes/auth.js:50–64`
- **Bug:** Stripped user payload from `/auth/login` + `/auth/google`. Client immediately re-fetches `/auth/me`, but there's a ~100ms window where `canView` returns `true` everywhere because `pagePermissions === null`.
- **Fix:** Include `boom_rep` + `pagePermissions` in the login response, OR gate render on `/auth/me` resolution.

### #14 — `Dashboard.jsx` calls a non-existent endpoint
- **Where:** `client/src/pages/Dashboard.jsx:85`
- **Bug:** `fetch(\`${BK_URL}/api/dashboard-summary\`)`. Real endpoint is `/api/bk/dashboard-summary`. 404 silently swallowed; the widget shows null forever. Comment still references Flask.
- **Fix:** Change path to `/api/bk/dashboard-summary`. Update the comment.

### #15 — Calendar feed missing deals
- **Where:** `server/routes/calendar.js`
- **Bug:** Feed includes releases / contracts / DSP / tasks / manual events. Deals are absent. `deals.next_followup_date` never appears.
- **Fix:** Add a deals branch to the union query.

### #16 — `sendPaymentConfirmationEmail` silently swallows errors
- **Where:** `server/services/email.js:432`
- **Bug:** The only email helper that catches without re-throwing. `bookkeeping.js:4031` marks `confirmation_sent = TRUE` even when the send failed.
- **Fix:** Re-throw like every other email helper. Caller already handles errors.

### #17 — User deletion misses `user_visible_reps` and `expenses.boom_rep`
- **Where:** `server/routes/settings.js:217–224`
- **Bug:** CLAUDE.md lists `user_visible_reps` as required cleanup. Also doesn't NULL out `expenses.boom_rep` (free-text name column).
- **Fix:** Add `DELETE FROM user_visible_reps WHERE user_id = $1` and `UPDATE expenses SET boom_rep = NULL WHERE boom_rep = (SELECT name FROM users WHERE id = $1)` to the cascade.

### #18 — ~~Recoupments stat cards double-count split families~~ — NOT A BUG (closed 2026-09-02)
- **The premise was false in both halves.** The parent is not a duplicate of the family: every writer that can split an invoice SHRINKS it to its own slice (`/entries/:id/split` does `SET amount = first.amount`, as do the auto-split-by-song in `PUT /entries/:id` and `/entries/:id/split-fee-reimb`), so parent + children **is** the invoice, counted once. And the Excel export has no `EXISTS` filter — that claim came from a comment in `/bk/export-recoupments` that was wrong from the commit which wrote it (`2b6e136`); no such clause was ever in the query. The page and the export agree exactly.
- **Measured on production 2026-09-02:** 3,534 approved rows, 111 split families, 275 children, **zero** parents still carrying a whole invoice (checked against `artist_breakdown`, the only figure not derived from `amount` itself). Page and export both 1,384 rows / $3,126,376.38.
- **The proposed fix would have caused the bug it described** — dropping parents-of-children removes their slices: **−$47,226.01**.
- **Done instead:** corrected the false comment in `routes/bookkeeping.js` `/bk/export-recoupments`, recorded the invariant at the stat-card boundary in `Recoupments.jsx`, and added `server/scripts/split-family-total-fixture.cjs` (22 assertions, covers both split writers, a re-split, and the unsplit control). Verified it goes red when the `EXISTS` clause is added.
- **Real gap found while verifying, left alone deliberately:** the export uses `excludeBankRows` (drops every bank-born row) while the page uses `withoutUnreviewedBankRows` (drops only unreviewed ones). Latent, not live — 0 reviewed bank rows are recoupable today, so the two tie. The first one that is will appear on the page and be missing from the export. Reconciling them moves a number on an export, so it needs a decision.

### #19 — AI rescan / parse-proof / scan-w9s have no rate limiter
- **Where:** `server/index.js:185–186`
- **Bug:** `aiLimiter` only on `/api/bk/parse`. Bulk upload calls `/api/bk/parse-proof` once per file with no throttle.
- **Fix:** Apply `aiLimiter` (and `uploadLimiter` where files are POSTed) to the three additional endpoints.

### #20 — No activity logging on contracts or deals routes
- **Where:** `server/routes/contracts.js`, `server/routes/deals.js`
- **Bug:** Zero `logActivity` calls. Contract + deal mutations leave no audit trail.
- **Fix:** Mirror the pattern from `releases.js` / `bookkeeping.js`.

### #21 — `POST /entries/:id/approve` rebuilds release-link with stale guard
- **Where:** `server/routes/bookkeeping.js:2043–2051`
- **Bug:** Inline `WHERE e.release_id IS NULL` clause means approval never corrects a stale link from a since-edited artist/song.
- **Fix:** Call the shared `autoLinkRelease()` helper at line 276 instead.

### #22 — `Releases/index.jsx:256` — raw `new Date(release_date)` in notification filter
- **Bug:** UTC-midnight dates shift to the previous day in US timezones. A US user pre-8pm ET on the release day sees the release missing from notifications.
- **Fix:** Use `parseLocalDate` from `Releases/constants.js`.

---

## MINOR

- `exitImpersonation` doesn't await `/auth/me` — `client/src/context/AuthContext.jsx:152`. Race window on return-to-self.
- No startup guard for `JWT_SECRET` — `server/middleware/auth.js:17`. Missing env yields silent 401s.
- Unpaid-after-paid doesn't clear `fx_rate_to_usd` — bookkeeping.js payment-status PATCH. Live rate never re-engages.
- `backfillPaidRows` doesn't exclude voided rows — `server/services/fxStamp.js:91–95`.
- `FxRatesContext` fetches rates once and never refreshes — `client/src/context/FxRatesContext.jsx:33–43`.
- `BkInvoices.jsx:204, 242` shows no USD suffix for non-USD rows. Inconsistent with Approvals/Ledger.
- `QBImport.jsx:147–151` hardcodes `EXPENSE_CATEGORIES` — should import from `../constants`.
- `autoLinkRelease` is fire-and-forget on `POST /entries` and `/entries/batch` (`bookkeeping.js:567, 655`). PUT correctly awaits.
- Activity log filters on `LIKE '%release #N%'` — `server/routes/releases.js:822`. Brittle and unindexed.
- `/sync-images` Spotify loop has no 429 backoff — `server/routes/artists.js:820–856`.
- `historicalCache` keyed by requested date, not returned date — `server/services/fx.js:84, 107`. Wastes API calls on weekend-rolling lookups.
- `Dashboard.jsx:84` fetch has no AbortController. setState-on-unmounted warning on fast navigation.
- Raw `new Date(...).toLocaleString(...)` calls in `Releases/index.jsx:905, 936`, `ReleaseDetail.jsx:443` — should use a shared time formatter.

---

## Recommended fix order

1. **Quick wins next:** #14 (broken dashboard widget), #2 (R2 key drift), #12 (Google rate limit). Each ~5 line change.
2. **Visibility hardening pass:** #4 + #5 + #10. One PR — adds `userCanActOnEntry` / `userVisibleRepsClause` to the missing endpoints.
3. **FX correctness pass:** #3 + #7 + the unpay-unstamp minor. Aligns proof-upload + Financials with the locked-rate guarantee.
4. **Token version + login response pass:** #8 + #13 together — they touch the same area.
5. **Reliability pass:** #6 (transactions), #9 (cascade on PUT /entries/:id), #16 (email error swallow), #17 (user delete FK).
6. **Remaining major items in any order.**
