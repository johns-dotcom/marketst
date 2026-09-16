> **FORK NOTICE (2026-09-15).** This is the **Market Street** dashboard, forked from
> the Boom Records dashboard's working tree. This guide is Boom's engineering guide,
> kept verbatim because every rule in it still applies: the code is the same code.
> Read every mention of Boom, `boom-ap.com`, `johns@boomrecords.co`, dollar figures,
> row counts and people (Felipe, Jesse, Soli…) as **history**, not as a description
> of this deployment. What is different here is listed in the root `CLAUDE.md`
> ("Fork rules") and `README.md` ("Status"). Login is `john@deanst.co` / `PW_JOHN`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Boom Records admin dashboard — a full-stack web app for managing a record label's releases, artists, contracts, deals, team tasks, bookkeeping, payroll, and recoupments. Live at boom-ap.com, deployed on Railway.

## Tech Stack

- **Frontend**: Vite 5 + React 18, React Router v6, Tailwind CSS v3, Recharts, Lucide React, Axios
- **Backend**: Node.js, Express 4, PostgreSQL (pg library — no ORM), JWT auth, bcryptjs
- **AI**: Anthropic Claude API for invoice parsing, proof-of-payment scanning, W9 validation, contract generation
- **Deployment**: Railway (Nixpacks), monorepo — single push to `main` auto-deploys
- **No TypeScript**. Plain JS throughout.

## Commands

```bash
# Install all dependencies (server + client)
npm install            # runs postinstall hook for both

# Development (run both in separate terminals)
npm run dev:server     # Express on :3001 (nodemon)
npm run dev:client     # Vite on :5173

# Production build
npm run build          # builds client to client/dist/
npm start              # serves Express + React build

# Database
npm run seed           # runs server/seed.js (creates tables + seeds data)

# Render check (from client/) — does the page's component body actually run?
npm run smoke                            # every page changed vs HEAD
npm run smoke -- src/pages/Reports.jsx   # named pages
```

Login after seeding: `johns@boomrecords.co` — password is the `PW_JOHN` value in `server/.env`.
(The old `admin@boomrecords.com` / `admin123` pair is stale; seed.js now provisions the real roster from PW_* env vars.)

### Verifying a deploy landed

```bash
curl -s https://boom-ap.com/health   # poll until .commit == `git rev-parse HEAD | cut -c1-7`
```

`/health` reports `commit` (short `RAILWAY_GIT_COMMIT_SHA`), `started_at`, and
`statement_fast_parse`. **A 200 is not a deploy**: a failed Railway build leaves
the previous version serving behind a green health check, so liveness alone
proves nothing — this is the trap for commits that change dependencies, where a
broken `npm install` fails the build and the app stays healthy on old code.
Server-only commits also change no client bundle, so there is no marker to grep;
before this endpoint existed such a commit was simply unverifiable without
Railway auth. Don't report a deploy as confirmed on anything weaker than the
commit matching.

## Architecture

**Monorepo** with `client/` and `server/` directories. In production, Express serves the React build from `client/dist/`.

### Client (`client/src/`)
- **Entry**: `main.jsx` → `App.jsx` (route definitions + `ProtectedRoute` auth guard)
- **Auth**: `context/AuthContext.jsx` — JWT in localStorage, user state + impersonation + page permissions via React Context
- **Theme**: `context/ThemeContext.jsx` — reactive theme toggle. Inline-styled pages subscribe via `useTheme()` to re-render when theme changes.
- **HTTP**: `api.js` — Axios instance with JWT interceptor + 401 response interceptor (auto-redirects to login on session expiry)
- **Layout**: `components/Layout.jsx` — sidebar nav + main content area + keyboard shortcuts help modal
- **Pages**: `pages/` — one file per route. Most pages are a single `.jsx`; the Release Tracker (formerly "Release Pipeline" — the directory is still named `Releases/`) lives in `pages/Releases/` (index + extracted siblings — see "Page subfolders" below).
- **Hooks**: `hooks/useHotkeys.js` (keyboard shortcuts), `hooks/useUnsavedWarning.js` (beforeunload on dirty forms)
- **Utilities**: `utils/darkColors.js` — returns a JS token object for inline-styled pages (BkLedger, BkPayments, BkApprovals, BkVendors, BkInvoices, BkBulkDeals). Mirrors the CSS variables in `styles/tokens.css`; keep both in sync when adding tokens.
- **Design tokens**: `styles/tokens.css` — CSS variables for both themes (`--color-bg-card`, `--color-text`, `--color-border`, `--color-gray-50…900`, shadows, overlay). Imported from `index.css` ABOVE `@tailwind base`. `tailwind.config.js` maps semantic aliases (`bg-card`, `text-ink`, `border-rule`, `border-divider`, `bg-overlay`) and the whole `gray` palette (`rgb(var(--color-gray-{n}) / <alpha-value>)`) to these vars. Result: `text-gray-900`, `bg-gray-50/80`, etc. are theme-aware natively — no `.dark` override needed. New chrome code should prefer the semantic aliases (`bg-card`, `border-rule`, `border-divider`, `bg-overlay`).
- **UI primitives**: `components/ui/` — `Button`, `Card`, `Input`, `Select`, `Textarea`, `Badge` (+ barrel `index.js`, `Showcase.jsx`). Built on the token layer. Use in new code; existing `.btn-primary` / `.card` / `.badge-*` classes in `index.css` stay for backwards compat and consume the same tokens.
- **Skeleton**: `components/Skeleton.jsx` — shared loading placeholder components (PageHeader, StatCards, Table, Card, Block, KanbanBoard, etc.). Use these instead of bare spinners.
- **SearchableSelect**: `components/SearchableSelect.jsx` — reusable type-to-filter dropdown with keyboard navigation (arrows, Enter, Escape). Used for artist filter on ledger and vendor merge target.
- **Test-user mock adapter**: `mock/mockApi.js` routes every API call for `is_test` users through an axios adapter that returns canned data. **Its response shapes must mirror the real backend** — drift has caused white-page regressions (e.g., array vs `{ data, total }`). When adding or changing any endpoint shape, update the matching matcher.

### Server (`server/`)
- **Entry**: `index.js` — Express app, mounts the route files in `server/routes/` under `/api/*` (37 files as of Aug 2026 — don't trust a hardcoded count here, check `ls server/routes`), creates/migrates ALL tables on startup, serves React build in production
- **Route map**: `auth`, `releases`, `artists`, `team`, `contracts`, `deals`, `dashboard`, `search`, `dsp`, `notifications`, `financials`, `pending-contracts`, `requests`, `activity`, `settings`, `campaigns`, `marketing`, `import` (QuickBooks CSV ingest), `bk` (bookkeeping — the largest router), `vendor` (public vendor submit), `invoices`, `calendar`, `salary`. AI-heavy endpoints are rate-limited via `aiLimiter` + `uploadLimiter`; login via `loginLimiter`; vendor submit via `vendorLimiter`.
- **Database**: `db.js` — pg Pool. SSL is enabled when the connection string asks for it (`sslmode=require`) OR in production, so a hosted dev database works without pretending to be prod. All queries are raw parameterized SQL (`$1, $2...`)
- **Auth middleware**: `middleware/auth.js` — JWT verification with `token_version` session invalidation
- **Security middleware**: `middleware/sanitize.js` (input validation), `middleware/secureUpload.js` (multer config), `middleware/securityAudit.js`, `middleware/errorSanitizer.js`
- **Activity logging**: `middleware/activityLogger.js` — audit trail with IP addresses
- **Services**: `services/email.js` (Gmail API via nodemailer), `services/spotify.js` (artwork fetching + search by name)
- **File storage**: Expense invoice / W9 / proof files live in Cloudflare R2 (S3-compatible). The DB stores only the object key on `invoice_r2_key`, `w9_r2_key`, `proof_r2_key` (filename columns still persisted for display). Receipt files (`receipt_data` base64 TEXT on expenses) and multi-file attachments on deals / contracts / artists / expense receipts (via `entity_files`) are the two remaining legacy paths that have not been migrated to R2. See the "File storage (R2)" section below.
- **W9 cross-entry sharing**: W9s are shared per-vendor, not per-entry. The `w9_entry_id` subquery finds the most recent W9 for a payee across all entries. All pages must use `entry.w9_entry_id || entry.id` when building W9 file URLs.
- **Backup scripts**: `scripts/backup-invoices.js` and `scripts/backup-w9s.js` download files from the API to local Desktop folders. Credentials in `scripts/.env` (gitignored). Scheduled via macOS launchd (1st of month).
- **Activity logger**: `middleware/activityLogger.js` maps HTTP endpoints to human-readable labels. Bookkeeping endpoints are fully mapped (30+ entries). Unmapped POST/PUT/DELETE are logged with raw path as fallback. The standalone Audit Log / History page was folded into Activity (`/activity`, served by `pages/ActivityHistory.jsx` — kept its old filename, but it is now the single activity view; there is no separate history page).

### Bookkeeping System
The bookkeeping is fully integrated into the Express app (NOT a separate Flask app). Key tables:
- **`expenses`** — master ledger table with 40+ columns including payment tracking, vendor info, artist breakdown, file storage, AI scan results, recoupment fields (`recoupable`, `ufr`)
- **`entity_files`** — multi-file storage for receipts (`entity_type = 'expense_receipt'`)
- **`bk_audit_log`** — bookkeeping-specific audit trail (viewable in Approvals page "Recent Activity")

### Who can read and delete what, on /api/bk

Three shapes, and picking the wrong one is how the June audit's #4 and #5 sat
open until 2026-09-01.

**The row filter** — `userVisibleRepsClause(user, params, alias)`. Empty for
Admin / Superadmin / **Approver** (all three are deliberately unrestricted), so
it only ever narrows a `User`. Applied to `/bk/entries`, `/bk/invoices`,
`/bk/vendors` and `/bk/payments`. It had been on `/bk/payments` alone, which
bought nothing: a User granted that page could read the whole ledger through
`/bk/entries` — the endpoint the Payments page itself calls.

**The role gate** — `isBkAdmin` (Admin / Superadmin / Approver). For questions
with no rep-scoped answer: `/bk/analytics` (label-wide spend — a narrowed total
looks like the label's and is not), `/bk/approval-history` (an audit log is only
useful whole), `/bk/w9s` and `/bk/1099` (a W9 belongs to a vendor, not a rep, and
carries legal names and tax status).

**The per-entry check** — `userCanActOnEntry` before a write.
`DELETE /bk/entries/:id` and its restore had NONE, so any account that could
reach `/api/bk/*` could soft-delete any expense by id — and that delete cascades
to the split children and unlinks the bank rows matched to it.

**`isBkAdmin` was never defined in `routes/bookkeeping.js`.** This file's gate is
named `isAdmin`; `isBkAdmin` is the name the docs and one call site use. That
call site is `GET /vendors/:payee/payment-details` — the ONLY route that decrypts
a vendor's bank details — so it threw `ReferenceError` inside its try block and
answered **500 to everybody, Superadmins included**, for as long as it has
existed. Verified against production before the fix; it is now an alias, not a
rename, because `isAdmin` has ~90 call sites here.

**No User holds a bookkeeping page grant today**, so none of this changed what
anybody currently sees — it is a door shut before somebody is handed a key.
`server/scripts/bk-visibility-fixture.cjs` (16 assertions) proves both
directions: the three bookkeeping roles see exactly what they saw, and a
rep-scoped User sees one row where they used to see 28. Against the pre-fix code
it scores 6/16, naming each hole.

### Auth & Permissions
- JWT stored in localStorage, 8-hour expiry. 401 responses auto-redirect to login with "Session expired" message.
- **Impersonation**: Admins can impersonate users — real token stashed in `admin_token` localStorage key
- **Roles**: Superadmin (full access), Admin (most access), **Approver** (semi-admin — full bookkeeping access including the Approvals page; not an admin elsewhere), User (page permissions array). The bookkeeping admin gate lives in `routes/bookkeeping.js` as `isBkAdmin` and matches `Admin | Superadmin | Approver`. The Settings users list sorts by role tier (Superadmin → Admin → Approver → User → other).
- **Public endpoints** (no auth): `/api/auth/login`, `/api/auth/google`, `/api/vendor/*` (the public submit form is `POST /api/vendor/submit`), `/health`, `/privacy`, `/eula`
- **Session invalidation**: `token_version` column — bumping invalidates all tokens for that user

### File storage (R2)

Expense **invoice**, **W9**, and **proof-of-payment** files have been migrated from base64 TEXT columns to **Cloudflare R2** (S3-compatible). The DB stores only the object key on `invoice_r2_key`, `w9_r2_key`, `proof_r2_key`; the original `*_data` columns and `*_filename` columns still exist for legacy reads and display.

- **Client lib**: `server/lib/r2.js` exports `uploadFile`, `getSignedFileUrl`, `downloadFile`, `loadFileBase64`, `loadFileBuffer`, `deleteFile`. The S3 client is built against `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` env vars.
- **Resolution rule**: `loadFileBase64(r2Key, legacyBase64)` and `loadFileBuffer(...)` always prefer R2 when its key is set, falling back to the legacy base64 column. Always pass both — never read one or the other directly.
- **Object key shape**: `vendors/{entryId}/{type}/{timestamp}_{sanitized_filename}` for vendor expense files. `type` ∈ `invoice | proof | w9`.
- **Has-file checks** in list queries must OR both sources, e.g. `((e.invoice_data IS NOT NULL AND e.invoice_data != '') OR e.invoice_r2_key IS NOT NULL) AS has_invoice`. Same pattern for W9 and proof. The W9 cross-entry subquery (line above) follows the same rule.
- **A split CHILD's document lives on its parent**, so a has-file check over family
  members must also OR the parent's (`LEFT JOIN expenses p ON p.id = e.parent_id`),
  or every slice of one invoice reads as missing. `/bk/entries` returns
  `has_invoice` but **NOT** `parent_has_invoice` — the artist-campaigns detail and
  queue endpoints compute it. Measuring "invoices with no file" off `/bk/entries`
  alone over-reports for exactly this reason: it put the campaign backlog at 78
  when it is 23 (2026-08-20).
- **Still on legacy base64 (not migrated)**: `receipt_data` on `expenses` (reimbursement receipts), and the multi-file attachments on deals / contracts / artists / expense receipts via `entity_files`. There are migration scripts at `server/scripts/migrate-to-r2.js` (expenses) and `server/scripts/migrate-entity-files-to-r2.js` (entity_files) — the latter is the path to finishing the migration.
- **Bulk Re-upload page** (`/bk/bulk-reupload`, `BkBulkReupload.jsx`) exists specifically to repair entries whose blobs got truncated before the R2 cutover; surface broken files in one place so they can be re-uploaded into R2.
- **`EXPENSE_LIGHT_COLS` carries the keys, not the blobs.** The `*_r2_key` columns are listed (cheap), the four `*_data` base64 blobs remain the only deliberately-omitted columns. When you add a new R2-backed column, list its key column there.

### The ledger's bulk bar, and the Bank Ledger's own controls

`/bk/bank-ledger` renders **`<BkLedger bank />`** — the same component as
`/bk/ledger`. Every filter, inline edit, split, carve-off, flag, note and row
action has always existed on both halves. What differed was measured (2026-08-20):

    artist   bank half:   53 of 1,972 (2.7%)   invoiced half: 1,414 of 1,478 (95.7%)
    song     bank half:    0 of 1,972 (0.0%)   invoiced half: 1,106 of 1,478 (74.8%)

The invoiced ledger never needed a bulk answer because 96% of its rows arrive
attributed; the bank half is 1,919 rows that name nobody. Neither half had row
selection at all.

**Selection + bulk bar, on BOTH halves.** The checkbox lives INSIDE the single
frozen `<td>` (see below — do not split that cell). Select-all takes the
**filtered** set, not the ~150 painted rows, and the bar states the difference
("31 below the visible rows") — a bar reporting only what is on screen while
writing to everything is how this page shipped a wrong total before.

**`POST /bk/entries/bulk { ids, field, value }`** — one field, many rows.
- **A whitelist** (`BULK_FIELDS`), never a column name from the body. `amount`,
  `payment_status`, `status`, `deleted`, `payee` are all refused.
- **`payment_status` is excluded on purpose**: it cascades to a whole split family
  in a transaction, so bulk-setting it over a selection holding two children of
  one parent would run that cascade twice. Needs its own design.
- **`ufr` is excluded too** — `/entries/ufr-bulk` owns it, because the flag is
  half the write: `ufr_marked_at` decides which monthly statement the item rides
  on, and a generic column write would land every item in no period at all.
- **A comma in a bulk `song` is refused.** The single-row PUT auto-splits on a
  comma; across a selection that is hundreds of unasked-for child rows with no
  single undo. Splitting stays per-row.
- `autoLinkRelease` runs per row on artist/song, as the single-row PUT does, or
  release links depend on how you typed the edit.
- Returns `previous: [{id, value}]` — one bulk action is ONE undo, and a row that
  already held the new value never enters it, so undo cannot "restore" a value it
  never had. `revertBulk` regroups by old value, so a mixed selection is two or
  three calls rather than hundreds.

**Vendor attribution reuses `POST /statements/artist-rules`** (`BulkVendorPanel`),
which had been built for task #28 and left with **no client caller** — the UI went
away in the dead-surface cleanup while `GET /statements/unattributed` kept
returning 252 vendor groups / 1,214 rows / $1,759,152.75, top 12 vendors = 81.6%.
Do not write a second artist-attribution path. That route's two properties are
why it is the right one: it writes **history by expense id** and keeps the
**pattern only for future statements** (a pattern is a substring test — "TONE"
$615k is inside "Tone Pay, Inc"), and `is_overhead` is a real answer that writes
nothing and stops the vendor being asked again.

**Booked rows can be answered from the row.** The `matchPop` popover gained
Attach-an-invoice (`/tx/:id/rematch`, one call — `/tx/:id/match` refuses a booked
row, so client-side unbook-then-match would delete the entry if it failed
between), Unbook and No-invoice-needed, all pre-existing routes. Gated on
`canUnmatch` (Admin/Superadmin) because every one is `isStrictAdmin` server-side.
The `Inv wanted? · yes` cell opens the same popover — it used to read "work it on
Bank Matching", which was the detour.

**Bank-half column defaults now match the ledger's.** `BANK_MODE_HIDDEN` survives
as a one-click preset ("Hide what a bank row never fills") because it is measured:
nine of those columns hold a value on ZERO of 1,972 bank rows, Email on one, and
Terms/Campaign? on all of them only because the columns default to 'Net 30' and
'Yes'. The four document cells are why the default changed — they are where a
late-arriving invoice goes. **The bank storage key is versioned**
(`bk_bank_ledger_hidden_cols_v2`): the old key holds what an earlier default
wrote, not a choice, so reading it would show the old view forever.

### The Bank Ledger's statement lens

The page listed `expenses` where `entry_source='bank_statement'` and nothing else,
which meant it showed **1,964 of 3,175 debits — 61.9% of the bank** (measured
2026-08-20). The rest: 749 matched to invoices ($2,538,887, they live on the
invoiced half), 429 dismissed ($278,525), 33 open ($23,552) — the last two
appearing nowhere in the app. "What left the bank in June" answered 263 of 392
rows, $305,941 of $976,548.

Selecting a statement now merges that statement's own transactions in.

**`client/src/lib/statementLens.js`** owns the rules, extracted and pure so they
are tested in node against a real `/statements/:id` payload rather than by eye:

- `dispositionOf(t)` — **booked** (an entry the app invented: `match_method =
  'created'` plus an expense id) / **matched** (a real invoice, whose expense is
  on the INVOICED half) / **income** / **dismissed** / **open**. Order matters:
  `dismissed` wins over a stale `matched_expense_id`, and `created` is checked
  before a bare expense id because a booking is not a match.
- `summariseStatement()` — both directions, every disposition, and the tie-out
  `beginning + credits − debits = ending`. March 2026 computes $429,915.76 against
  a stored $429,915.76. **Ties on `drift === 0`, not the parser's 0.02 tolerance**
  — that tolerance exists for numbers just read out of a PDF; these rows are
  already in the database, so a cent of drift is a cent that does not add up. The
  first fixture run reported a planted cent as "ties" and this is the fix.
- `extraTransactions()` — the lines with no editable row here. A booked line whose
  row is *not* on screen (deleted entry, or a filter hides it) is still listed,
  because the alternative is a page claiming to account for a month while hiding
  one of its lines.

**No new server endpoint.** Reads are `GET /statements` and `GET /statements/:id`
(0.44s / 703KB for a 436-row month — per-statement, not the 5.5MB
`/statements/all`). Writes are the pre-existing `/statements/tx/:id/{dismiss,
match, unbook, book-income, unbook-income}`; `dismiss` takes `{ undo: true }`.

**The ledger stays expense-driven.** A transaction row carries no category,
artist, song, notes or recoupable, so driving the table from transactions would
strip the editable cells off 319 of March's rows. Ledger rows come from
`/bk/entries?source=bank` as before and join to transactions on
`bank_evidence.txn_id`. Everything else renders as a **reduced row**:
`ExtraTxRow`, with **no inline editors and no bulk checkbox** — there is no
expense id, so an editor would `PUT /bk/entries/undefined` on blur and a checkbox
would feed `/bk/entries/bulk` an id it cannot use. The checkbox slot is left
empty rather than disabled.

**Money in.** An Out · In · Both toggle, defaulting to Out. 523 credits worth
$6,064,037 were invisible here (59 booked as income, 460 dismissed as transfers,
4 unanswered). Booking one uses a **picker off the live income vocabulary** —
`useIncomeCategories()`, per the categories-are-data rule — because
`isKnownIncomeType` refuses an unrecognised type rather than coercing it, and a
coerced typo would look like a successful booking onto the wrong P&L line. **In
and out are subtotalled apart and never netted**: a single net figure over a bank
month is neither what was spent nor what the balance did, and the balance is
already in the header.

`beginning_balance` / `ending_balance` exist only on BofA statements; all four
live PayPal ones have a null beginning and a 0.00 ending, so those say there is
nothing to tie against instead of failing a check for a reason that is not a
problem.

### The ledger shows what the vendor actually submitted

John, 2026-09-01: *"all information thats submitted via the vendor form should
have its own column in the ledger. also in the ledger bulk appears twice."*

Most of the form already had a column — payee, email, address, bank, socials,
artist, song, amount, currency, category, rep, terms, the four documents. The
rest of it had none, and lived only on Approvals or nowhere: the vendor's own
spelling of their name, their CC addresses, and the whole payment block (account
type, name on account, last 4, wire scope, bank address, beneficiary address,
intermediary bank, PayPal handle), plus whether their invoice AGREED with the
details they typed, whether the artist they named was off-roster, and how many
supporting files came with it. Thirteen columns, grouped under **Vendor form** in
the Columns menu with a one-click "Show everything the vendor submitted".

**All default OFF.** Thirteen more columns on by default pushes Amount off the
right of a 1440px screen; the ask was that the data be reachable, not that the
table become unreadable.

**READ-ONLY, unlike the vendor-contact columns above them.** These record what
somebody stated when they asked to be paid, and the bank fields are mirrored in
an encrypted profile the ledger has no write path to — an editable cell here
would let the two disagree with no way to tell which is true.

**Account and routing numbers, IBANs and SWIFT codes are deliberately NOT
columns.** They never land on the invoice: single-copy and encrypted in
`vendor_payment_details`, reachable only through an admin route that writes an
audit row PER READ. A column would fire that audit for every rendered row and put
a bank account number in every screenshot of the page. Last 4 says which account
a payment pointed at; the full value stays one deliberate click away.

**They are empty on every row that exists today, and the menu says so.**
`payment_snapshot` started being written on 2026-08-31 and the newest production
submission (#4723, 18:13 UTC) predates that deploy, so all 383 live vendor rows
have a null snapshot — verified against production rather than assumed. Nothing
falls back to the vendor's current profile to fill the gap: that would print
today's account onto an invoice from March, which is the confusion the
per-invoice snapshot exists to prevent. Blank means "submitted before we asked".

**A split CHILD shows its family's answers.** The submission belongs to the
invoice; children are our own internal division of it and carry none of these
fields, so each cell resolves through the parent or every split row would read as
a vendor who answered nothing.

Two fields are not on `expenses` and are joined in `/bk/entries`:
`vendor_cc_emails` (from `vendor_emails`, keyed by vendor NAME and alias-aware
through the same `alias_pairs` the W9 lookup uses — sampled 2 of 20 live vendor
payees have one) and `vendor_file_count` (the `entity_files` rows labelled
`Vendor invoice attachment`, counted apart from `receipt_count` so an
admin-added reimbursement receipt is not reported as something the vendor sent).

**"Bulk" appeared twice** because the Source cell's BULK chip and the `Bulk Deal?`
column say the same thing. The chip now renders only when that column is hidden —
which is the common case, since Source defaults on and `Bulk Deal?` defaults off.
Turning the column on is exactly what makes the chip redundant.

**`npm run ledgervendor-dom`** (from `client/`) covers all of it — 30 assertions
against a fixture of what the CURRENT form produces (ACH parent + split child,
international wire, PayPal, bulk row), because no such row exists in any database
yet and a harness pointed at real data would render thirteen empty columns and
call them verified. It checks the columns are off by default, that the preset
turns the block on, that every value renders, that the child inherits, and that
the Source chip yields to the column and comes back. Verified it can fail on both
halves of the task: blanking one column's value and restoring the always-on chip
each turn it red.

### Ledger Frozen Columns
The ledger (`BkLedger.jsx`) uses a single-cell sticky column approach for frozen columns (bulk checkbox, flag, Date, Payee, Artist, Amount, Currency). All frozen data renders inside ONE `<td>` with an internal flex layout to avoid sub-pixel gaps. This is intentional — do NOT split back into separate sticky cells. Widths live in `FW`; anything added there must also be added to `frozenTotal` and to the TOTAL row's spanning width, or the footer stops lining up with the columns.

### AI-Powered Features
- **Invoice parsing** (`POST /api/bk/parse`) — extracts fields from uploaded invoices
- **Proof-of-payment scanning** — auto-runs in background when proof is uploaded via ANY page. Extracts payment date, reference number, and marks entry as paid.
- **W9/W8 cross-check** — compares tax form against submitted vendor info on vendor submissions
- **Invoice discrepancy detection** — compares invoice document against form data on vendor submissions
- **Vendor name suggestions** — fuzzy match on payee field (`GET /api/bk/suggest-vendor?q=...`)
- **Similar invoice detection** — normalizes invoice numbers (strips `#`, `INV-`, leading zeros) to catch duplicates like `#003` vs `003`
- **W9 name mismatch detection** — batch-scans W9s and flags vendors where legal name doesn't match payee (smart about middle names, initials, and business names on line 2)
- **Artwork sync** — searches Spotify by artist + title for releases without a Spotify URI
- **Auto-link releases** — matches expense artist + song to `releases.project_name` + `artists.name` on create/update
- **AI validation rate-limited** — vendor submit AI endpoints limited to 5/min/IP

### Salary System
Standalone `salary_employees` table (not tied to `users`). Seeded on startup with payroll roster. `salary_payments` tracks paid status per employee per month. `salary_payment_history` logs every toggle (who, when, action) for audit.

### Bulk Deals
Bulk deals are expenses with `is_bulk_deal = true`. Tracked via `bulk_deal_quantity`, `bulk_deal_unit`, and `bulk_deal_items` table (deliverables with completion tracking). `bulk_deal_completed` boolean archives finished deals to a collapsible "Completed" section on the Bulk Deals page. Bulk deals support artist splits via the same `artist_breakdown` / `parent_id` pattern as regular invoices.

### Payment Terms Default
All new entries default `payment_terms` to "Net 30" across all creation paths: `POST /api/bk/entries`, `POST /api/bk/entries/batch`, and `POST /api/vendor/submit`.

### Vendor Submit Form
**One submission can carry up to TEN invoices** (2026-09-15), and **STEP 2 IS
THE LIST**. Documents holds the W9 once at the top, then one row per invoice —
its document, its number, its own supporting files — with "+ Add another
invoice" underneath. Step 3 then pages through the project questions one
invoice at a time, with a "Invoice 2 of 4" header, prev/next, and a chip per
invoice that goes green when that one is complete.

**The document and its number are adjacent on purpose.** The server compares
what was typed against what the AI reads off THAT file, so the two must be
unmistakably about each other; "additional files" floating at the bottom of the
step would be ambiguous the moment there are two invoices, which is why they
live inside the row.

**The first build put "Add another invoice" at the end of step 3** and banked a
completed invoice into a card list. John, looking at step 2: *"i feel like it
should be in step 2."* He was right, and the reason it had not been is worth
recording: banking needs a COMPLETE invoice and artist/amount/category live on
step 3, so on step 2 the button could only ever have been disabled. The fix was
to invert it — a row exists as soon as it has a file, and completeness is
checked per invoice on the way out of step 2 and again at Submit.

**ONE invoice still posts the payload it always posted** — `file`,
`invoice_number_hint`, `amount` and the rest at the top level — and that is the
common path, not a fallback. Several post an `invoices` JSON list plus
`invoice_file_${i}` / `invoice_extra_${i}` / `invoice_receipt_${i}`. Indexed keys
rather than one repeated name, for the same reason `file` and `file_extra` are
separate: which document belongs to which invoice must never depend on the
order the browser sent them.

**NOTHING IS WRITTEN UNTIL EVERY INVOICE PASSES.** John's call: a batch where one
fails writes none of them. The server validates all of them — required fields,
the invoice-number gate against each document, a document per card — before the
first INSERT, and returns `invoice_errors: [{index, label, errors}]` so a refusal
lands on the card it belongs to. `error` and `errors` keep their exact previous
shape and wording; with one invoice the message is unprefixed, byte-identical to
what 190 vendors and 74 fixture assertions already read.

**Category, currency and Boom rep carry from the previous invoice** when a
fresh one is opened on step 3 — five invoices are almost always five of the same
kind of work for the same rep. Everything the AI said about another document
does not: each row keeps its own `parsed` result, so paging to invoice 3
pre-fills from invoice 3's document and not from whichever was read last.

**The W9 goes on the FIRST row only** — W9s are shared per vendor through
`w9_entry_id`, so copying the filename onto five rows would claim five documents
where one was uploaded. Socials and the payment block are collected once and
copied onto every row; `payment_check` is computed PER invoice, because one of
five documents may print the vendor's account details and the other four may
not.

**The cap is a refusal, never a truncation.** Eleven invoices are refused by
name, saying the limit and how many arrived — silently dropping two would show a
success page for a submission that lost two bills. One multer field slot past the
cap is declared on purpose so that refusal is reachable: with exactly ten, an
eleventh died as `LIMIT_UNEXPECTED_FILE` ("too many files"), which is the wrong
sentence for the wrong problem.

The public vendor submit form (`/submit`, `VendorSubmit.jsx`) is a 3-step wizard:
1. **Your Info** — name, email (+ optional CC emails), payment method, and the full payment block for that method (see "collects what it takes to PAY" below). No mailing address and no standalone bank name since 2026-08-31.
2. **Documents** — invoice number, invoice file (AI-validated), optional additional files, W9/W8 (if not on file, checks aliases), receipt (for reimbursements)
3. **Project Info** — artist, song, amount, category, currency, boom rep, notes. Pre-filled by AI parse of the uploaded invoice between steps 2→3.

**Critical**: `isReimb` (derived from `mode`) must be defined BEFORE `canAdvanceStep2` in the component body — not inside the render block. The `amount` field from AI pre-fill can be a number; always wrap in `String()` before calling `.replace()`.

**Duplicate invoice numbers do NOT block a submission** (changed Aug 2026).
They used to, in three places — `canAdvanceStep2`, a `goToStep3` guard, and a
server 409 — all on the same test: same vendor, same *normalized* invoice
number. That test rejected real invoices. `normalizeInvoiceNum` strips leading
zeros, so `001` / `01` / `1` are one number (88 live entries share `1`, 40
share `2`), and prefix-only numbers — `#`, `INV-`, `-`, `.`, `inv`, `No.` — all
collapse to `0`. Identity matched on email OR name OR payee with no amount
check and no time bound, so a vendor who restarts numbering annually was
blocked permanently and told to email us, meaning the invoice never arrived.
**393 pairs already in the ledger would have been refused**; they got in via
paths with no such gate, which is the tell that it protected nothing.

The collision is now surfaced on **Approvals** as a RED `possible_duplicates`
flag, computed per request in the `/bk/approvals` route — not a stored column,
so it covers pre-existing rows and clears itself if the other entry is deleted.

It was amber until John called it "a big flag" (2026-09-15). Amber on this page
means "look at this before you approve" — an off-roster artist, a W9 we do not
hold. Red means "this could take money out of the building twice", and a
repeated invoice number is the only flag here that carries that consequence.
It uses the SAME tokens as the AI-discrepancy banner rather than a new shade,
or the page ends up with two reds that both mean "serious" and neither means
anything. The payment-details `changed_from` banner beside it stays amber.
`/check-dup` still warns the vendor before they submit; it just no longer
refuses on their behalf, matching the posture `/check-similar` always had.
This is a DIFFERENT rule from the document-vs-form gate below, which stays.

**Invoice-number gate**: Both Step 2→3 (`goToStep3`) and the final `POST /api/vendor/submit` block when the entered invoice number doesn't match the one printed on the uploaded document, or when the document has no invoice number at all. Server-side enforcement uses `extractInvoiceNumberFromDocument` (a focused single-field AI call), then compares using `normalizeInvoiceNum` (stripped `#` / `INV-` / leading zeros — same normalizer as `routes/bookkeeping.js`). AI failure falls open on both layers; the existing background `scanInvoiceForDiscrepancies` still flags discrepancies for admins as a backstop. Don't relax this gate without thinking about the spoofed-invoice path that motivated it.

### Creator payments can be unpaid, and the list must SAY so

`/bk/creators`. Two things were wrong together, and they compounded:

1. **`GET /api/creators` did not select `payment_status`**, and the page branches
   on it — `recoupState` is "payment_status is not 'Paid', therefore unpaid". So
   all five live creator payments rendered **Unpaid** while being Paid in the
   database. Omitting a column the client branches on is the same class of bug as
   omitting one from `EXPENSE_LIGHT_COLS`.
2. **Rows were created `payment_status = 'Paid'` unconditionally**, date defaulting
   to today. So "we owe this creator" was unrecordable, and nothing could be
   marked paid because everything already was.

Both fixed 2026-08-27. `paidState(body)` is the one resolver, used by `POST /` and
`POST /batch`; **PAID stays the default** because the payment is usually made and
then logged, and flipping that would turn every existing habit into an unpaid
pile. `PUT /:id` accepts `payment_status` ('Paid' | 'Unpaid', validated).

**`payment_status` and `payment_date` MOVE TOGETHER**, which is why the PUT writes
them outside the whitelist loop and skips `payment_date` when the status is
moving: Paid with no date, or a date on an unpaid row, reads one way to
`recoupState` and another to every date-bounded report. The list patches the row
locally rather than refetching — it sorts by `payment_date`, so a refetch would
reorder it under the cursor the moment a row is marked.

**"Deal name" is gone** from the batch form. It only ever landed in
`description` and nothing read it back out; `POST /batch` now ignores the field
even when sent.

### The approvals checklist, and what each answer WRITES

`components/ApprovalChecklistDeck.jsx` + `validateApprovalChecklist` /
`writeApprovalChecklist` in `routes/bookkeeping.js`. Four confirmations (artist,
song, amount, category) and three yes/no answers, and the answers are not just a
record — each one writes a column, inside the approval's own transaction so the
stored checklist and the row it describes cannot disagree.

    bulk_deal   → is_bulk_deal
    cobrand     → cobrand, and FORCES category = 'Marketing' (cobrand spend IS
                  marketing spend, so the deck re-arms the category tick when
                  this answer changes — otherwise an approver confirms
                  "Services" and the row saves as Marketing)
    recoupable  → recoupable          (added 2026-08-27)
    campaign    → artist_campaign     (added 2026-08-27, TEXT 'Yes' / 'No')

**Cobrand yes MEANS campaign yes.** The second implication that answer carries:
`impliedCampaign` in `validateApprovalChecklist` treats campaign as ANSWERED when
cobrand is true, and `writeApprovalChecklist` forces `artist_campaign = 'Yes'`, so
a client sending `cobrand: true, campaign: false` does not get to store the
contradiction. The checklist records `campaign_implied_by_cobrand` so the record
says WHY it is yes. Note this differs from the category rule on purpose: category
is RE-ARMED (the approver confirms it again, because they might have wanted
something else and cannot have it), campaign is simply SET (there is nothing to
reconsider). The deck disables the campaign buttons while cobrand is yes, and
answering cobrand NO releases campaign rather than leaving a yes nobody chose.

**Both halves are required, client and server.** `CHECKLIST_ANSWER` is the one
list; the deck's `complete` and the server's `validateApprovalChecklist` read the
same three keys, and a non-boolean is not an answer.

**Why `recoupable` belongs here specifically.** `expenses.recoupable` is
`BOOLEAN DEFAULT TRUE`, so a row reads recoupable whether a person decided it or
nobody ever looked — 1,292 rows read recoupable by default and only the 179
marked NOT recoupable ever took an act. That asymmetry is why no recoupable total
in this app can be *proved*, and asking at approval is the only thing that closes
it going forward.

**A read-only Socials section** sits under the answers: the handles the vendor
submitted (`social_handles`, `[{platform, handle}]`, on 319 live rows). Not a
question — they are the vendor's own handles, not a judgement — but approval is
the last point anybody looks at the submission whole, and a wrong handle is what
makes campaign spend unverifiable later. A vendor with none types the literal
"N/A" (the submit form has required an answer since 2026-08-26), so "they told us
none" and "blank" are DIFFERENT and render differently. Handles link out only for
platforms whose URL shape is known; the rest are plain text rather than a guessed
domain.

**Nothing is pre-selected from the stored value**, for all four. The column
default is not an answer, and offering it as one would be the same "nobody
looked" wearing a tick. The stored value appears only as CONTEXT, and which value
is informative differs by column: `is_bulk_deal` defaults FALSE so only true
means something; `recoupable` defaults TRUE and `artist_campaign` defaults `'Yes'`
so for those only the **negative** does. Live: 3,221 rows read `'Yes'` against
242 `'No'`, and all 46 pending approvals read `'Yes'`.

Adding an answer breaks any fixture that posts a complete checklist —
`scripts/w9-review-fixture.cjs` had to gain `recoupable`. That is the intended
blast radius of a required field, not a reason to make it optional.

### Correct artist? is a picker, not a box you retype a name into

John, 2026-09-15: *"in the invoice reviews, the correct artist section should be
a dropdown of the roster (typable)."* The checklist's four confirmations were a
category `<select>` and three bare `<input>`s, so the only way to fix an artist
was to retype it — and retyping is how "manila killa" ends up beside "Manila
Killa" as a second artist with its own spend, on the one screen where the name
is actually decided.

**`ArtistSelect` already existed and already does this** — filterable, portalled,
and it renders a stored value the list has never heard of. Reports, Bank
Matching, Artist Campaigns and BkVendors all moved to it; the approval checklist
was the one left behind. So this is a swap, not a new control.

**It still takes a name nobody has heard of.** `expenses.artist` is free text and
vendors submit off-roster artists — there is an `off_roster_artist` flag and this
very page warns about them — so a picker that could only offer the roster would
refuse the case the page already handles. Typing one IS the assignment; no
roster row is created, or every typo becomes a permanent artist needing a merge.

**The list is `/bk/artist-names`, never `/artists`.** The second is the SIGNED
ROSTER (50 names) while the ledger holds ~107, so "the roster" taken literally
would leave the artists with actual spend unpickable — the measurement is in
that endpoint's header. What the field offers is the roster UNION the names
already in use, placeholders excluded.

**`hooks/useArtistNames.js`** is new, and exists because this is the FIFTH
caller and the first one that is a shared component with two hosts (the Approvals
deck and Add Invoice, which files as `approved` without passing through the
queue). Writing the fetch there would have been the fifth and sixth copies.
Module-level cache with in-flight dedupe — the deck mounts every time somebody
opens it, and the list only changes when an artist is signed. A failed fetch
returns `[]` and is **not cached**, so one blip does not cost the picker for the
session; the control degrades to what the field was before, a box you type into.
Converting the four existing pages is a separate change and buys nothing visible.

Covered by **`cd client && npm run approval-dom`** — which is also new: the
harness (`approval-deck-dom-entry.jsx`) had no runner and was driven by hand with
a `SCENARIO` env var, so it was only ever run by whoever had just written it.
Four scenarios now: `socials`, `split`, `splitbad`, `artist`. The new one asserts
the field is a button and not an input, that typing filters, that picking writes
the **canonical** spelling over the row's lowercase drift, that the edit un-ticks
the confirmation, and that an off-roster name still saves. **Verified it bites:**
reverting the field to a plain input turns 3 red, and emptying the roster
response turns 3 red (while confirming the typable fallback still works).

**The runner refuses to pass on an empty scenario**, which is not hypothetical —
its first version had `SCENARIO` where it meant `scenario`, the spawn threw with
a null stdout, and four scenarios that printed nothing reported **ok**. "No
`-> false` in an empty string" is the shape that makes a broken harness look like
working code.

### Vendor submit collects what it takes to PAY, not just what to book

Until 2026-08-26 the form asked for a payment *preference* (ACH / Wire / PayPal)
and a bank *name*. The account number, routing number, IBAN and PayPal handle
existed **only inside the uploaded PDF** — paying a vendor meant opening their
invoice — and an invoice that did not print them was **refused**, with the vendor
told to edit the document and re-upload. That refusal was the wrong answer to
"the vendor forgot something on their invoice".

**`server/lib/payment-fields.js`** owns the per-method required set and the
validators (ABA **checksum**, not just nine digits — a mistyped routing number
otherwise fails days later or pays someone else; IBAN/SWIFT shape; PayPal email
or @handle, 3+ chars). Pure, and shared by the route and the fixture, so the rule
a vendor is held to is the rule that is tested. The browser has its own copy of
the field LIST for rendering only.

**`server/lib/payment-crypto.js`** — AES-256-GCM, key in `PAYMENT_DETAILS_KEY`,
random IV per value, authenticated so a tampered ciphertext fails rather than
decrypting to something plausible. **`encrypt` THROWS with no key and the route
returns 503**: the alternatives are plaintext in a column named `_enc`, or a
success page having dropped what the vendor typed. **So the env var must exist
BEFORE this code deploys**, or the public form starts refusing submissions.

**`vendor_payment_details` is keyed on `LOWER(vendor_email)` and nothing weaker.**
Vendor identity everywhere else resolves through names and `vendor_aliases`,
which is right for grouping invoices and exactly wrong here — a name collision
that pre-fills one vendor's bank details into another's form is not a mistake
anyone gets to make twice. `GET /api/vendor/payment-on-file` is PUBLIC and
therefore confirms without disclosing: method, last 4, holder name, never a
decrypted value. `GET /api/bk/vendors/:payee/payment-details` is the only route
that decrypts, is `isBkAdmin`, and writes a `bk_audit_log` row **per read** —
a change is visible in the data afterwards, a read leaves no trace unless one is
made deliberately.

**The document scan stopped refusing and became evidence.** `payment_check` on
the entry (JSONB, mirroring `w9_review`) records `match` / `mismatch` / `absent` /
`unscanned`, plus `changed_from` when the vendor's details differ from what we
held. Only **mismatch** and **changed_from** surface on Approvals; match and
unscanned are silent, because a banner on every row is noise. The anti-fraud
property the old blocking rule protected is kept where it counts: a document that
DOES carry details and disagrees with the form is now visible, which it never was.

**A returning vendor confirms rather than re-types.** `payment_reuse_on_file` is a
FALLBACK, not a bypass: it only resolves when a stored record exists for that
exact email and its method matches, and anything typed always wins over it.

**Rules the browser enforced are now enforced on the server too** — a song for
every artist row, at least one artist, a social handle (or a literal "N/A"). They
lived only in `VendorSubmit.jsx`, which makes them requests, not rules: measured
on production, **11 rows with no song (3.1%) and 35 with no socials (9.9%)** got
in through paths with no such gate. Proven before the fix: a direct POST with no
song, no socials and no payment details returned **200** and reported it would
create the row.

### The form collects what it takes to FILE a payment, not just identify one

2026-08-31. The payment block above stored enough to **identify** an account —
number, routing, IBAN, holder, last4 — and not enough to **file** one. An ACH
batch carries a different transaction code for checking than for savings (the
wrong one is a returned payment) and needs the receiving bank; a wire needs the
beneficiary's own address and sometimes a correspondent bank. All of it lived
only in the PDF: the same gap the payment block was created to close, one layer
in. Proven against the pre-change module — ACH with no account type, bank name
or bank address returned **`ok: true`**, as did a Wire with no account number,
bank name or beneficiary address.

Required set now, in `server/lib/payment-fields.js`:

    ACH               account number, routing number (ABA checksum),
                      account type, name on account, bank name, bank address
    Wire Domestic     routing number (ABA), account number, name on account,
                      bank name        (bank + beneficiary address OPTIONAL)
    Wire International  IBAN or SWIFT/BIC, name on account, bank name, bank
                      address, beneficiary address
                      (account number CONDITIONAL, intermediary bank OPTIONAL)
    PayPal            email or handle

### A wire is two instruments wearing one name

John, 2026-08-31: *"sometimes wires just need routing and account."* He was
right, and the flat Wire list was wrong. A **domestic US wire** is an ABA routing
number plus an account number — Fedwire identifies the bank from the ABA, so
there is **no IBAN and no SWIFT to give**. Demanding them was the same
required-field-with-no-correct-answer bug that pushed bank name out of step 1,
one field along: a US vendor either invents something or gives up.

So the vendor is asked **where their bank is** first, and *alone* — the rest of
the block is the answer to that question, and nothing else renders until it is
answered. The refusal for a missing scope deliberately does **not** mention an
IBAN; the fixture asserts that, because mentioning one is the confusion the
branch exists to remove.

`FIELDS_BY_METHOD.Wire` **no longer exists** — read it and you get `undefined`,
on purpose, so a caller that has not been taught about the scope fails loudly
rather than silently requiring nothing. Use **`fieldsFor(method, values)`**.

**The account number is CONDITIONAL on an international wire.** An IBAN already
*contains* it, so asking twice is a box with no new answer; a SWIFT/BIC names
only the bank, so without an account number the payment has no destination.
Required only in the SWIFT-without-IBAN case, on both the server and the form.

**`primaryValue` for a Wire falls back to the account number.** A domestic wire
has no IBAN, so without the fallback `payment_last4` was null for every one of
them — and a null last4 means `changed_from` can never fire, which is the one
thing that makes a swapped account visible.

**The document comparison branches too.** A domestic wire prints a routing and
account number, which the extraction reports as `ach_account_number` — there is
no IBAN on the page. Comparing against `wire_swift_or_iban` returned `absent` for
every domestic wire, which reads as "the invoice was silent" when the invoice
said exactly what it should.

**The US 4-to-17-digit account rule must never reach an INTERNATIONAL wire.**
Foreign account numbers carry letters and run longer, so borrowing the ACH check
would refuse correct details. It *does* apply to a domestic wire, which is a US
account by definition. Both directions asserted in the fixture.

**Two fields left step 1**, for different reasons. **Bank name** MOVED into the
payment block, where it is required for ACH and Wire and absent for PayPal — as
a top-level field it was demanded of PayPal vendors who have none to give, and a
required field with no correct answer is how a column fills up with "n/a".
`vendor_bank` is still written, now from `payment_bank_name`. **Mailing address**
was DROPPED at John's request; the form asks for one address, not two.
`vendor_address` still exists and is still READ — Vendor Address in
`full-export.js`, the vendors roster's `MAX(vendor_address)`, the
returning-vendor pre-fill — so new rows leave it **NULL** rather than take a BANK
address, which is the bank's and not the vendor's. **A 1099-NEC needs the
recipient's address.** If that becomes binding, put the field back as optional or
read it off the W9; do not alias one address to the other.

Account numbers, routing numbers and IBANs are **never written to the
localStorage draft**. Bank name is. An abandoned draft on a shared machine should
not be a copy of somebody's bank details.

### The profile is an address book; the invoice needs a shipping label

`vendor_payment_details` is a **PROFILE** — one row per vendor, overwritten on
every submission (`ON CONFLICT DO UPDATE`, no history table). That is right for
paying somebody today and wrong for reading an invoice from six months ago: by
then the card has been rewritten, and "which account did THIS invoice go to?"
could only be answered with "wherever they bank now".

**`expenses.payment_snapshot`** (JSONB) is the label. Built by
**`buildPaymentSnapshot()`** in `lib/payment-fields.js` — pure, and the only
place the shape is made, because the route stores it, `changed_from` embeds the
previous one, and the fixture asserts against it.

**What is deliberately NOT in it: the account number, the routing number, the
IBAN.** Those stay single-copy and encrypted in the profile. Copying a secret
onto every invoice row multiplies the blast radius of a key compromise by the
number of invoices and buys nothing — `last4` already says WHICH account a row
pointed at, and the full value is one lookup away for the one caller allowed to
decrypt it. **The fixture asserts no account or routing number appears anywhere
in a snapshot or in a `changed_from`.** Do not add one.

JSONB rather than six sparse columns because the shape genuinely differs by
method (ACH has `account_type`; Wire has `wire_scope`, beneficiary and
intermediary), nothing filters on it, and this is the pattern `payment_check`,
`w9_review`, `ai_scan` and `social_handles` already follow.

`last4` is **dropped for PayPal**: for an email handle it is the last four
CHARACTERS, so `a@b.com` masks to `.com`, which identifies nothing while looking
like a real masked value. The handle itself is the identity and is not a secret.
(`payment_last4` on the entry has the same quirk; that column is long-standing
and compared against elsewhere, so it is left alone.)

**`changed_from` carries the full previous snapshot**, not `{method, last4}`.
"Something changed" is a weaker claim than "it used to be Chase checking in
Jane's name", and the second is the one an approver can act on — redirected-
payment fraud is exactly a change of these fields. Approvals renders a
was/now diff of only the fields that differ.

**Split children inherit `payment_check`, `payment_last4` and `payment_snapshot`.**
They previously inherited none of the three, so splitting a $10k invoice three
ways left three rows with no payment record and the only row that had one was the
parent nobody opens. Copied at the split rather than resolved to the family root
on read: children are immutable after creation so a copy cannot drift, and every
future reader gets it without being taught the family rule.

**None of this is a general ledger.** There is no journal table; approving flips
`status` from `pending` to `approved` on the same row. The snapshot is a
prerequisite for a real GL rather than a substitute — a double-entry posting
would reference exactly this record.

### Multiple files can come with one invoice

`file` stays `maxCount: 1` and stays the PRIMARY invoice — the document the AI
parse reads, the one `extractInvoiceNumberFromDocument` judges the typed number
against, and the one `invoice_r2_key` points at. Making that key a list would
have quietly changed **which document the anti-spoofing gate checks**. Supporting
files arrive under `file_extra` instead, so which document is judged never
depends on upload order.

**That rule now holds one level down as well.** A multi-invoice submission gives
each invoice its OWN primary under `invoice_file_${i}` and its own attachments
under `invoice_extra_${i}` — never one field carrying N documents, for exactly
the reason above. `file` / `file_extra` / `receipt_file` still mean INVOICE 1.

They are stored as **`expense_receipt` rows in `entity_files`** — the same type
the per-entry attachments list already uses, which already has serve and delete
routes (`/api/bk/entries/:id/receipts`) and somewhere it renders. A new
`expense_invoice` type would have been tidier to name and invisible to every
existing reader until three more surfaces were taught about it. `label` is
`'Vendor invoice attachment'`, which is what tells them apart. Writing them is
best-effort: the primary invoice is already in R2 and the vendor has been told it
arrived, so a lost attachment is a loud log, not a failed submission.

**`EXTRA_FILE_MAX = 9` exists in two places and they must match** — the constant
in `VendorSubmit.jsx` and `file_extra`'s `maxCount` in the route. Multer rejects
the ENTIRE request when the count is exceeded rather than dropping the overflow,
so a mismatch does not lose extras, it fails the submission. The browser
truncates at the cap for that reason. Upload errors are now caught and returned
as **400 with a sentence** (`fileFieldsSafe`); they used to reach the global
handler as a bare 500, which tells a vendor nothing — and Cloudflare would eat a
5xx body anyway.

`vendorLimiter` is **10/hour/IP in production and not configurable there**;
outside production `VENDOR_SUBMIT_LIMIT` can raise it, because the fixture needs
more than ten submissions and a throttled run is worse than no run — a 429 writes
nothing, so "nothing was written" assertions pass vacuously against it.

### Two vendor-form surfaces, and the sandbox is GENERATED

    /submit             the real thing. PUBLIC (App.jsx checks the pathname
                        before the auth guard). Writes.
    /admin/vendor-lab   a COPY, admin-only, submits to ?sandbox=1. Writes
                        nothing.

`/admin/vendor-preview` — the real form, admin-only, which still WROTE — was
deleted 2026-08-27; `App.jsx` redirects the path to the lab so old links land
somewhere that answers the same question without creating an approval.

**Build in the sandbox FIRST, then promote it.** That is what it is for.

```bash
cd client
node scripts/sync-vendor-lab.mjs --promote   # sandbox  → live form
node scripts/sync-vendor-lab.mjs             # live form → sandbox (mirror)
node scripts/sync-vendor-lab.mjs --check     # says they differ, and where
node scripts/sync-vendor-lab.mjs --diff      # the full diff, in live-form terms
node scripts/sync-vendor-lab.mjs --force     # mirror, discarding sandbox work
```

**`--check` used to claim it knew which one was ahead, and it did not.** Its test
is "they differ and the inversion is clean", which is true when the SANDBOX is
ahead and equally true when the LIVE FORM is. On 2026-09-15 the live form carried
an uncommitted fix the lab did not have and `--check` reported *"the lab is AHEAD
— promote it"*; following its own advice would have promoted the lab over that
fix and deleted it with no diff left to read. Nothing in either file says which
edit happened later, so it now reports that they differ, prints the first
divergence, and offers `--diff` — the decision is the person's who made one of
the edits. `--promote` and `--force` are unchanged; neither is recommended blind.

Both directions apply ONE list of named deltas — the component name, the
`?sandbox=1` endpoint, the always-on admin tools, the banner — read
left-to-right to mirror and right-to-left to promote. There is a single
definition of how the two files differ, so the trip out and the trip back cannot
drift. **Everything outside those four regions is carried across verbatim**,
which is why a change tried in the lab arrives on the live form as the same
change rather than a re-typing of it. Do not hand-edit the four delta regions
themselves: `--promote` anchors on them and fails loudly rather than guessing
(verified — tampering with the banner names the exact delta and writes nothing).

**Each direction has its own post-condition, and they are opposites.** Mirroring
must produce a page that CANNOT write. Promoting must produce one that can, that
does not carry the SANDBOX banner, and that does not hardcode `adminPreview =
true`. Any of those three surviving a promote would put a page on `/submit` that
**works and lies** — validating and reporting success while writing nothing,
telling a vendor nothing was submitted while it submits, or handing every vendor
the skip-validation toggle. That is worse than a crash, so it is checked on the
OUTPUT, not the input.

**The mirror direction refuses to run while the lab is ahead.** It used to
overwrite silently — and the old `--check` failure message told you to run
exactly that command, so following the tool's own advice discarded the
experiment. `--force` is the way to discard on purpose.

The hand-copy drifted exactly as its own header predicted — by 2026-08-27 the
sandbox was missing the whole payment block and still carried a refusal the real
form had dropped, so **the sandbox refused submissions the live form accepted**,
which is the worst possible state for the only page you can look at to see what
vendors see. It is now made by applying a short list of NAMED, ANCHORED deltas;
if an anchor stops matching the script exits non-zero and says which delta broke
rather than writing a half-converted file.

Normal loop: edit `VendorSubmitLab.jsx`, try it at `/admin/vendor-lab` on
`:5173` where submissions write nothing, then `--promote` and push. Nothing
reaches public `/submit` until that deploy.

Originally this script only mirrored, which made the lab a *preview* rather than
a sandbox: the one thing you could not do was try a change there first. The
mirror direction still exists for when the live form moved first.

### Does the form actually RENDER? (`npm run vendorform-dom`)

```bash
cd client
npm run vendorform-dom     # builds the harness, runs 4 scenarios x 2 pages
```

**`npm run smoke` was not enough for this page and will not be.** Smoke runs the
component BODY — but the payment block is `{paymentPref && …}` and the file list
is inside `{step === 2 && …}`, so *none* of that JSX is ever constructed. A green
smoke plus a green `vite build` proves the module parses and says nothing about
whether choosing "ACH" renders six fields or throws.

This mounts the form under jsdom and drives it: picks a method, reads the fields
back, walks to step 2, attaches three files, removes one. Scenarios are
`ach | wire | wiredom | paypal | files | multi`, each run against **both** `VendorSubmit` and
`VendorSubmitLab` — the lab is where changes are built now, and the four sync
deltas are supposed to leave the fields untouched, so this is what checks that.

204 assertions as of 2026-09-15. **Verified it can fail:** deleting the ACH bank
address from the lab turned 2 of the scenarios red (and caught the knock-on —
step 1 then refused to advance, so the file list was never reached) and exited 1;
posting every invoice's document under one key, and banking an invoice without
clearing the form, each turn `multi` red. A check nobody has seen fail is a check
that goes green the day it stops working.

**`multi` declares two invoices on step 2, pages step 3 across them, and then
reads the PAYLOAD**,
because the half of this feature that can silently break is not on screen: a list
can render four cards and post one. Three traps it hit while being written, all
worth knowing before adding a scenario that reaches step 3:

- **`GET /api/reps` returns STRINGS** (`rows.map(r => r.name)`) and the form does
  `BOOM_REPS.map(r => <option>{r}</option>)`. The api stub returned
  `[{id, name, active}]`, which throws *"Objects are not valid as a React child"*
  and blanks the page — and had gone unnoticed because **no scenario had ever
  rendered step 3.** Same class as the `mockApi.js` parity rule.
- **Typing in the roster picker is not picking.** The artist is assigned when a
  row is clicked, and the row commits on **mousedown** (the list closes on blur,
  so a click never lands). Without that the form sits on "an artist or project"
  with the name visibly in the box.
- **`mywork-dom-check.mjs` copies jsdom's `window`/`document` onto globalThis but
  NOT `FormData`/`File`/`Blob`**, so the page builds a **Node** FormData, and
  Node's FormData stringifies any value that is not a Node Blob. A jsdom `File`
  went in and came back out as the 13-character string `"[object File]"` — which
  still passes a truthy check, so the payload assertions reported the files
  present and their names null. Build files with `globalThis.File`.

`jsdom` is deliberately NOT a dependency — it is a large tree and this is an
occasional diagnostic. `npm init -y && npm i jsdom` anywhere; the runner finds
`/tmp/domtest` by default, or set `JSDOM_PATH`.

Harness files: `scripts/vendorform-dom-entry.jsx` (the scenarios),
`scripts/vendorform-dom-api-stub.js` (only the providers' axios client — the
public form uses bare `fetch`, which the entry stubs), `scripts/vendorform-dom-run.mjs`
(runs all 8 and greps its own output for `-> false`). The vite config is shared
with the My Work harness via `ENTRY` / `API_STUB`.

**Gotcha:** `/api/vendor/roster` returns an array of **strings**. `rosterIndex`
does `name.toLowerCase()` over it directly, so stubbing it with objects throws on
first render and looks exactly like a broken page.

### Running the vendor fixture

`server/scripts/vendor-required-fixture.cjs` is the proof that the required set is
enforced by the SERVER. It needs **two** servers and a raised limiter, because
`vendorLimiter` is 10/hour/IP with an in-memory store and **a 429 writes nothing,
so every "nothing was written" assertion after one passes vacuously** — the
fixture aborts on 429 rather than reporting green.

```bash
cd server
PORT=3011 VENDOR_SUBMIT_LIMIT=500 node index.js &                       # normal
(PAYMENT_DETAILS_KEY= PORT=3012 VENDOR_SUBMIT_LIMIT=500 node index.js &) # keyless, for the 503 case
node scripts/vendor-required-fixture.cjs        # 74 assertions as of 2026-08-31
node scripts/vendor-multi-invoice-fixture.cjs   # 41 assertions as of 2026-09-15
```

**`vendor-multi-invoice-fixture.cjs`** pins the batch: the legacy single-invoice
shape still means invoice 1 with unprefixed wording, three invoices are three
rows with three numbers/amounts/artists/documents, one 400 lists every bad card
by index, two cards cannot share an invoice number (while "001" and "1" stay two
numbers — normalizing them is what got the cross-submission check removed), the
cap refuses rather than trims, and **a batch that dies mid-write leaves NOTHING
behind**. That last one is the assertion that bites: R2 is unconfigured in dev so
a real submission always reaches `stage: r2_upload_invoice` and throws — after
all three rows are INSERTed — so rolling back only the row in flight leaves two
on Approvals under a response that said the submission failed. Verified: the
single-row rollback scores 40/41 and names it.

**One builder makes the row, read by both the INSERT and the `?sandbox=1` dry
run** (`expenseRowFor`). They were two hand-written field lists, which is exactly
the arrangement where a sandbox reports three correct invoices while the INSERT
writes the first one three times — proven by breaking the INSERT's indexing and
watching every sandbox assertion stay green. With the shared builder the same
break turns 4 red.

**The vendor-level write must stay BEFORE R2.** The first version folded the
inserts and the uploads into one pass, which moved the `vendor_payment_details`
upsert after the upload — and in dev, where every upload throws, the vendor's
details stopped being stored at all. Ten assertions in the OTHER fixture went
red, all from that one reordering. The handler now runs three passes: every
INSERT, then the vendor-level write, then the files.

Boot from `server/` so dotenv reads `./.env` and it runs against the dev database.
Section 4 asserts the real (non-sandbox) submit reaches R2 and **fails there** —
that 500 at `stage: r2_upload_invoice` is the expected result in dev, not a
regression.

**`POST /api/vendor/submit?sandbox=1`** runs every check the real submission runs —
required fields, email format, `normalizeInvoiceNum`, the duplicate lookup, the
off-roster artist test, and the `extractInvoiceNumberFromDocument` gate — then
returns the row it WOULD have written. The branch sits after the gate and before
the `INSERT`, deliberately: a sandbox that skipped the anti-spoofing check would
teach the wrong thing about the form. It reports `not_exercised` rather than
implying success — the INSERT column list, the R2 upload and the emails are not
rehearsed, and `/admin/vendor-preview` is where those get tested.

**It requires a token**, unlike the rest of `/api/vendor/*`, via a `sandboxAuth`
wrapper that applies the shared `middleware/auth` only when `sandbox=1`. It writes
nothing, but it spends real Anthropic calls getting there, and a public
AI-spending endpoint is a bill a stranger can run up. The wrapper sits before
multer so an anonymous sandbox request is refused without buffering 10MB first.

**`VendorSubmitLab.jsx` is scaffolding, not a fork.** 1,600 lines of copy that will
drift; the intent in its header is that changes which work get ported into
`VendorSubmit.jsx` and the lab is re-copied or deleted. Nothing else may import
from it. Not factored into one component with a `variant` prop on purpose — that
puts every experiment one prop-check away from the live public form.

**Testing anything through `/api/vendor/submit` hits `vendorLimiter`: 10 per hour
per IP.** Once it trips, every call returns 429 — and "nothing was written"
assertions then pass TRIVIALLY, because a refused request writes nothing either. A
fixture run reported 13 passes against four 429s before this was caught. Any
fixture against this route must abort on 429 rather than grade it. The limiter's
store is in-memory, so restarting the dev server clears it.

**The W9 gate works, and the coverage number is easy to get wrong.** W9s are shared
per VENDOR via `w9_entry_id`, not per entry, so counting `has_w9` per row reports
51.4% when the real figure is **406 of 418 submissions (97.1%)** — and one vendor
over the $600 1099 threshold lacks one, not forty. `POST /api/vendor/submit`
enforces it server-side for a new vendor ("Please upload your W9 or W8 form"), not
only in `canAdvanceStep2`.

**The badge and the gate are ONE resolver — `vendorHasW9OnFile` — and that is not
tidiness.** Three surfaces ask "do we hold this vendor's W9": the form's green
"W9 on file" badge (`/lookup`), the legacy `/check-w9`, and the gate in
`POST /submit`. They disagreed until 2026-09-14, and the disagreement was a DEAD
END rather than an inconvenience, because the badge is what removes the W9
dropzone from the page. A vendor was shown "no need to resubmit", advanced past
step 2 on the strength of it, and was then refused for not attaching a form the
page rendered no field for. Unfinishable by any route, and the 400 is recorded
nowhere — so the invoice never arrived and nobody here knew it had been tried.

The gate resolved aliases ONE WAY. Given a PRIMARY name, its

    SELECT va.primary_name FROM vendor_aliases
     WHERE LOWER(va.alias) = LOWER($1) OR LOWER(va.primary_name) = LOWER($1)

matched on the `primary_name` side and handed back the name it was passed, so the
follow-up query was a verbatim repeat of the direct check that had already
failed: **a primary name's aliases were never searched.** A W9 filed under
"Foreign Exchange Records" did not cover "Chase Mann", though the badge said it
did. Two smaller divergences rode along — the gate matched `LOWER(payee)` where
the badge matched `LOWER(TRIM(payee))`, and it required `w9_filename` to be
non-null where the badge (and Approvals) only require the file, which no longer
matches how W9s are written post-R2.

`HAS_W9_SQL` is imported from `lib/w9-owner` rather than retyped, so this route
cannot drift from the `has_w9` Approvals reports. Matching stays on **payee OR
vendor_name** (that module tests payee alone — internally-added invoices often
fill only one) and is DELIBERATELY not filtered on status: a W9 on a rejected
invoice is still a W9 we hold, and filtering would refuse submissions the badge
had already promised — the same failure in a new place.

The client now also believes the server on this: a refusal naming the W9 clears
the badge and returns to step 2, so a future transient disagreement is
recoverable instead of terminal.

`server/scripts/w9-onfile-fixture.cjs` (13 assertions) asserts the two endpoints
**AGREE**, not that either is true alone — that is the property that broke, and a
test of one would have stayed green. No submissions, so no AI spend and no
`vendorLimiter`; it seeds its own vendor and deletes it even on failure.
**Verified it bites:** 9/13 against the pre-fix code, naming
`lookup=true check-w9=false`.

```bash
cd server
PORT=3011 node index.js &
node scripts/w9-onfile-fixture.cjs
```

### Bulk Upload
The bulk upload page (`/bk/bulk-upload`, `BkBulkUpload.jsx`) handles batch invoice processing:
1. **Upload** — two drop zones for invoices and proofs of payment (PDF/JPG/PNG)
2. **Parse & Match** — sequential AI parsing via `/api/bk/parse` and `/api/bk/parse-proof`, auto-matches proofs to invoices by payee + amount
3. **Review** — editable table with manual proof matching via dropdown
4. **Submit** — batch creation via `POST /api/bk/entries/batch` with embedded base64 file data

### Bulk Re-upload
Distinct from Bulk Upload. `/bk/bulk-reupload` (`BkBulkReupload.jsx`) is a **repair page**, not a batch ingest — it lists existing expenses whose stored file blobs are missing/truncated and lets you re-upload the originals into R2. Use this page when invoice/W9/proof previews fail because the blob never made it into R2 cleanly. Do not point users here for normal new-invoice batch workflows — that's Bulk Upload.

### Expense Lookup
The expense lookup page (`/bk/lookup`, `BkLookup.jsx`) is for finding invoices/receipts by artist or song:
- Primary search: Artist + Song fields with expanded filters (Vendor, Category, Date range)
- Results table with inline file preview buttons (Invoice, Receipt, Proof, W9)
- Export: CSV (client-side), Excel (server-side via `/api/bk/export-lookup`), and per-type file downloads (Invoices ZIP, Proofs ZIP, W9s ZIP) via `/api/bk/download-files?types=invoice`

### The 1099 run: the two fields that make it filable, and the workbook

`GET /bk/1099` computed the money correctly for a while — cash basis by
`payment_date`, alias-folded so a vendor under two spellings is one recipient,
`usdOf` with the locked rate, reimbursements reported as an explicit exclusion,
the OBBBA $2,000 threshold for 2026 — and could not produce a filing, for two
reasons that had nothing to do with arithmetic:

* **you cannot file without a TIN**, and nothing had ever read one. 299 vendors
  have a W-9 on file; the scan extracted name, email and address only.
* **corporations are generally not 1099-reportable**, and without W-9 line 3
  every reportable vendor needed checking by hand. Measured 2026-09-01: 222
  reportable vendors for 2026, $6,121,632, and the endpoint honestly reported all
  222 as needing that check — a number that could never go down.

**`lib/w9-tax.js`** owns the extraction contract and the rules, pure: one prompt
that reads form type, name, line 3, the LLC letter, the TIN *as printed* and
whether it is signed. As printed matters — the punctuation is what says whether
nine digits are an SSN (`###-##-####`) or an EIN (`##-#######`), and the filing
needs that. Nine digits is checked, and all-identical digits refused; a bad read
becomes an entry on the chase list, never a filing.

**The exemption is never a silent drop.** `exemptionFor()` returns a reason that
travels with the row, and the page and the workbook both show it. The exception
that makes a blanket "skip corporations" wrong is encoded: **attorney and medical
payments to a corporation are still reportable**, so a C-corp law firm stays IN
the run with `corp_but_reportable` and a note. An LLC is a pass-through unless it
wrote C or S in the box — which is exactly why the form asks.

**`POST /bk/vendors/scan-w9-tax`** reads the forms already on file, 10 per call,
resumable on `remaining`, driven in a loop from the page. Separate from
`/vendors/scan-w9s` because that endpoint's skip rule (`w9_scan IS NULL`) is what
makes it resumable and re-reading 299 forms to collect two more fields would pay
the AI bill twice. A read that finds no TIN still **stamps** `w9_tax_scanned_at`,
or the batch hands back the same unreadable form forever and the loop never ends.

**The TIN is the second thing in this schema that is encrypted** (same
AES-256-GCM as the bank details). `w9_tin_enc` is DELIBERATELY not in
`EXPENSE_LIGHT_COLS` — the fifth column that list omits on purpose and the only
one omitted for being sensitive rather than huge. `w9_tin_last4` is what screens
show. `GET /bk/vendors/:payee/tin` is the one route that decrypts, admin-only,
and writes an audit row per read; the audit line records that a TIN was read,
never the value.

**`GET /bk/1099/export`** is the deliverable: four sheets, because a 1099 run is
four questions. **Filing** is one row per vendor per FORM — rent is 1099-MISC
box 1, royalties box 2, everything else NEC box 1, so a vendor paid rent and fees
gets two rows rather than one row in the wrong box. **1096 Summary** is the
per-form totals a transmittal needs. **Needs attention** is the chase list in the
same workbook. **Excluded** says who was left out and why, and also lists the
corporations that stayed IN — somebody scanning for "why is this one not
excluded" should find the answer rather than assume an oversight.

TINs are **masked by default**. `include_tin=1` is Admin/Superadmin only, writes
the real numbers, and logs the export naming the row count — that file is a
spreadsheet of social security numbers and creating one should be a deliberate
act with a trace.

**`/bk/1099` (the page)** exists because the numbers had none: three tabs in the
order the questions get asked (who gets a form, what is stopping us, who is out),
the W-9 read button, and both downloads. **It sits under Vendors** as a tab of
the `vendors` family (`TabbedShell`, third family after `import` and
`recoupments`) — one sidebar row for who we pay and which of them the IRS needs a
form about.

Done with a tab family rather than a sixth view on the directory's own `?tab=`
strip, and the reason is permissions, not looks: **both paths stay**, so a grant
on `/bk/vendors` admits the directory and NOT the tax data. A query-param view
could not express that distinction, and reportable totals plus tax
classifications are not what somebody asked for when they were given the vendor
directory. The cost, taken deliberately: two strips on the directory — the family
bar above the page's own five worklists. John chose that shape over the single
strip on 2026-09-02 with the trade-off stated.

`/bk/vendors/:vendorName` and `/bk/vendors/added-expenses` stay OUT of the
family, exactly as `/recoupments/:artistName` does: a vendor's own page is a
destination reached from the directory, not a sibling tab of it.

**The W-9 opens from the page.** Reading the form is what settles the two things
the list cannot tell you — is that TIN right, and is line 3 what we recorded —
so the W-9 column is a View button rather than a tick. The id comes from
`w9_entry_id`, resolved server-side through `lib/w9-owner` (`w9OwnersFor`), which
is the app's one definition of the alias walk: a form filed under a legal name
covers the trading name and the reverse. **Never build that URL from the vendor's
own paid entry** — that is the `entry.w9_entry_id || entry.id` rule, and getting
it wrong opens somebody else's tax document. The harness asserts the id in the
fetched URL, not merely that a button exists, and pointing it at another entry
turns it red.

Using `w9OwnersFor` also made `w9_on_file` STRICTER than the DISTINCT-over-payees
it replaced: it skips rejected entries. That is the definition every other
surface already uses, so the 1099 page now agrees with Approvals and the vendor
list instead of holding its own opinion. Measured across the change on
production: `missing_w9` 106 before, and the count after is in the deploy notes —
if it moved, it moved because a rejected entry's W-9 stopped counting as the
vendor's document.

Note the order the resolution runs in: it takes the payee list as input, so it
has to come AFTER the rollup that produces it. The first version read `byVendor`
above the loop that fills it — a temporal-dead-zone throw on every request, and
`node --check` passes on it happily.

Covered by `server/scripts/tax1099-fixture.cjs` (41 assertions — the rules, the
bucketing, the workbook's sheets and boxes, and that the masked export does not
leak) and `client/npm run tax1099-dom` (19 — the page's bucketing and that no
full TIN reaches the DOM). Both verified to fail when the thing they check is
broken. Note the masked-leak assertion had to be rewritten to PARSE the
workbook: an .xlsx is a zip, so grepping its bytes for a TIN passes whether or
not one is in there, and the first version passed for that reason.

**A W-9 arrives by four routes, and `services/w9Tax.js` is the one writer.**
Only the backfill used to read the tax fields, which meant every form arriving
from that day onward waited for somebody to re-run a chore — a feature that
needs a chore to stay true quietly stops being true. Now:

    a vendor submits one       routes/vendor-submit.js  (same read, two answers)
    an admin uploads one       POST /bk/entries/:id/file/w9
    somebody presses rescan    services/aiScan.js rescanW9
    the backfill over old ones POST /bk/vendors/scan-w9-tax

Two of those were ALREADY reading the form to compare it against what the vendor
typed, so they ask for the tax fields in the same Claude call
(`W9_TAX_PROMPT_FIELDS` appends them to both prompts — one contract, so the four
paths cannot drift on what they ask for). A second call per submission to fetch
two more fields off a page already being read would pay the bill twice.

The W-9 upload route read **nothing** before: only proof and invoice uploads
triggered a scan, so an admin attaching a chased form — the ordinary way a late
W-9 arrives — left that vendor unfilable. It reads in the background now, after
the file is safely in R2, so a failed read is a log line rather than a 500.

**The write is COALESCE, never overwrite, and that is load-bearing.** A re-read
that cannot make out the TIN is not evidence the earlier read was wrong, and a
blanked TIN silently moves a vendor back onto the "cannot file" list. Proven:
swapping the COALESCEs for plain assignment turns two fixture assertions red.
It always stamps `w9_tax_scanned_at` — that stamp is what makes the batch
terminate, and "we looked and it does not say" is a different state from "nobody
has looked", which the page shows differently.

With no `PAYMENT_DETAILS_KEY` the classification and last-4 are still stored and
the number is **not** — not in plain text, not silently dropped, with a loud log.
Unlike the vendor payment block this refuses in the background rather than with
a 503: a vendor's submission must not fail because an env var is missing on the
day they filled the form in.

### Vendor System
- **Aliases**: `vendor_aliases` table maps alternate names (DBA, business name) to a primary vendor. The vendor submit W9 check respects aliases — if "Eddie Marange" is an alias for "Edward Marange", submitting as Eddie skips W9 upload if Edward has one on file.
- **Merge**: `POST /api/bk/vendors/merge` renames all source expenses to target,
  auto-adds source as an alias, **and repoints `statement_payee_map.ledger_payee`
  from source to target**. Returns `{ merged, relinked }` — both, because a
  bank-only vendor merges 0 entries and moves N bank links, and reporting only
  `merged: 0` made a successful merge look like a no-op.

  **The bank repoint is load-bearing.** Without it the merge left
  `statement_payee_map` naming the name it had just merged away, and
  `/bk/vendors/unified` synthesized a **ghost company row** for that dead name —
  0 invoices, real bank total — so the merged-away vendor reappeared on every
  refresh and merging looked broken. 68 such rows existed ($173,508 of bank
  spend) before Aug 2026, including two spellings of one artist that had been
  merged twice.
- **Alias resolution goes through `lib/vendor-aliases.js`** (`loadAliasIndex` →
  `canonical()`), never a local `Map(alias → primary)`. That shape is one-hop and
  last-write-wins; 48 of 193 alias rows have an alias that is itself a
  primary_name, so `A→B→C` silently stops at `B`. `/bk/vendors/unified` was the
  last holdout and is now converted. When resolving a bank group to a company,
  try the exact name, then `canonical()`, then **any member of the alias class**
  — `canonical()` picks the most-often-primary name, which is not necessarily the
  member holding the invoices, and missing on it drops the group into "Unlinked",
  moving bank money out of the directory.
- **`statement_payee_map` still holds ~130 rows naming a vendor that is now an
  alias of another** ($1.93M of bank links). Deliberately not migrated: the
  directory resolves them through aliases, and `loadMatchContext`
  (`routes/statements.js`) loads the payee map *and* the alias groups, so the
  matcher already treats the two names as one vendor. Don't assume the table is
  clean, and don't "fix" a reader by adding a second alias resolver.
- **Rename**: `PUT /api/bk/vendors/rename` updates payee across all expenses for a vendor.
- **Split invoices**: On vendor detail pages and the invoices list, child entries (`parent_id`) are hidden and parents show the combined total. Vendor detail has expandable split groups.

### Fee + Reimbursement Split
For invoices that are part fee and part reimbursement, the Ledger has a "Carve off reimbursement" action (Receipt icon, next to the Split button) on each non-reimbursement entry. It calls `POST /api/bk/entries/:id/split-fee-reimb` with multipart `{ fee_amount, reimb_amount, receipt_file }`. Server-side: parent stays as the fee portion (its `amount` is reduced; `is_reimbursement` stays false; its receipt fields are cleared), and a single child row is created with `is_reimbursement = true`, the reimbursement amount, and the receipt attached as `receipt_data` (still on the legacy base64 path — receipts haven't been migrated to R2). The parent's `artist_breakdown` JSON is set to `[{...fee, is_reimbursement:false}, {...reimb, is_reimbursement:true}]` so `DELETE /entries/:id/splits` continues to unsplit it correctly. Refused if the entry already has children, has a parent, or is itself a reimbursement.

### Auto-Split on Multiple Songs
When the song field on a ledger entry is updated to contain **comma-separated** songs (e.g., "Song A, Song B"), the backend automatically splits the entry into child rows — one per song — with the amount divided equally. Same artist is kept on all splits. Only triggers on entries without existing children.

### Auto-Link to Releases
The `autoLinkRelease(entryId, artistName, songName)` helper in `bookkeeping.js` matches expenses to releases by comparing artist name + song against `artists.name` + `releases.project_name` (case-insensitive). Called automatically on entry creation (`POST /entries`, `POST /entries/batch`) and song/artist updates (`PUT /entries/:id`).

### Artist Name Normalization
Artist names are grouped **case-insensitively** across all pages (Ledger, Catalog, Recoupments, Financials). The most common spelling is used as the display name. Artist filter dropdowns are deduplicated. Always compare with `.toLowerCase()`.

### Recoupments
The Recoupments page (`/recoupments`) shows all ledger items where `recoupable = true`. The **index is a ranked upload queue** — one row per artist, ordered by provable dollars. The **artist subpage** (`/recoupments/:artistName`) lists that artist's items under **one grouping level** (song, or category), with the statement period and the four bank-state bands as filter chips. Each item has a UFR (Uploaded for Recoupment) toggle. See "The index is a queue, not a directory" and "The artist subpage has one grouping level" below for what each shows and why.

### Payment Dashboard scope
`/bk/payments` is scoped server-side to unpaid rows + rows paid within the last 14 days. The SQL clause is `(e.payment_status IS DISTINCT FROM 'Paid' OR e.payment_date >= CURRENT_DATE - INTERVAL '14 days')`. Older paid rows live in the ledger. Pass `?scope=all` to bypass (reserved — no current caller sets it). The `/bk/payments/export` route is deliberately unscoped: `?filter=paid` still returns full paid history, which is the whole point of an export. The mock adapter mirrors the same 14-day scope.

### A sent confirmation has to STAY sent

John, 2026-09-01: *"sometimes i send an email via the send button but it doesnt
get marked as sent."* Reproduced and traced on entry #1611 — the email went, the
ledger recorded it (`bk_audit_log` 21:08:49, `confirmation_sent = TRUE`), and the
row on screen ten seconds later still offered **Send** and **Mark Sent**. Nothing
was lost server-side; the page argued with itself.

**The cause was a stale read winning.** `uploadProof` arms a 4-second timer and
then did `setEntries(res.data.data)` — the WHOLE list replaced by a snapshot the
server took when that GET went out. John dropped the proof at 21:08:44 and sent
at 21:08:49, so the refetch was in flight across the send: it had already read
`confirmation_sent = false`, and its response landed after the send's optimistic
update and rolled it back. A longer delay is the same race with better odds,
which is why the fix is in **what gets applied**, not when.

The timer now patches only the fields `scanProofInBackground` actually writes
(`payment_status`, `payment_date`, `payment_ref`, `payment_method`, `paid_by`,
and the rush/hold flags it clears), on the rows it writes them to — the family,
since a proof covers the whole invoice. Every other row and field keeps what the
user did to it. **Any wholesale `setEntries(serverRows)` on a delayed timer is
this bug**; user-initiated loads are fine, because nothing newer exists yet.

**`npm run paymentsend-dom`** (from `client/`) reproduces it deterministically:
one fixtured invoice, a stub whose GET snapshots at request time and answers
2.5s later — which is what a database read does — and a send that lands inside
that window. Verified it can fail: on the pre-fix page it reports the row back
to offering Send. Nothing leaves the process; the send is stubbed at the api
boundary, which is the layer above the bug.

**Two transport holes were closed at the same time**, both of which end the same
way — the vendor has the email and the row never gets marked, because the code
that marks it never runs:

- `sendViaGmailAPI` parsed the response body with a bare `JSON.parse` as the
  first statement of the `end` handler. A non-JSON 2xx (Google's HTML error
  page, a truncated body) threw INSIDE the event handler, which is not a
  rejection: the promise never settled and the process took an uncaught
  exception. The status decides now; the body is parsed if it can be.
- There was **no timeout of any kind** on that request, so a hung socket waited
  forever. `GMAIL_SEND_TIMEOUT_MS` (default 120s — attachments upload slowly)
  now rejects with a message that says the mail may already have gone, so
  "check the sent folder before resending" rather than a silent second copy.
- The audit line in `/payments/:id/send-confirmation` was awaited bare. A
  failure there 500s a send that already happened, and the client reads a 500 as
  "it didn't send" — the next click emails the vendor twice. Non-fatal now, as
  the bulk sender's already was.

`server/scripts/gmail-transport-fixture.cjs` (8 assertions) covers those:
non-JSON and empty 2xx resolve, a non-2xx still rejects with the body quoted,
and a silent socket rejects on the configured timeout instead of hanging. It
replaces `https.request` and the token exchange before `services/email.js`
loads, so it exercises the real function rather than a copy. On the pre-fix code
it does not merely fail — the process dies with the uncaught `SyntaxError`.

### CC-the-rep on payment-confirmation emails
The Payment Dashboard "Send confirmation" action takes an optional `cc_rep` flag (`POST /api/bk/payments/:id/send-confirmation`, body `{ cc_rep: true }`). When true and the entry has a `boom_rep`, that rep's email is added to CC. **The default is OFF** — any caller that omits `cc_rep` gets the no-CC behavior. The toggle on `BkPayments.jsx` persists in `localStorage` under `pay_dash_cc_rep`. Don't flip the default to ON without an explicit ask — the OFF default was intentional (commit `4bfb15c`).

### Splitting an invoice: one dialog, two pages

John, 2026-09-01: *"I want to be able to split payments between different
songs/artists on the payments dashboard page."* Splitting already existed on the
Ledger — and 122 of the 312 rows on the Payments dashboard are already part of a
split family — you just could not CREATE one from the page where you decide what
to pay.

**`components/SplitInvoiceModal.jsx` is now the only split dialog**, rendered by
both pages. Extracted, not copied: a split is arithmetic, not a form (which
slices exist, what the family is worth, where the rounding remainder lands, what
"at least two" means), and a second copy would be a second answer to each. The
POST lives inside it, so both pages send the identical payload or neither does.
The caller owns only its colour tokens and its refetch.

**It divides the FAMILY total, never the parent's leftover share.** A parent that
has been split holds only its own slice — $800 of a $2,005 invoice — so dividing
"the amount" would silently shrink the invoice by the children's value. The
Ledger passes the family it has loaded; Payments passes `family_amount`, which
the server computes over the whole family.

**Splitting REPLACES every slice** (the endpoint deletes the children and
recreates them from what is posted), and that is a hazard specific to Payments:
the page is scoped to unpaid plus a fortnight of paid rows, so a family can have
one slice inside that window and one outside. Submitting what the page could see
would delete what it could not. The dialog detects it from two signals —
`is_split`, which the server computes over the whole family and therefore knows
about rows this page never received, plus the arithmetic (what is prefilled does
not add up to what the invoice is worth) — and says so instead, naming both
figures and pointing at the Ledger.

**"Split evenly" apportions in CENTS with the remainder on the first slice**
($422 three ways is 140.67 + 140.67 + 140.66). `POST /entries/:id/split` does not
check that the slices sum to the parent — it sets the parent to the first slice
and inserts the rest verbatim — so a rounding cent here is a cent on the invoice,
silently. The running total beside the buttons is the only place the difference
is visible before it is written.

Offered on family ROOTS only (`!entry.parent_id`): 99 of the dashboard's rows are
children, and a slice of a slice is a shape nothing downstream reads.

Covered by `npm run paymentsend-dom` (scenarios `split` and `partial`) and
`npm run ledgervendor-dom` (scenario `split`, the regression guard for moving the
dialog out of BkLedger). Verified against the dev database end to end as well: a
$700 invoice split 350/350 leaves a family summing to $700 and the dashboard then
shows two rows, each reporting `family_amount` 700. Verified the checks can fail —
dividing `entry.amount` instead of the family total, and removing the Payments
trigger, each turn them red.

### The due date is editable from the queue that sorts by it

John, 2026-09-01: *"I also want to be able to edit due date on the payments
dashboard page."* It was already editable there — inside the pencil's whole-row
edit, alongside eight other fields — which is not the same as being able to
change it. The Due Date cell is now a date input in place: one click, one PUT of
one field, with the page's own undo toast.

**The date is a property of the INVOICE, so the server cascades it across the
split family** (`PUT /entries/:id`, when `scheduled_payment_date` is in the
update). A vendor gives one date for one invoice; the split into per-artist rows
is our bookkeeping. Left per-row it puts one invoice at two places in a queue
that sorts strictly by this column — and that is not hypothetical: **8 of 110
live split families already held two different due dates** before this page could
edit one. Those eight are untouched; which of the two dates is right is a
judgement, not a migration.

**Deliberately NOT folded into `cascadePaymentFieldsToFamily`**, which it
resembles. That helper runs on every `payment_status` change, so adding the due
date there would copy one row's date over its siblings' every time somebody
marked an invoice paid — a silent write with no user behind it. This cascade
fires only when the date itself was the edit. Asserted both ways against the dev
database: editing the parent moves the child, editing the child moves the parent,
and marking the family paid leaves the date alone.

The client patches the whole family locally to match, so the list does not show
one invoice due on two days until the next reload.

Covered by `npm run paymentsend-dom` — scenario `duedate` (the write path and the
undo) and `duedate-family` (the sibling moves too, which needs a two-row fixture:
with one row on screen, "patched the family" and "patched the row I clicked" are
indistinguishable, and the first version of the check passed against the bug).

### The queue is ordered by priority, and can be read by vendor

John, 2026-09-14, on what is worst about the page: *deciding what to pay next*,
*too many clicks to execute*, and *it's visually cluttered*. The first two are
the sort and the grouping.

**`Priority` is now the default sort** (`SORT_OPTIONS[0]`, `sortBy` initial
state). Due-date-ascending — the old default — interleaves a rushed invoice
three weeks late with one merely scheduled, because it only ever looks at one
column.

Rush cannot do the ordering by itself either: **83 of the 160 open rows carry
the flag**, and asked directly, John confirmed that is real rather than flag
inflation. So rush is the first cut and the ordering INSIDE it does the rest.
`priorityBand()` returns one of seven bands, checked in order:

| Band | Live count |
|---|---|
| Rush · overdue | 38 |
| Rush | 45 |
| Overdue | 17 |
| Due within 7 days | 2 |
| Scheduled | 42 |
| On hold | 17 |
| Paid | 53 |

Inside a band: oldest obligation first (`scheduled_payment_date` ascending),
then largest (`sortableUsd`), then id — **the id tiebreak is load-bearing**, as
without it two rows sharing a due date swap places on every recompute. Paid rows
invert to newest-first; the question asked of them is "what did we just pay".

`on_hold` is tested **before** rush and overdue, so a held row sinks. Every
other surface on the page already treats hold as overriding overdue/due-soon
(stat cards, quick filters, row tint) and this keeps that one answer.

**`sortableUsd` was hoisted to module scope** out of the amount-sort branch so
priority could share it. Same function, same locked-rate behaviour.

**Band headers render only when `groupBy` is 'No grouping' and there are two or
more bands.** One band means the label explains nothing, which is what the quick
filters produce constantly — the Rush chip is a single band by construction.
A split child inherits the band of the parent it renders under, so a family is
never torn across two headers.

**`Group by Vendor`** is offered, never forced: John pays *some* vendors as one
batched transfer and others invoice-by-invoice, so it is a way to read the
queue, not a claim about how money leaves. Groups are emitted in the order their
first row appears in `filtered`, so the sort still governs — under Priority the
vendor holding the most urgent invoice heads the list. **`grouped` uses a Map,
not an object literal**: integer-like keys (a payee named "88 Ventures") reorder
themselves in plain objects and would silently undo that. The method/status
groupings were switched to a Map for the same reason.

The vendor header counts **families, not rows** — a $10k invoice split four ways
is one invoice to pay, and counting slices would tell you to cut four transfers.
It reads "3 of 13 open invoices" when a filter has narrowed the group, so the
filter's effect is visible rather than silent.

**`payVendorTogether` excludes held rows** from both the total and the
selection. A hold is a deliberate pause, and sweeping one into a batch payment
because it shares a payee would defeat it silently; the header says "N on hold"
rather than dropping them without comment. Its `one_payment` default is exactly
`canBeOnePayment` (one vendor, two or more family roots) — deliberately not a
second, cleverer rule about what may be paid together.

**Known gap, unchanged by this work**: neither `canBeOnePayment` nor
`payVendorTogether` checks CURRENCY. A vendor with a USD and a EUR invoice can
have "these went out as ONE payment" defaulted on, which no single transfer can
be true of. Pre-existing in the batch dialog; flagged, not fixed.

Covered by `npm run paymentsend-dom` — scenario `queue`, a seven-row fixture
occupying every band with one vendor holding three of them. The load-bearing
pair is Borough (rush, due in 20 days) against Cobalt (no rush, 3 days overdue):
due-date-ascending puts Cobalt first, Priority puts Borough first, and the
scenario asserts BOTH orderings off the same page — without a pair the two sorts
disagree about, a green result would only prove the list rendered in some order.
Verified the checks can fail: reordering the band predicates and letting
`payVendorTogether` sweep held rows each turn them red. The dialog assertions
read the dialog element, not `document.body` — off body text the $1,500 check
passes on the vendor header's total while the dialog shows $1,800.

### The stat cards ARE the filters

John, 2026-09-14, third of three complaints: *it's visually cluttered*. The top
of the page carried eight quick-filter chips and, directly beneath them, five
inert stat cards — and four of the chips (All / Unpaid / Due Soon / Overdue)
named the same sets the cards were counting. Thirteen elements, two of them
saying the same four things.

**Each card now performs the filter it describes**, and those four chips are
gone. The three with no card — Rush, Hold, Multi-invoice — stay as chips in a
thin row beneath, carrying counts. It is still the ONE `quickFilter` control it
always was, now rendered across two widgets instead of eight chips in one, so
selecting a chip clears whichever card is lit.

**A card's number is a promise about the list it opens**, which is the rule that
cost one card its label. `PAID THIS MONTH` counted `payment_date` inside the
current calendar month; the `Paid` filter it would click through to selects
`payment_status = 'Paid'`. Different sets. And the old label could never have
been true anyway — the page is scoped server-side to unpaid plus 14 days paid,
so on the 28th it claimed a month while holding a fortnight and under-reported
in silence. It is now **`PAID · LAST 14 DAYS`** over `paidRecent`
(`payment_status === 'Paid'`), which is both what the page holds and exactly
what the filter returns. Same fix applied to the mobile stat strip. On the day
it shipped the two predicates happened to agree (51 rows either way), which is
the safe moment to correct a label.

`workflowFilterCounts` reuses the exact predicates from `filtered`'s quickFilter
branches. **Do not reimplement them** — a chip whose badge disagrees with the
list it opens is worse than a chip with no badge. Both cards and chips count
over `entries`, so they describe the whole queue; search / method / rep narrow
the list below without changing what the queue holds.

**Other chrome removed in the same pass:**

- **Two export buttons became one.** CSV and Excel are the same request in two
  formats; as peer buttons in the page's top corner they read as two features.
  Now one `Export` popover, dismissed by outside-click or Escape via the same
  contract `statusMenuId` uses. The ref wraps the trigger AND the popover — wrap
  only the popover and clicking the trigger to close is an outside-click that
  closes and reopens in one tick.
- **The bulk-send button was rendered twice**, once in the filter toolbar and
  once in the bottom bar, both calling `sendAllPendingConfirmations`. The
  toolbar copy is gone.
- **CC-the-rep moved off the filter toolbar**, where it was the one control
  among eight that changed what an email SAYS rather than which rows are listed.
  It now sits in the bottom bar and renders only when
  `filtered.some(isPendingConfirmation)`. It must stay settable BEFORE a send —
  it drives both the single-row `confirmation-preview` and the bulk send — which
  is why it is not inside the confirmation modal. Default still OFF, still
  persisted in `pay_dash_cc_rep`.
- **Selection folded into one control.** Select All / Select Pending / Clear
  each had the same visual weight as "Mark Selected Paid", so the bar could show
  seven equally loud buttons and none read as the one you came for. They are
  quiet underlined links behind a "N selected" summary now; the writes stay
  buttons.

Covered by `npm run paymentsend-dom` scenario `queue`. The load-bearing
assertion is **CARDS: clicking it filters the list** — it reads the count off
the card and compares it to the rows that appear, which is the card/list
contract stated above. Verified it fails when the two diverge. Also asserts the
four removed chips are absent (checked against BUTTONS only — 'Unpaid' and
'Paid' are still `<option>`s in the status select), that the CC control exists
exactly once and not among the filter controls (verified it fails on a
duplicate), and that the bulk send renders once.

Harness note: read a card's count off its own element, not the card's
`textContent` — the money headline runs straight into it, so "$6,600" followed
by "3 invoices" parses as 6003.

### The chips say how much, not just how many

John, 2026-09-15: *"I want to be able to see the amount that is labeled rush,
amount labeled as hold, etc."* Every headline on this page is money except the
four workflow chips, which carried a bare count — and a count does not say
whether Rush is $4,000 or $400,000, which is the thing that decides what gets
paid this afternoon.

**Rush · Hold · Multi-invoice · Blocked** now read `$128,400 · 12`. Money first,
count second; both withheld at zero, since `$0.00 · 0` is noise where a plain
label says the same thing.

**One converted figure, with the native breakdown on hover.** A chip has no room
for `$3,900.00 + €1,000.00`, so the badge is `fmtUsdItems` — the same helper and
the same locked-rate precedence the stat cards use, so Rush and OVERDUE cannot
value one euro two ways — and the `title` carries `fmtTotals(groupByCurrency())`
when a non-USD row is in the mix. A converted total with no way to see what it
is made of reads as dollars. An all-USD chip discloses nothing, because there is
nothing to disclose.

**`workflowPredicates` is new, and it is the point.** `filtered` and the badges
each held their own TYPED COPY of "which rows are on hold" — the comment above
the badges claimed they reused the filter's predicates and they did not. That is
survivable while a badge shows a count and expensive the moment it shows money,
so the four predicates are now one object both read. It is declared ABOVE
`filtered`, not below: a const read from inside a `useMemo` that runs first is a
temporal-dead-zone throw, and this page has taken a white screen from that shape.

**Counted over `entries`, like the cards** — search / method / rep narrow the
list below without moving them. A scoreboard that follows the search box is a
second copy of the list.

Covered by `npm run paymentsend-dom` scenario `queue`. The fixture gained a
**EUR** rush row for this: every row was USD, and an all-USD fixture cannot tell
a correct conversion from no conversion — each row converts to itself. €1,000 at
0.92 makes Rush `$4,987`, which is neither the `$4,900` an unconverted sum gives
nor the `$3,900` of dropping the foreign row, and both wrong answers are
asserted against by name. **Verified all three ways it can break:** summing raw
amounts, reducing over the wrong predicate, and dropping the tooltip each turn it
red. The second is the instructive one — the money assertion went red while
"Hold opens exactly the row its money counted" stayed green, because only the
chip's reduction was broken and not the list. That pair is the contract.

Two harness notes, both bugs that cost a run: `order()` holds a HARDCODED list of
the fixture's invoice numbers, so a row added to the stub and not listed there is
invisible to every ordering assertion and reads as "the row did not render". And
`/fx/rates` returned `{}`, so nothing converted at all.

### What the page knew and would not say

John, 2026-09-14. Three signals the Payments page already held and never
rendered. All three are narrow on purpose — the measurement came first, and two
candidate predicates were rejected for being too broad to act on.

**W-9 is a VENDOR question, and the row-level flag answers a different one.**
`has_w9` was selected by `/bk/payments` for every row and rendered nowhere. It
tests whether THIS invoice carries the form — but a W-9 lives on whichever entry
it was uploaded onto and covers every other invoice from that vendor, aliases in
both directions. Measured on the live queue: **the row-level flag reports 122
unpaid rows missing a W-9; only 32 are genuinely uncovered, across 22 vendors,
16 of them at or over the $600 threshold.** Shipping the naive flag would have
been a 4x false-positive rate on a compliance signal.

`/bk/payments` now attaches **`w9_entry_id`** via `w9OwnersFor` — one batched
pass after the main query, never a lookup per row (see the note in that module
about the correlated subquery behind a 17-second page load). The panel tests
`has_w9 || w9_entry_id`, which is how the Ledger, Approvals, Invoices, Archive
and Vendors pages already pair them; do not invent a per-page field for this.
When the form is on a sibling invoice the panel says so ("filed on another
invoice") rather than implying it is attached here.

**Blocked** = an unpaid row with **no payment method** (cannot decide how to
send it) or **no vendor email** (payable, but the confirmation has nowhere to
go). 17 rows live. One predicate, `blockedReasons()`, feeds the chip, its badge
and the row marker, and the marker NAMES the reason — "blocked" with no reason
is a worklist you have to open every row of.

**Rejected: missing bank details** (`payment_last4` / `paypal_handle` /
`payment_snapshot`). Those columns are only populated by the vendor portal, so
**133 of 161 open rows have none** — that flags "did not arrive through the
portal", not "cannot be paid", and a chip carrying 83% of the queue is the rush
flag's problem again.

**Needs proof.** When a paid row has no proof file, or no vendor email, the Send
button simply does not render and the cell goes quiet — the row reads as
finished. **22 of the 51 recently-paid rows are in that state.** The cell now
names which of the two is missing.

Covered by `npm run paymentsend-dom` scenario `queue`. The W-9 assertions are
the ones that matter: a vendor covered by a form on another invoice must read as
on file, and must NOT be reported missing. Verified both turn red when the panel
falls back to bare `has_w9` — which is the regression this exists to prevent.

**The server half is not covered by that harness**, which stubs at the api
boundary. It was proved against the dev database instead: a W-9 written onto one
of five Northgate invoices makes all five resolve `w9_entry_id` to the entry
holding it, exactly one row reports `has_w9`, and no other vendor's rows are
touched. R2 is unconfigured on dev so the upload endpoint 500s — the fixture
writes the legacy `w9_data` column, which is precisely what `HAS_W9_SQL` reads.
Pin the host (`ep-wild-king-a6oyslvh`) in any script that writes.

Fixture note: `queueRow` in the stub defaults `payment_method` and
`vendor_email` PRESENT so that blocked is a property a row opts into. Left
unset, seven of the nine rows were blocked and the assertion tested nothing.

### Split-family payment-status cascade
Toggling `payment_status` / `payment_date` / `paid_by` on any row in a split family (parent or child) cascades to the entire family — the parent and every sibling — in a single transaction. Logic lives in `routes/bookkeeping.js` near the payment-status PATCH (search `cascaded to split family`). Mirror parent: when only one row in a family changes payment state on the client, the server still writes all of them; the response should be re-read against the family root, not the touched row.

### Cross-cutting bookkeeping surfaces (Aug 2026)

Four shared pieces were extracted so the statements/reports work stopped being
sealed inside two pages. Prefer them over rebuilding equivalents:

- **`components/ReviewDeck.jsx`** — the card-at-a-time review shell (overlay,
  `{i} of {n}` header, progress, done panel) plus the `DeckButton` primitive
  (`tone` / `size` / hover `label`). Used by the statements deck and the
  Reports drill deck. **Pass children as a function, not a node**: when a deck
  finishes, `index` runs one past the end and the current item is `undefined`,
  so an eagerly-evaluated node crashes on `item.direction`. Card bodies,
  keyboard handlers, and all server calls stay with the owning page — the two
  decks' notion of "accept" is not the same operation.

- **`server/lib/bank-evidence.js`** — `bankEvidenceCols()` / `noBankEvidenceSql()`,
  joined into `/bk/entries`, `/bk/payments`, `/bk/vendors/:payee`. Renders via
  `components/BankEvidenceDot.jsx` (emerald = matched, rose = paid with a
  covering statement and no match, nothing = no opinion). **Funding-pair aware**:
  a PayPal payment appears on both statements with the bank leg dismissed, so
  the method-compatibility test from `routes/statements.js` is mirrored in SQL.
  A naive "is there a BofA debit" check flags every PayPal invoice as
  unverified.

  `/bk/payments?bank=unverified` still exists server-side but **has no caller**.
  It backed a "No bank match" chip on the Payments page, removed Aug 2026:
  Payments answers "who do we pay next", and a reconciliation worklist made
  that page's scope conditional on which chip was selected. Keep the param —
  it is the query the parked "paid, no bank evidence" worklist needs when it
  lands on Flags. If you wire it up anywhere, note that it opts out of the
  14-day scope and therefore **must refetch server-side**: filtering the
  already-loaded rows returns a near-empty list that reads as "nothing wrong".
  The per-row dot stays on Payments, Ledger and Vendors — it is context on a
  row you are already reading, not a queue.

- **`/flags`** — the global flags hub, served by `pages/Duplicates.jsx` (the
  filename predates the promotion, like `ActivityHistory.jsx`; don't rename
  without updating `App.jsx` + `Layout.jsx` together). `/duplicates` redirects
  here. Money-shaped sections are role-gated server-side in `routes/flags.js`:
  ledger flags need a bookkeeping role, bank flags need Admin/Superadmin.
  Page grants are stored by path, so `AuthContext.canView` treats an existing
  `/duplicates` grant as satisfying `/flags` — without that carve-out every
  non-admin holding the Flags page loses it on deploy.

- **`report_dismissals`** — items excluded from the Reports P&L, kept
  deliberately separate from `bank_transactions.dismissed` (a sweep's judgment
  vs a person's). Keyed by **fingerprint**, not txn id, because statements get
  re-uploaded and ids change; the fingerprint uses
  `lib/normalize-bank-payee.js`, which strips card-code noise so a recurring
  charge is stable across uploads. Dismissing MOVES REPORTED TOTALS, so the
  P&L discloses the excluded count and amount at three levels rather than
  quietly reporting a smaller number.

### Booked is not matched (Bank Matching's completion model)

Three states, not two. A **matched** row is tied to an invoice a vendor
actually sent. A **booked** row is an entry the app INVENTED from the bank line
via `bookDebitAsEntry` — it has a ledger id and `match_method = 'created'`, but
no document behind it. The page exists to turn the second into the first, so it
must not report them as the same thing.

`GET /statements/completion` is the ONE definition — Coverage and the
Needs-invoice queue both read it, and it returns `needs_invoice_txn_ids` so the
client filters by membership instead of re-deriving the rules and drifting.

    matched                494   $2,187,076     Explained       94.3%
    booked (invoice due)  2321   $3,257,552     Invoice-backed  37.9%
    open                    14     $329,165

Both percentages are shown, labelled. They answer different questions — is
every bank line accounted for at all, versus does it have a document behind it
— and one number was quietly claiming both.

**`statement_no_invoice_rules` is what lets the queue reach zero.** 1,997 of the
booked rows ($1.95M) are payroll, partner draws, rent, cards, royalties and
meals: spend that will never have an invoice. Without a way to say so the queue
is permanently $3.26M and a figure that can never improve is one people stop
reading. `scope='category'` answers ~10 rows of business truth at once;
`scope='vendor'` handles exceptions. **Matched by equality, never substring** —
"TONE" ($615k) is a substring of "Tone Pay, Inc" and "Dean St" of "Dean Street
Media". The table ships EMPTY and `category_candidates` only suggests, with the
vendor evidence; deleting a rule returns those rows because it never wrote to
the ledger.

**USD comes from `usdOf` (`lib/usd.js`), never `amount_usd`.** `/statements/all`
converts at request time from the live rate cache, so summing the stored column
reported $6,159,482 against the page's $5,772,443 — a foreign row with a null
`amount_usd` falls back to its face value and is counted as dollars.

### What each statement has answered (the library's reconciliation)

`/bk/statements`. The library already grouped by month and drew a coverage bar
per statement, and **both numbers behind it were wrong in the same direction**:

    month bar     /statements/months   (matched + dismissed) / debits
    statement     /statements          st.matched / st.debits
    page total    client-side          debits - matched - dismissed

`matched_expense_id` is set on a BOOKED row too, so all three counted an entry
this app invented from a bank line as a settled invoice — the library reported a
month nearly clear while Bank Matching, one click away, held hundreds of rows of
work on the same statements. The third is worse than the other two: the counts
OVERLAP (a row can be dismissed after being matched) so the subtraction removes
that row twice, which is the exact trap `/statements/` warns about in SQL.
Measured on a fixture holding one row of every disposition: the bar read **86%
against a true 50%**, and the subtraction reported **1 open against 3 real**.

**`server/lib/statement-buckets.js`** is now the one definition — six buckets
that PARTITION the debits, three the credits — read by `GET
/statements/reconciliation` and by the fixture. `ACCOUNTED` (matched + creator +
no_invoice_due) is exactly Bank Matching's **Categorized** chip; `LEFT`
(needs_invoice + open) is exactly its **For review** chip. Verified against the
dev database: the new endpoint's LEFT equals `/statements/completion`'s
`by_statement[id].left` on all 13 statements and to the cent, so the two pages
answer with the same sets and every figure can deep-link to the rows behind it.

**Order is load-bearing twice** — `dismissed` first (the counts overlap), and
`creator` before the generic non-`created` test (a creator match is not
`created` either, and would otherwise be reported as invoice-backed, which is the
one thing it never is).

**The client rolls up; the server does not.** `/reconciliation` returns per
statement and nothing else, and `rollUp()` in `BkStatements.jsx` sums the very
statements it renders to get the month subtotal and the page total. A month here
groups by `period_start` while `/statements/months` groups by `txn_date`, so a
second source would let a header disagree with its own rows for any transaction
dated outside its statement's period. Same set, same number.

**The query must select every column the no-invoice predicate reads** — the
row's own `id` and `payee_guess`, and the matched entry's `payee` and
`category`. A vendor rule matches the ledger payee OR the BANK DESCRIPTOR, so
the first version of this endpoint, which selected four of the five, reported
every descriptor-covered row as still owing an invoice: 101 left against the
queue's 51 on one live statement. Found by diffing the two endpoints in
production after the deploy, which is late — the fixture now proves the old
column list FAILS before trusting the new one.

**Values are NOT rounded server-side.** The client sums them into two more
levels, and summing already-rounded parts has broken a tie-out on these pages by
a cent before. Round once, at display. USD is `usdOf`, never `amount_usd` — the
fixture's ¥100,000 row is $99,354.84 less in dollars than that column claims.

**A failed request renders as UNKNOWN, never as done.** `recon` is `null` on
failure and every figure is withheld; `{}` would reduce to "0 left, 100%", which
is the difference between "we don't know" and "the work is finished" and this
page has shipped the wrong one before.

**The reconcile gate is deliberately unchanged.** It still turns on lines with
NO LEDGER ENTRY (the fixture asserts that count still equals the old
`open_debits` per statement); booked rows still owed an invoice are shown as
work and do not block a close, and the unlock sentence names its own condition
rather than the header's "left" — tightening it is a policy change, not a
reporting one.

**Money in is a separate side and is never summed with money out**, because a
statement carrying unbooked deposits is not reconciled. **Known gap**: those
lines do not link anywhere. Bank Matching's `filter=all` is debits-only and
money in has no chip of its own there, so credits are reachable only via its
Flagged and Reversals views; the panel says so instead of offering a link that
lands on a different set.

Covered by `server/scripts/reconciliation-partition-fixture.cjs` (21 assertions
— every row lands in its bucket, the buckets sum back to the statement in counts
AND money on both sides, and both replaced formulas are wrong on those same
rows) and `cd client && npm run statementrecon-dom` (41 — the three roll-up
levels against fixtures whose answers are known in advance, the breakdown, the
four exact deep links, and the failed-request case). `npm run smoke` covers none
of it: BkStatements renders under `renderToString` in its LOADING state and
reports "ok, 686 bytes" for a library that never drew a month. **Verified all
three can fail:** testing `creator` after the generic match turns the server
fixture red, and falling back to `{}` on a failed request or restoring
`st.matched / st.debits` each turn the harness red.

### Answering "is this recoupable?" while matching

Bank Matching asks it on the row it is about to book, rather than leaving it to
the review queue. `expenses.recoupable` is `BOOLEAN DEFAULT TRUE` and
`bookDebitAsEntry` never listed the column, so every statement-born row arrived
claiming to be recoupable and **nobody could tell the claim from an answer** —
1,972 rows deep by the time it was measured. Answering at the booking is the only
point where somebody is already looking at the payment.

**THREE states, which is why it is two buttons and not a checkbox.** Unanswered
is both buttons unpressed, and a row booked that way behaves exactly as bookings
did before: `recoup_reviewed` stays FALSE and `/bk/recoup-review` asks about it.
A checkbox would render the column default as a decision, which is the bug.

**The answer rides on the booking.** `bookDebitAsEntry(t, { recoupable,
reviewedBy, … })` writes `recoupable` + `recoup_reviewed` + `_at` + `_by`
together, so the entry is never briefly on the books claiming to be recoupable
when the reviewer just said it is not. Only a real boolean counts —
`undefined`/`null` leave both columns alone. Threaded through
`/tx/:id/create-entry` and `/tx/:id/no-invoice` (so `applyNoInvoice` and the bulk
route carry it too).

**The sweeps deliberately pass nothing.** `applyCategoryRules` and the
`always: true` sweep inside create-entry book rows the person never saw; one
click that silently answers "recoupable" for forty of them is exactly the shape
this column already got wrong once. Those rows stay in the queue.

**An already-booked row goes through `/bk/recoup-review`**, not a second writer —
the deck's `applyDeckRecoup` posts to the endpoint the Recoupments queue uses, so
one place sets the pair and writes `bk_audit_log`. Gated on `wasBookedByUs`: a
card sitting on a REAL invoice shows the invoice's own recoupable, decided where
that invoice was entered, and this page does not overwrite it (the server refuses
it anyway).

`FAMILY_SQL` carries `recoupable` **and** `recoup_reviewed` so a card can show
what the ledger already says. One without the other cannot distinguish an answer
from the default.

Four surfaces, all optional, all `RecoupAnswer` in `BkBankMatching.jsx`: the
review card (plus the **R** key, cycling unanswered → yes → no), the open table
row (before the category picker, because picking a category IS the booking), the
⋯ menu's book-it-myself form, and a booked card's keep/rebook. Ink fill on the
chosen side per the statements design language — neither answer is an alert.

**`npm run bankmatch-dom`** (from `client/`) proves all four from the click to
the database row — see the header of `scripts/bankmatch-dom-run.mjs` for the
two-step setup. It needs a server on `:3011` and jsdom, and it fixtures and
deletes its own statement each run. Verified it can fail: dropping `recoupable`
from the table's booking body turned the scenario red on both the request body
and the ledger read.

Not extended to `BkVendors`, which also books through the same endpoint — that
page is a different job and nobody asked for it there.

### Is anything missed? — statement integrity

Two questions the upload pipeline could not answer, and one correction to how it
was described.

**"No flag" never meant "proved."** `/statements/flags` reconciles statements two
ways — standalone (opening + credits − debits = closing) and chained (the
previous closing stands in for a missing opening) — and both **SKIP** rather than
fail when they cannot run. A skip is invisible. Measured 2026-09-02: six PayPal
statements, **1,206 rows and $999,447 of money out**, were subject to no balance
check at all, and the `balance-unverifiable` warning written for exactly that
case was **unreachable** — it sat below a `continue` on a null opening balance,
which every PayPal statement has. That ordering is fixed, and
`GET /statements/integrity` now returns a verdict per statement: `proved`,
`proved_by_chain`, or `unprovable` **with the reason**.

Live verdicts: BofA 2 proved, 4 by chain, 1 unprovable (January — the first
statement of the account, no opening balance and nothing before it). PayPal 6
unprovable, all for unconverted foreign rows.

**A tie can be vacuous, and PayPal's always is.** Every PayPal statement's
credits equal its debits to the cent — 72,758.73 both ways, 327,140.39 both ways,
five months running — because each payment appears twice, the payment and the leg
that funded it. Against a 0.00 closing balance the arithmetic is 0 + X − X = 0,
which ties no matter what is missing: drop rows and, given that structure, they
cancel in pairs and it still ties. `verdictFor` refuses to call that proof.

**Nothing noticed a statement that never came.** The gap flag fires BETWEEN two
statements, so it cannot fire for the newest one — an account that stops is
invisible. `expectedNext` infers the cadence from the period ends the account
already has (median, so one partial month cannot drag it) and reports days-since
and expected-by. PayPal is overdue today: 36 days since 28 July. BofA is not —
33 days, and with a 31-day cadence plus 5 days of grace the August statement is
not late until 5 September. Reporting the 33 days without crying wolf on day 33
is the point.

**PayPal proves itself by PAIRING, not by a balance.** There is no balance to tie
against and the currencies cannot be summed — so the checkable structure is the
document's own: every payment arrives with the leg that funded it, same currency,
same amount.

    General Payment                AUD 829.38   debit
    General Currency Conversion    AUD 829.38   credit
    General Payment                USD 300.00   debit
    Bank Deposit to PP Account     USD 300.00   credit

`pairingFromCounts` matches debit amounts against credit amounts as a MULTISET,
per currency, in integer cents — a multiset keyed on a float is a multiset keyed
on rounding. A row lost in the parse leaves its partner unmatched, and that is
visible. This has the discriminating power the balance check never had here:
five of six live statements pair perfectly and **February leaves 26 rows
unmatched** (USD 4, AUD 4, CAD 1, GBP 1, PHP 3 on each side), whereas
credits-equalling-debits was structurally guaranteed whatever was missing.

**What pairing does NOT prove, and the verdict says so:** a pair missing on BOTH
sides is invisible to it, and nothing printed on a PayPal statement — no total,
no transaction count — could catch that. It is evidence, not proof of
completeness, and the reason string ends by admitting it rather than reading as
a tick.

The counts come from one grouped query, not the rows: a 226-row statement costs
one row per (currency, direction, amount). Verdicts on production went from
**2 proved / 4 by chain / 7 unprovable (1,206 rows, $999,447)** to
**2 / 4 / 5 by pairing / 2 unprovable (474 rows, $463,073)** — and the two left
are specific rather than a shrug: January BofA is the first statement of the
account, and February PayPal is the one whose pairing genuinely does not hold.

**`POST /statements/backfill-beginning-balance` — what it must not do.** John:
*"make sure it doesnt reopen old items or duplicate ones."* It writes ONE COLUMN
on `bank_statements` and re-parses nothing; it does not touch
`bank_transactions` at all. That is the whole guarantee, and it is structural
rather than careful — a re-parse is what once doubled a live statement from 465
rows to 963, and re-deriving match state is what would reopen finished work.
Idempotent (`WHERE beginning_balance IS NULL`), and it REFUSES a statement whose
own opening disagrees with the previous closing: that is a finding, not a gap.

**It also refuses to manufacture a tie.** A 0.00 close on an account that never
shows a non-zero one means "this statement prints no balance", not "the account
was empty". Carrying that forward would turn an honest null into a number and
produce the un-failable 0 + X − X = 0 above. The integrity surface applies the
same rule, or the button would offer 9 and deliver 5.

`server/scripts/statement-integrity-fixture.cjs` — 34 assertions. The one it
exists for snapshots every transaction (id, match, income match, dismissal,
no-invoice flag, method, amount) before and after the backfill and asserts they
are byte-identical. **Verified it bites:** making the backfill also clear
`dismissed` turns it red. Two bugs it caught while being written: the statement
chain was ordered by `String(pgDate).localeCompare`, which sorts by weekday then
month name and put February before January (the `"Tue May 04 2032"` trap again),
and my first overdue assertion asserted the wrong side of the grace boundary.

### Statement rows are excluded from the recoupment surfaces

`server/lib/ledger-source.js` (`excludeBankRows(alias)`) and its client mirror
`isBankStatementRow` / `withoutBankRows` in `client/src/utils.js`. One definition
each side; ten query/render sites use them.

**Why.** `expenses.recoupable` is `BOOLEAN DEFAULT TRUE` (policy: everything is
recoupable unless marked otherwise) and `bookDebitAsEntry` in
`routes/statements.js` never lists the column, so **all 2,325 statement-born rows
were born `recoupable = true`** — $3.64M of unvetted bank spend sitting on the
Recoupments page next to $2.95M of real recoupable spend. **None of them carries
an artist**, so they were all inflating one giant "Unassigned" card rather than
individual artist cards. The Artist Campaigns queries had **no source filter at
all** — that route's comment claims "marketing-category ledger spend" but the SQL
took the whole ledger.

**It is a query rule, not a data fix.** Nothing rewrites `recoupable`. The intent
is temporary: once ledger matching gives statement rows a real artist and
category they belong on these pages, and reverting is then deleting the call
sites — not reconstructing which rows a person deliberately marked non-recoupable.

**`IS DISTINCT FROM`, never `<>` or `NOT IN`.** 1,201 live rows have
`entry_source IS NULL` (hand-entered/vendor invoices predate the column).
`entry_source <> 'bank_statement'` is NULL for those, so a naive inequality drops
every hand-entered invoice and **empties the page instead of narrowing it**.

Applied to: the **seven** expense queries in `routes/artist-campaigns.js` (index
rollup, its `fxPending` companion, the shared `vis` fragment covering the
flagged/commented panels, the export, the per-artist detail, and the
`dismissedCount` behind "Show dismissed (N)" — that last one must match or the
toggle offers N rows and reveals fewer), `/bk/export-recoupments`, and the fetch
boundary of `Recoupments.jsx` + `RecoupmentsPlanning.jsx`. Filter at the fetch
boundary on the client, not per view — a page's stat tiles, grouping memo,
"Non-recoupable" panel and label list are each another chance to let rows back in.

**`excludeBankRows` tests the row's OWN `entry_source`, and split children do
not inherit it.** The child INSERT in `routes/bookkeeping.js` never copies the
column, so a slice of a bank-born payment has `entry_source = NULL` and passes
the filter — 88 rows / $55,470.89 on Marketing + Advertisements alone (measured
2026-08-19). Apply it to the FAMILY ROOT (`JOIN expenses root ON root.id =
COALESCE(e.parent_id, e.id)`) when the answer matters, as
`routes/artist-campaigns.js` `campaignLayers()` does. The remaining member-level
call sites in that file and on the recoupment surfaces are a known gap: fixing
them moves reported numbers, so it needs a decision, not a sweep.

**Two surfaces deliberately NOT scoped**, so they disagree with the pages by
design — do not "fix" this without asking:
- `routes/reports.js` recoupable memo on the balance sheet
- `routes/full-export.js` Recoupments sheet in the export ZIP

Scoping either moves a number currently on a report. The observed gap on a
4-row fixture: memo 4/$400 vs pages 3/$300.

### Statement PDF parsing: rules first, AI as fallback

`parsePdfRows()` in `routes/statements.js` has two implementations behind it.

1. **`parsePdfRowsDeterministic`** — `lib/statement-pdf.js`, rules over extracted
   text. **40-260ms** for a 300-450 row statement.
2. **`parsePdfRowsWithAI`** — the original Claude call. Correct on any layout but
   **output-bound**: it has to *write* every transaction, so a dense month runs
   6-8 minutes and a long one hits the 32k output ceiling and cannot be parsed
   at all.

The fast path runs first and is only allowed to win when the parse **reconciles
against the statement's own printed figures**:

- `beginning + Σ(signed amounts) = ending` — the whole statement
- `Σ(signed amounts in section) = printed section total` — per section
- zero orphans (a date-opened record whose amount was never found)

Anything else returns null and the AI runs. **This gate is the entire safety
argument**: a BofA layout change can cost the fast path, never correctness. Don't
"fix" a non-reconciling statement by loosening the tolerance (0.02) or dropping a
check — falling back is the designed behaviour, and the audit line records which
path ran (`rule-parsed, balance-verified` vs `AI-parsed`).

Facts the rules depend on, derived from real statements — verify against actual
text before changing any of them:

- **A transaction is NOT one line.** Wire descriptors wrap over several extracted
  lines and the amount often sits alone on the last one. Records accumulate from
  a date-opening line until the next one; the amount is the **last whole-field**
  money token. Testing whole tab-fields (never substrings) is what stops
  `FX:EUR 250.00 1.0834` inside a descriptor being read as the amount.
- **Tabs are the column boundaries**, produced by the layout reconstruction in
  `extractPdfText` (same-line items more than 7 units apart get a TAB;
  `|Δy| < 4.6` is the same line). Those constants come from pdf-parse's
  algorithm, which the rules were derived against.
- **Section headers are bare.** The same words followed by a tab and a figure are
  the account-summary block and must not open a section. Printed section totals
  are read from the summary, because it lists all four even when a section has no
  table (no checks → `Checks 0.00` and no Checks section).
- **"Daily ledger balances" rows look exactly like transactions** and must stay
  excluded.
- Sign carries direction; a `- continued` header must NOT flush the open record.

**`pdfjs-dist` is a direct dependency and `pdf-parse` deliberately is not.**
pdf-parse pulls `@napi-rs/canvas` (native Skia, ~23MB) as a *hard* dependency,
purely for image rendering we never request — a missing platform prebuild would
fail the deploy. Under `pdfjs-dist` the same package is *optional*, so a missing
prebuild degrades to the AI path instead of breaking the build. pdfjs v5 does
still need it even for text (`DOMMatrix is not defined` without it), so the fast
path logs a loud one-time `FAST PATH DISABLED` error rather than going quietly
slow. `@napi-rs/canvas-linux-x64-gnu` is published, which is what Railway needs.

**BofA only.** PayPal has no rules — no sample was available, and guessing at a
layout that must reconcile to the cent is worse than not trying, so
`parseStatementPdfText` returns null for every other account.

### Spend by Artist: advances are a COLUMN, not part of spend

`/reports/spend-by-artist` reports operating spend, and `by_artist.total` equals
the P&L expense total by construction — `ties_to_pnl` asserts it. Advances are
`report_section = 'below_line'` (recoupable money, not trading spend), so they
were outside that rollup and the report showed **none** of the $1,482,835 of them
(Jan–Jul 2026), despite 56 of the 67 rows already naming an artist. Added
2026-08-25 as **Spend · Advances · Total out**, three frozen columns.

- **Beside spend, never inside it.** Folding them in would stop the report
  answering "what did we spend that we can't get back", and would break the tie
  to the P&L. Total out is the sum, and the header names all three bases.
- **`ADVANCE_CATEGORIES` is module-scope in `routes/reports.js`** because it has
  TWO readers that must agree — the rollup that fills the column and the artist
  drill that opens a cell in it. EQUALITY on the name, never substring, so a
  RENAME would empty the column: everything below the line that is not in the set
  is totalled as `advances.other_total` and disclosed, and
  `advances.total + advances.other_total` equals the below-line expense total
  exactly (live: 1,482,834.66 + 535,800.66 = 2,018,635.32).
- **The column is NET, like the line it sits on.** The contra branch bumps it
  negative, so an advance refund reduces that artist — $1,482,835 net against a
  gross $1,505,835.
- **The artist drill opens an Advances cell**, below-line, but ONLY when that
  column's cell was clicked (`drillCategory` in the set). Without that test a
  row-total drill would start including advances and stop matching the Spend it
  was opened from.
- **Advance-only artists appear.** The row list is the UNION of both key sets;
  keying off the operating rollup alone dropped 4 live artists whose only cost in
  the window was an advance. So the coverage line counts artists with operating
  spend, not `artists.length`, or the band would quote a headcount including rows
  it does not measure.
- `artistBucketKey` folds spellings here too: "Feel Trip" $200,000 and "feel
  trip" $50,000 are one $250,000 row.
- The Excel export carries both columns, and its "what this total excludes"
  bridge no longer lists advances as excluded — they are on the sheet now, so
  only `other_total` (partner draws, reimbursements) is.

`server/scripts/advance-column-fixture.cjs` (23 assertions) holds the properties:
spend does not move, the section adds up, every cell equals its own drill, the
Spend cell still excludes advances, and a refund nets off AND is disclosed.

**A note on reading the drill in a test:** compare a cell against the drill's own
`total`, never against `sum(rows)`. `pnlDetail` deliberately lifts recoveries out
of `rows` into `recoveries` — a deposit listed among payments reads as money going
out — while `total` nets them. Re-summing `rows` made this fixture accuse correct
code of a $1,500 discrepancy.

### Reporting basis: Financials and Reports legitimately disagree

`/financials` counts from `COALESCE(payment_date, invoice_date)` and includes
unpaid. The Reports P&L is strict cash (`payment_status='Paid'` by
`payment_date`) plus unbooked bank rows. Both pages now state their basis and
cross-link. A third, unresolved reason they differ: **`manual_expenses` is a
second expense table**, written from Financials, the marketing campaigns, and
the QuickBooks CSV import.

`routes/reports.js` **writes** to it — the category-rename path renames its
`category` alongside `expenses` — but never **sums** it, so a rename dutifully
maintains a table the P&L then ignores. (This note used to claim zero references;
that was true before the rename feature and is the more dangerous shape now:
touched enough to look handled, never counted.)

**Nobody can currently measure it.** Every read is artist-scoped —
`financials.js` buckets by `artist_id` before responding, `notifications.js` sums
`WHERE me.artist_id = a.id` — so rows with a null or unmatched artist are
invisible to the API, and both live reads return 0 rows / $0.00 against
production. That is not evidence the table is empty. Answering "what is in
`manual_expenses`" needs a direct database connection, not an endpoint.
Resolve what that table is before trusting either page against the other.

### Artist Campaigns: settled from the statements, committed from the invoices

The page leads with what the BANK paid and uses invoices as the forward view.
Scope is **Marketing + Advertisements** (`CAMPAIGN_CATEGORIES` in
`routes/artist-campaigns.js`). Two layers, one derivation each:

- **SETTLED** — `buildPnl(...).by_artist`, exported from `routes/reports.js` as
  `module.exports.buildPnl`. This page does NOT write its own SQL for campaign
  money: that rollup is bank-basis, funding-pair aware, part-aware, and
  `by_artist.total` equals the P&L expense total by construction. Bound by the
  page's date range.
- **COMMITTED** — ledger rows with no bank line yet, via `bankEvidenceCols` from
  `lib/bank-evidence.js`: unpaid, paid-with-no-statement-covering-it-yet, and
  paid-where-a-statement-should-show-it (counted, but FLAGGED on the card).
  Deliberately **unbounded by date** — an invoice from last November that is
  still unpaid belongs in a forward view — and the header says so.

**The double-count guard is `bank_evidence IS NOT NULL`.** An invoice the bank
has already paid is settled money and must not also be committed. That one
predicate is what lets the two layers be added together.

Artist identity comes from **`lib/artist-key.js` in JS**, never the SQL
`normalize_artist_key()` this page used to group by. They are not the same rule —
`artistBucketKey` also folds placeholders ("N/A", "TBD") into unattributed — and
keying one layer each way gives an artist two cards. A committed-only artist
takes its display name from the most-used spelling on its own rows, the rule
`shapeByArtist` and Recoupments already use; without it the card renders its
bucket key ("nobodyserious").

What the page EXCLUDES is disclosed in `meta.excluded`: in-scope open invoices
dismissed or reclassified "not a campaign expense" (~$81k). They move Committed,
so the header states them.

The unattributed queue lists the Reports artist drill's empty-key bucket per
category and writes through `/reports/set-artist` on `part_expense_ids`. Its list
is GROSS of reimbursements while the band is NET, so the header does that
arithmetic out loud rather than showing two numbers that look like they should
match.

`influencer_campaigns` is untouched and still unused (zero rows, $0 of budget);
only the card's second number changed.

**The detail page and the export read the same two layers** (2026-08-20). Detail
rows carry `in_scope`, `bank_evidence`/`bank_expected` and **`family_source`** —
the family ROOT's `entry_source`, which is what lets the page exclude a slice of a
bank-born payment from its totals while still LISTING it. The row list is
deliberately unscoped: this is where you look at everything for an artist. Verified
in production: the ten biggest-committed artists' detail figures equal their cards'
Committed to the cent.

**Song level is invoice-side, and says so.** `buildPnl`'s rollup has no song
dimension, so song cards, the song subpage and the export's per-song sections say
**"unsettled"** and never "settled". The export gained a **Bank** column per row
(settled / no line yet / PAID, NO LINE / unpaid) and labels its artist total
**"Invoiced"**.

**Converting money in a test?** Use `usdOf`. A verification script that scored
non-USD rows with no locked FX rate as $0 reported three artists' detail figures
below their cards by exactly the value of two EUR invoices and one AUD one.

### Release spend plans — the marketing sheet, as commitments

`/import/spend-plans` (upload + match queue) and a panel on each release's Budget
tab. John, 2026-09-03: *"the attached excel is how we currently track artist
budgets. I want to transfer this over to our app."*

**The sheet.** ONE visible tab, `Expenses`, holding **1,373 releases side by
side** as three-column blocks (Amount | Expense Notes | Who Paid), header in row
1, a printed Total in row 17. **7,083 lines, $4,952,054.13.** The other four tabs
are dead: `Accounting` carried the only real budget-vs-actual model and stops at
November 2021; the stream/listener tabs end in 2022. None is read.

**THE PLAN IS THE COMMITMENT, THE LEDGER IS THE ACTUAL, NEITHER OVERWRITES THE
OTHER.** 111 (artist, song) pairs exist in both the sheet and `expenses` and
**not one of the 111 agrees** — the sheet is bigger where spend is committed but
unpaid ($1,792,302 of "not yet"), the ledger is bigger where money moved that the
marketing sheet never tracked. So there is no arithmetic that reconciles them,
only a choice of which to believe. Nothing here writes to `expenses`;
`release_id` is the only join and the variance is reported, not resolved.

**A fourth budget model, chosen deliberately.** `recording_budgets` (7 drafts, 0
line items), `artist_budget_items` (1 row) and `artist_budget_sections` are the
other three. Not folded into `recording_budgets` because its line items carry
`CHECK (section IN ('producers','studio','mixing_mastering','musicians','travel',
'other'))` — a RECORDING vocabulary — and this sheet is marketing. All 4,435
lines in its top ten channels (marquee 995, showcase 536, masked mortal 439,
youtube ads 419, axel tanner 383, fb ads 367, PR 352…) would have landed in
`other`, flattening the one column worth importing. John made that call knowing
it is a fourth parallel model.

**Matching links on EVIDENCE, never on a score.** The header order is not
consistent — 957 read `Artist - Song`, 57 read `Song - Artist` — so both readings
are tried against `releases` and a block links only when some release actually
carries that exact (artist, project) pair. Everything else goes to a queue with
ranked suggestions that a person clicks. Against production: **1,014 link, 47 are
duplicate releases in our own table, 2 are genuinely ambiguous, 310 need review.**

**Suggestions score the ARTIST AND THE TITLE, weighted 0.65/0.35.** Scoring the
title alone — the obvious version, written first — proposed *"Maximo — Lights"*
for `Darci - Lights` and *"Rachel Levin — My Way"* for `Tim North - My Way`, both
at a confident 1.000. The queue exists so somebody accepts a suggestion, so a
wrong top suggestion is worse than none.

**Recoupability is NOT importable from this file.** The legend reads "Red = Non
Recoup"; every cell style in the workbook was checked and there is **exactly one
red cell** (T4), no red font defined at all, and no conditional formatting.
`expenses.recoupable` stays the only place that answer lives.

**"Who Paid" drifted from a person into a status** — 2,949 "not yet", 1,686
"paid", 67 distinct values. Bare person names (Tyler, Felipe, Boom — ~40 rows,
all in the oldest blocks) map to **NULL, never to paid**: "Paid Felipe" reads
paid because the word is there, "Felipe" alone is not evidence money moved.
`status_raw` keeps the original cell so the mapping is revisitable.

**Reported, not corrected**: 10 printed totals disagree with their own lines, 46
totals come from a formula this workbook stores with no cached result (all
genuinely $0 — those alone are derived, flagged `total_source='derived'`), and 49
amount cells hold prose ("625 advance", "FREE") which import with a NULL amount
and the text on `amount_raw`. Coercing "625 advance" to 625 is *probably* right,
and probably is not good enough for a number feeding a commitment total.

**`applyImport` never overwrites a queue answer.** `release_id`, `match_status`
and `match_order` are written on INSERT only; a re-import refreshes the money and
leaves the matching alone, or a second run would silently undo a person's work.

**Set-based writes, and that is a requirement.** Row-by-row was ~8,500 round
trips and took **over four minutes** against a hosted database; the in-app upload
runs inside one HTTP request, so Cloudflare would have replaced it with its own
error page. `UNNEST` + chunked line inserts: **4.5 seconds.**

**A split family sums EVERY row, parent included** — the split writers do
`SET amount = first.amount` on the parent and put the rest on children, so
`parent + SUM(children)` IS the invoice. This route was written leaf-only first
and `scripts/spend-plan-fixture.cjs` caught it: a $900 family reported $600. Note
`artist-budgets.js` filters leaf-only and therefore disagrees; that is
pre-existing and moving its numbers needs its own decision.

`server/scripts/spend-plan-fixture.cjs` — 19 assertions covering spent-vs-open,
the commitment figures, the split-family sum, `usdOf` per row with rounding at
the row, that link/unlink/skip leave the ledger byte-identical, and that linking
to a non-existent release is refused. **Verified it can fail** — it scored 17/19
against the leaf-only version and named the bug.

```bash
cd server
node scripts/import-spend-plans.js            # dry run, reports everything above
node scripts/import-spend-plans.js --apply    # writes
PORT=3011 node index.js & node scripts/spend-plan-fixture.cjs
```

### Artist spend sheets — a budget per artist, actuals matched to it

`/artist-budgets` (index) and `/artist-budgets/:artistKey` (one sheet). The sheet
is an **outline grid**: the six **category sections** (`bk_categories.ui_group`),
their categories underneath, and each category's expenses under those. Every
expense lands in its category by its own category field — nothing is assigned by
hand. One column set at every level — **Budget · Spent · Open · Committed ·
Variance · %** — so a column means one thing wherever you read it.

**The budget is typed on the CATEGORY rows, and a section is the sum of its
own.** John, 2026-09-15: *"it should look more spreadsheet like"* and *"the
section total is the sum of its children and stops being typed directly."*
`artist_budget_categories` holds at most one row per (artist, category); the
section figure is DERIVED in `buildSheet` and its Budget cell is not an input.

**The move cost nothing, which was checked first.** `artist_budget_sections` held
**ZERO rows across all 156 artists** — the budget half of this feature had never
been filled in — so there was nothing to migrate. That table and its `PUT
/:artistKey/:section` route both stay; anything found in it is added to its
section as `legacy_budget` and labelled `legacy` on screen and in the workbook,
because a budget that vanishes on deploy is worse than one that needs explaining.

**There is still no "create a budget" step, and there must not be.** That is
where this feature died three times: all 7 `recording_budgets` are `draft` with
**zero** line items (five created inside 40 minutes), and `artist_budget_items`
holds **1 row** across the twelve biggest-spending artists. What makes 32 cells
different from those attempts is that nothing has to be created — every category
in the live vocabulary is already a row with its actuals beside it, typing in one
IS the budget, and a column pasted from Excel fills all of them at once. Setting
a cell to 0 **deletes** the row, so "no budget" and "a budget of nothing" stay one
state and `unplanned` keeps meaning something.

**THE SHEET HAS TWO GRAINS, and they are two PARTITIONS of one artist's money —
not one nested inside the other.** John, 2026-09-15: *"the budgets should be
artist based but also release based. take a look back at the original excel as
reference."* A **Group by** control switches the whole sheet between Category and
Release; each grain stores its own budget (`artist_budget_categories`,
`artist_budget_releases`) and the totals row reads whichever is on screen.

**The original excel is `Copy of Boom.Records.xlsx`** (11,788,992 bytes — the
~11.8 MB the importer documents), and BOTH of its budget models are
release-shaped. The visible `Expenses` tab is one three-column block per release
(`Artist - Song` | Expense Notes | Who Paid, line items down, printed Total at
row 17). The hidden `Accounting` tab is literally

    Artist | Project | Release Date | Planned Marketing | Amount Spent |
    Where allocated | Amount remaining | Amount Recouped

which is this app's Budget / Spent / Variance columns with RELEASE as the row.
Artist-level category budgets are this app's invention; **per-release planning is
what the label has always actually done.**

**They can disagree, and the page says so** rather than picking a winner. A line
above the grid reads "planned $X by category and $Y by release — the same money
split two ways, so neither is wrong, but one of them is out of date." The export
carries the same sentence on its **By release** sheet. `GET /artist-budgets`
returns `release_budget` ALONGSIDE `budget` and never sums them: adding both
would report an artist who planned $50k twice as having planned $100k, while
leaving release budgets out entirely would make a release-budgeted artist read as
having none — the same disagreement that index already had to be fixed for once.

**56% of an artist's spend names no release**, measured on 3,582 live ledger rows
before building: 1,595 name an artist, only 695 name a release. So the release
grain carries an explicit **"No release named"** row for the residual, and it is
**READ-ONLY** — a residual is not somewhere to plan, and a budget cell there
would invite planning against "everything not attributed yet". Dropping it would
report a third of the artist and look complete; the fixture asserts
`releases + residual == the artist's spent`, and removing the residual turns it
red by $1,962.

Campaign-category rows have the best release coverage (52%), which is consistent
with both excel tabs planning MARKETING per release.

**Category rows are the UNION of three sources** — the live vocabulary (so a
category with no spend yet is still a row to plan in), anything carrying spend,
and anything carrying a budget. A category retired out of `bk_categories` is
therefore still shown, marked `retired`, rather than taking its money off the
sheet with it.

**The grid's own behaviour**: header, totals row and label column are frozen;
↑ ↓ / Enter / Tab walk the **visible** editable cells (a collapsed section is
skipped — typing a budget into a row nobody can see is the failure); Esc reverts
via a ref flag, because setting the draft back and blurring races React's
re-render and the stale DOM value would be saved. **Pasting a column from Excel**
previews every cell it would change before writing, skips anything that is not a
number instead of storing a zero, and commits through `PUT
/:artistKey/categories` — ONE transaction, validated in full before any row is
written, so a bad cell in the middle leaves nothing behind.

**Sort and filter reduce the totals row with them.** The footer sums the rows ON
SCREEN, says `filtered` when it is a subtotal, and states what the whole sheet
holds beside it. A section carrying a legacy budget survives any filter, since
that money belongs to no category and a category-first filter would otherwise
lose it.

**The index reads BOTH budget tables.** `GET /artist-budgets` summed only
`artist_budget_sections`; left alone it would report "no budget" for every artist
whose budget had actually been typed — the same surface disagreeing with itself
one click apart.

**Keyed on `artistBucketKey`**, never a raw name — so "Jerri" and "jerri " are one
sheet and a placeholder ("N/A", "TBD") opens none. Every earlier budget surface
matched `LOWER(TRIM(e.artist))`.

**SPENT and OPEN are separate, and that is the point.** An unpaid invoice is not
an expenditure, so it is NOT in `spent`: it goes to `open`, gets its own section
on the sheet (oldest first, it is a worklist), and the two add into `committed`.
Jerri before the split read $781,522 "spent" when $460,680 of it — 59% — was
invoices nobody had paid. `variance` sits beside `spent` and measures against it;
`over_committed` is a separate flag, because a budget can be intact on spend and
blown on what has been promised. A category row carries **Spent and Open in
separate columns**, exactly as its section does, so each column still sums to the
section above it — they are never blended into one "actual", and the open-invoice
worklist below lists the same money BY PAYEE rather than adding it a second time.

**The four states are `recoupState()`, reused not re-implemented.** John's *"paid
but its statement hasn't been uploaded yet → paid but not confirmed done"* is
`awaiting_statement`; `unverified` is the real discrepancy (paid, a statement
covers the date, no line matches). The endpoint carries `bankEvidenceCols()` so
the client derives the same states Recoupments does. **The four must sum to the
section total exactly** — the fixture asserts it per section, because the band and
its list have disagreed here twice.

**`buildSheet()` is a plain function, not a route handler**, because the JSON
endpoint and the Excel export both build from it. Two code paths producing "the
same" totals is how a spreadsheet somebody emailed outside the company stops
matching the screen it came from.

**Leaf rows only** (`NOT EXISTS (children)`): a split family's children carry the
attribution and the parent carries their sum, so counting both doubles every split
invoice.

**Rounding happens AT THE ROW (`rowUsd`), not at the totals**, and that is
load-bearing here rather than stylistic. A sheet slices the same rows two ways at
once — by state and by category — and both must add up to the section total on
screen and in the workbook. Rounding each subtotal independently cannot give you
that: shipped that way first, and production proved it in under a minute —
Jerri's four states summed to $781,522.61 against an actual of $781,522.62,
because a foreign row converts to a fraction of a cent and each subtotal absorbed
a different part of it. The dev fixture passed because every amount it created
was a clean number; it now includes GBP/EUR/AUD rows chosen to produce repeating
decimals in different states. Section `actual` is DERIVED from the four states so
the partition holds by construction.

**Removed:** `/artists/:id/budget` no longer returns `budgetItems` / `ledgerRows`.
Nothing read them, and the ledger query was a SECOND definition of spend and the
wrong one — `LOWER(TRIM(e.artist))`, no bank-evidence join, so an unpaid invoice
counted as money spent. Measured before removal: **31.3% of what it called spend
($538,345 across the eight biggest artists) was invoices nobody had paid.** Its
`dealSummary` STAYS — `Recoupments.jsx` is the only consumer and reads exactly
that. `artist_budget_items` and `release_budgets` are left in the database,
unread; dropping a table to tidy a feature is not reversible.

**Kept, deliberately:** `/budget` ("Recording Budgets") is a different question —
a port of the label's recording Excel template with draft → approve → lock. Its
uncalled `PUT /financials/release-budgets/:releaseId` also stays: it writes to
`recording_budgets`, so deleting it would be editing the kept feature to tidy this
one.

**No approval gate.** Nothing blocks an invoice for being over budget; the sheet
reports, it does not enforce.

**Covered by two harnesses, and `npm run smoke` is not one of them** — the page
renders its loading skeleton under `renderToString` and reports "ok, 946 bytes"
for a grid that drew no rows.

```bash
cd server && PORT=3011 node index.js &
node scripts/artist-budget-grid-fixture.cjs   # 78 assertions
cd client && npm run budgetsheet-dom          # 79 assertions
```

The server fixture pins the grain (a section is its children, zero deletes, a
paste is atomic, a differently-cased name writes the SAME cell, the index agrees
with the sheet) and asserts **every key the grid reads**, including that the row
count equals the live picker's vocabulary rather than a number written into the
test — the dev database carries 28 categories and production 32. The DOM harness
drives the grid: the section cell is not an input, the totals row follows the
filter, the keyboard skips a collapsed section, a pasted column lands on the
right cells. **Verified they bite:** reducing the totals over the server's
figures instead of the visible rows, putting hidden cells back in the keyboard
order, dropping the no-release residual, and leaving the totals row reading the
category grain under a release body — each turns something red.

One of those took two goes, and the lesson generalises. The first version of the
release-grain footer check asserted on SPENT, which is **the same under both
grains by construction** (they partition the same money), so breaking the footer
left it green. BUDGET is what differs — 5,277 by category against 2,000 by
release in the fixture — and asserting on that is what catches it. If an
assertion cannot distinguish the two states, it is not testing the thing its
label claims.

### The index is a queue, not a directory

`Recoupments.jsx`, the `!isDetail` branch. It was a 2-up grid of 145 artist
cards and the complaint was that it felt crowded, which it was — three progress
bars, a four-part caption, two chips, a cobrand pill and five hover buttons per
card. But crowding was the smaller half.

**Nothing on it narrowed anything.** Every one of the 145 artists has items
pending upload, so "who needs costs uploaded" answered *everyone*, and a flat
grid cannot rank that. What separates them is whether the bank can already
prove the spend. Measured 2026-09-08, under the page's own `normalizeArtistKey`
grouping — a plain lowercase key reports 152 artists / 107 / 30 / 15, because it
does not collapse "LIFE/LINE" and "LIFELINE":

```
  partition               artists                       page-wide band total
  Ready to upload            104   623 items            $1,167,192  verified + not UFR
  Nothing provable yet        27   $45,939 + $17,373      $528,114  awaiting a statement
  Nothing to do               14   $13,460                $397,302  unpaid — never recoupable
  (flagged, cross-cutting)     9   43 items · $134,681     $90,696  UFR'd with no bank line
```

The left figures are what each PARTITION holds; the right column is the
page-wide band the summary line prints. They differ a lot and neither is wrong:
an artist with one provable item and $200k awaiting a statement sits in *Ready
to upload*, and all $200k of their awaiting money is counted in the page-wide
band but in none of the folded partitions. Do not quote one for the other.

And the work is concentrated: the top 10 rows hold **60%** of the provable
dollars, the top 20 hold **74%**, the top 30 hold **83%** (32% / 51% / 64% of
the items — the top of the list is bigger money, not more of it). One screen can
hold two-thirds of the job — but only if it is ranked by provable dollars, which
is now the default sort (`indexSort = 'provable'`, was `'unverified'`; the
unverified money sits on a handful of artists and ranked the exceptions above
the work).

**The card led with the wrong number.** The big bold figure was the artist's
LIFETIME recoupable total — a number that does not move as the agent works, so
it is not a to-do. "Unclaimed" was a gray fragment at the end of a caption.

**Three partitions, one predicate.** `canUpload` is
`provableUnclaimedItems.length > 0` — the same list the Ready column displays
and the ranking sorts on, so a row can never sit in "nothing provable" while
showing a provable figure. Everything else folds away: *Nothing provable yet*
(waiting on a statement) and *Nothing to do* (unpaid only). A fourth section,
*Uploaded with no bank line*, is **cross-cutting, not a partition** — those
artists also appear in the queue above. It is the only band that is an ERROR
rather than a queue position, small enough to name every one (9 artists / 43
items / $134,681), and it is why the row's only red is that flag.

**The four `*UnclaimedItems` lists live in `computeGrouped`**, alongside the
existing `provableUnclaimedItems`, and `pendingBands` is their page-level twin.
Both are partitions of "pending" by `recoupState`, so the row columns, the
summary line and the sort all reduce over the same rows and cannot drift. Do not
compute a band inline in a render site.

**Folded sections persist an OPEN marker, not a collapsed one** (`open:${key}`
inside the same `collapsed` Set). Absence in that Set means *expanded*, so a
default-closed section is not expressible with the normal keys — the three
sections shipped open on the first harness run, putting 45 artists nobody can
act on straight back above the fold.

**The header stack became one line.** Five stat tiles, a collapsible claim
panel, an audit strip and an always-open notes textarea are now a single summary
line with Notes behind a disclosure. Two tiles were answering a different
question: `Pending Upload` summed $2.18M out of the four bands above, only
$1.17M of which can be uploaded today, and
`Paid` / `Unpaid` described cash flow — an unpaid invoice cannot be uploaded at
all, so it is not a to-do. **The tile grid is still on the artist subpage**,
gated `isDetail`; only the index lost it. Its `Pending Upload` note used to
toggle the (now deleted) claim panel and calls `claimForRecoupment` directly.

**`claimForRecoupment` stayed the only writer.** The summary line's *Upload all
N* and each row's *Upload N* both call it, so there is one confirm, one
`POST /bk/entries/ufr-bulk` and one refetch path.

**Row controls are siblings of the row's `<Link>`, never descendants.** The link
is `absolute inset-0 z-0` under a `pointer-events-none` content layer, so a
click on empty row space navigates while every button lives outside the Link's
DOM tree. Inside a Link, react-router intercepts the synthetic click before the
bubble path is honored and `stopPropagation` on a nested button is not enough —
the same reason the old card's action overlay was a sibling.

**Verified by `cd client && npm run recoupqueue-dom`** (55 assertions,
`scripts/recoupqueue-dom-{run.mjs,entry.jsx,api-stub.js}`). `npm run smoke`
cannot cover any of this: it renders under `renderToString` where effects never
fire, so the page only draws its loading skeleton and reports ok for a queue
that drew nothing. The harness fixture carries one artist per band because live
data cannot pin a partition whose membership moves every time a statement is
uploaded. **Verified it bites:** reinstating the old `pending > 0` test for
"can upload" turns seven assertions red; rendering the folded sections open
turns five red.

### The artist subpage has one grouping level

`Recoupments.jsx`, the `isDetail` branch. The index became a queue first (above);
this is the same disease one page down, and it was the bigger half of it.

**Every item sat at the bottom of a four-level tree** — a statement tab strip,
wrapping four stacked state sections, wrapping song groups, wrapping category
buckets, wrapping label buckets. Counting only headers that actually render,
measured on production 2026-09-14:

```
                       headers   note
  state sections           268   4 stacked panels per artist
  song groups              583   a song in two bands got two headers
  category buckets         667   524 of them (79%) wrapped a SINGLE category
  label buckets             12   the whole 4th level, across all 146 artists
  TOTAL                  1,530   around 1,209 pending rows — 1.27 per row
```

It was worst where there was least to organise: omnom's 20 rows sat under 29
headers, beno's 21 under 29. **Both inner levels were restating a chip the row
already carried** — a "Marketing" bar over a list that was entirely Marketing,
one indent to the left of every row's own Marketing chip.

**Song is now the only grouping level; both axes became filters.** The four
`recoupState` bands are chips (the same bands the index queue partitions on, so
the two pages cannot disagree), and the statement period is chips too. Result:
**1,532 headers → 446, 0.37 per row, −71%**, and a song gets one header instead
of one per band it appears in.

**What the sections carried had to go somewhere, and it did.**
- *Priority order.* Rows sort unverified-first inside a group
  (`byStateThenAmount`), which is the order the four stacked sections imposed.
- *Per-row state.* Each row gets a **2px left rail** in the four band tones. It
  deliberately is NOT `BankEvidenceDot`: that shared component renders nothing
  for `awaiting` and `unpaid` on purpose ("a grey dot on every row of an
  un-uploaded month trains people to ignore the dot"), which was fine when a
  section header named the band and is a hole now that none does.
- The rail is what the BANK says; the emerald wash and the UFR badge are what WE
  claimed. Two channels, two orthogonal axes — the split the page already states
  as *"the stamp says we CLAIMED this money; the dot says whether the BANK can
  prove it"*.

**`stateCounts` counts `statementFiltered`, never `detailItems`.** A chip has to
keep saying how many rows it would show AFTER it is clicked; counting the
filtered list makes every other chip read 0 the moment one is active.

**Three row washes, down from six.** `entry_source` is NULL on 90.2% of rows and
its two tints fired on 0.6% (`recoupments`) and 8.5% (`artist_campaigns`) — a
colour vocabulary to learn for under a tenth of the list, competing with the rail
you act on. Provenance moved into the row tooltip, which already said it.

**The detail tiles went 5 → 3 (+ Deal) as a consequence.** Paid and Unpaid
described cash flow, and the band chips now name all four bands with live counts
a few inches below — two readouts of one partition is how a page starts
disagreeing with itself. The per-band note under "Recoupable · bank basis" went
for the same reason. Same call the index made a week earlier.

**The statement tab CARD became chips** — 130 of 146 artists have no UFR'd month
at all, so for them that full-width card held Pending / Uploaded / Total and
nothing else.

**`bucketBySecondary` and `bucketByLabel` are deleted**, along with the
`s:` and `l:` collapse keys they generated. Collapse-all walks one level now.

### Controls are gated on somebody using the feature

Measured 2026-09-14: `is_2025_expense` is set on **0 of 1,414** recoupable rows,
and `ready_for_planning` on **0 of 146** artists — yet the 2025 tag rendered a
grey button on every one of 1,209 detail rows, and the planning filter held a
slot in the index filter bar.

**Only controls that cost space AT REST are gated** (`count2025 > 0`,
`anyReadyForPlanning`). No hover-reveal affordance is: those cost nothing when
idle and are the only way to create the first one, so gating the way IN would
make the feature unreachable forever and the gate permanent. The group header's
hover-only "Mark 2025" is what brings the whole 2025 UI back.

Song-level status is NOT gated and must not be — `/bk/song-status` has 89 rows,
**48 finished and 5 ready_for_planning**. Only the ARTIST-level marker is unused.

The artist-note card is gated the same way: it used to hold a full card's height
on every subpage to offer "Add note…", so the card now renders only when there
is a note and the entry point is a **Note** button in the header row.

**Verified by `cd client && npm run recoupqueue-dom`** — 97 assertions, the same
harness the index queue uses. Its Oxis fixture is shaped so the OLD tree rendered
thirteen headers around six pending rows (the arithmetic is in the stub), and the
key assertion is structural rather than class-based: **a row's parent is the
group card**, so any surviving bucket would be a `<div>` in between. **Verified it
bites:** dropping the state-rank sort turns 2 assertions red, collapsing the rail
back to the shared dot's two tones turns 4 red, and counting the chips off the
filtered list instead of the period turns 1 red.

### The recoupment audit: is anything missed, is anything over-claimed

`/recoupments/audit` (`RecoupmentsAudit.jsx`) answers the question the
Recoupments page cannot ask about itself. Five checks, one endpoint —
`GET /bk/recoupment-audit` — because each is a predicate about money and those
are exactly the ones that end up in three files disagreeing. The page derives no
money of its own. Measured before it was built (2026-08-20):

    advances          13 rows   $391,958.60   bank-verified, no artist, unanswered
      of which Advance  11 rows   $390,530.22   the rest is Tour/Live + Artist Expense
    bank pile      1,919 rows $3,007,397.33   never judged recoupable, unreachable
    claimed twice      9 grps    $30,760.97   3 of them span two artists
    no document       16 rows    $68,928.68   claimed with no file to show anyone
    half a payment    10 fams     $6,239.00   part of one payment claimed

**`GET /bk/recoup-review` no longer requires an artist.** That clause admitted 53
of the 1,972 unanswered statement rows and left 1,919 ($3.02M) unreachable — not
on the page, not in the queue, not counted anywhere. Among them 11 payments in
`Advance` worth $390,530.22, which is an artist's own money by definition. The
POST now takes an optional `artist`, because for a bank-born row "is this
recoupable" and "whose is it" are one decision; it `COALESCE`s, so a bulk answer
never overwrites a name somebody typed.

Two fields exist so the person answering is not guessing, both computed once per
request in **`lib/recoup-context.js`** (correlated subqueries here would re-scan a
3,700-row table 1,919 times — the shape that made `/statements/all` take 17s):

- `artist_proposal` — an artist whose name the payee contains. Fires on 4 of the
  11 advances and 9 rows of the whole pile, so it is a convenience on a row a
  human is reading, never a mechanism. 4-character floor: shorter keys match
  inside almost any company name.
- `ledger_twin` — an invoice-side row at the same payee and amount. True on 28
  pile rows; the Oxis Music, LLC $10,000 advance has THREE. Answering
  "recoupable" there would claim the same cost twice. Equality on the squashed
  name, not containment.

**`recoupment_class_rules`** (`lib/recoupment-class.js`) is what lets the queue
finish: 560 of those rows are Bank Fees worth $3,251.43 between them, and
per-row review gives a $12 card charge the same ceremony as a $200,000 advance.
Eight category rules take $2,074,917 of Royalties / Salary / partner draws / Rent
/ cards off the queue. Third use of this shape after `statement_no_invoice_rules`
and `label_level_spend_rules`, with the same three properties: it writes nothing
to the ledger, deleting it puts the rows straight back, and it moves no money —
those rows are already off the page via `withoutUnreviewedBankRows`. Distinct from
`recoup_reviewed`, which is one person's decision about one payment and persists.

**EQUALITY, never substring**, and here it is load-bearing in both directions:
`Salary` and `Salary (Felipe)` are separate live categories, as are
`Partner - Felipe` and `Partner - Tyler` — so eight decisions are eight rules.

**A category rename carries the rule.** `POST /reports/rename-category` now
renames `recoupment_class_rules`, `label_level_spend_rules` and
`statement_no_invoice_rules` alongside the ledger; all three had the same gap, and
renaming "Royalties" would otherwise have put $600,000 back in the queue with
nothing to explain it. Each has a uniqueness constraint, so a rename INTO an
existing rule deletes the source first — it is a merge, and the target already
says the same thing.

Not included, deliberately: **"claimed with no bank line"** (48 rows,
$141,891.83) already has a chip on the Recoupments page. **Late by statement
cycle** is measured — 561 items / $1,050,338 have missed at least one 20th-of-the-
month statement, 140 of them 6–7 cycles — and left out by choice; it needs only
`statementMonthFor`, already in `Recoupments.jsx`. And **`recoupable` is still
`BOOLEAN DEFAULT TRUE`**: 1,292 rows read recoupable because nobody looked, and
only the 179 marked *non*-recoupable ($694,141.93) required an act. Until that
asymmetry is fixed this page can show exceptions but cannot *prove* completeness.

### The ad pool: label-level spend, and amounts assigned out of it

Ad-platform charges name no artist and never will. Measured on the 490
unattributed Advertisements rows (2026-08-20): **489 of 490 are `invented`** —
booked from a bank line with no invoice — and **zero** carry a song, an artist or
a campaign. The descriptors are merchant ids repeated on every charge
(`SPOTIFY USA INC 180-09525210` on all 168, `FACEBK *F4EE6X5GP2`). Inferring the
artist from dates against the release calendar would be a guess dressed as a rule.

**`label_level_spend_rules`** (scope `vendor` | `category`, EQUALITY never
substring — "TONE" is a substring of "Tone Pay, Inc") declares a class of spend
label-level. `buildPnl` then routes it to a THIRD bucket beside the artists and
the unattributed:

- **The P&L total never changes.** `by_artist.total` = attributed + unattributed +
  label_level, and still ties to the expense total.
- **A rule never overrides a real attribution** — a charge someone named an artist
  on keeps it. The rule only speaks where the question is unanswered.
- **The drill loses the same rows the bucket does**, so a queue can't offer what
  the report no longer counts.
- `coverage_pct` is now over ATTRIBUTABLE spend; `coverage_pct_of_all` keeps the
  old harsher reading beside it.

**`ad_pool_allocations`** was how a person's knowledge entered: an amount per
artist per MONTH, drawn out of the pool, moving REPORTED money only.
**`POST /reports/ad-pool` is retired** (2026-08-25) in favour of
`/bk/advertising` — see the next section. `GET` and `DELETE` stay so a row
written before then is still visible and removable, and the whole label-level
mechanism above is untouched. `applyAllocations` still runs, so any surviving row
still moves the P&L: it is applied in creation order and **trimmed** where the
pool runs out, with `label_level.trimmed` saying so, and
`label_level.allocated_by_artist` reporting how much of an artist's figure came
from an assignment rather than from a row naming them. On production there are
**zero such rows**, which is why retiring the write cost nothing.

Live as of 2026-08-25: rules on `SPOTIFY USA INC`, `FACEBOOK`, `PP SPOTIFY` —
**$280,914.09 over 435 charges** (Jan–Jul 2026: $13,240 · $18,489 · $46,641 ·
$53,368 · $62,281 · $50,103 · $36,793). Campaign coverage went 68.87% →
**98.01%**, the unattributed campaign queue 610 rows/$292,259 → **177
rows/$13,145**. A vendor rule has no category bound, which is why the pool has an
`Other` line: two $900 FACEBOOK charges filed under Other rather than
Advertisements.

### Allocate Advertising: the ad pool, written to the LEDGER

`/bk/advertising` (`pages/AdAllocation.jsx`). The reporting-side pool above was
never used ONCE — $267,674 across Feb–Jul 2026 and **zero allocations in six
months** — for two reasons this page fixes:

1. **It asked for an amount with no basis.** A chip opened a box wanting dollars
   per artist per month, with no campaign, no charge list and no evidence. The
   guess was unfalsifiable, so nobody made it.
2. **It wrote nothing to `expenses`.** It moved the P&L and Artist Campaigns'
   Settled layer and stopped there, so an allocation was invisible to
   Recoupments, the artist spend sheets and the recoupment audit — every surface
   that decides what an artist owes back.

**A campaign is the basis.** `influencer_campaigns` is reused with
`platform='Facebook'` and no creators; one campaign names one artist and
(usually) one song, and splitting happens at the CHARGE. That makes the
many-to-many fall out for free — one charge can fund several campaigns and one
campaign span several charges — so none of the settlement-group machinery is
needed here.

**The write is a real split family**, and the slices carry four columns the
shared split writer does not:

- `entry_source` inherited from the root. `POST /bk/entries/:id/split` omits the
  column, so its children come out NULL and read as hand-entered invoices — the
  documented 88-row / $55,470 leak. Setting it sends these rows through the
  designed gate instead of that hole.
- `recoup_reviewed` + `recoupable` — the gate itself.
  `withoutUnreviewedBankRows` admits a bank-born row ONLY when the first is true,
  so without them "mark them reviewed and recoupable" would write to columns
  nobody reads.
- `campaign_id` (new on `expenses`, also in `EXPENSE_LIGHT_COLS`) so a campaign's
  spend is a query. **Two link directions now exist and both are real**: a
  creator/cobrand campaign points AT its invoice (`ic.expense_id`), an ad
  campaign is pointed at BY its slices. `routes/artist-campaigns.js` COALESCEs
  both; reading only the first showed an allocated slice no campaign at all.

Which is why it does **not** call the shared writer. Fixing `entry_source`
inheritance there is a separate, reported-number-moving decision.

**Bank is the money, Ads Manager is the basis.** A CSV import supplies
PROPORTIONS only — its spend becomes weights and the month's actual charges are
divided by them (`proportional`), so 100% of real money is apportioned and there
is no reconciliation remainder to park. The importer **maps its own columns**
(remembered per platform in `localStorage`) rather than assuming a layout: no
sample export exists, and a parser written to guessed column names fails on the
first real file.

**Two arithmetic properties, both load-bearing.** `POST /entries/:id/split`
never checks that its slices sum to the parent — it sets the parent to
`first.amount` and inserts the rest verbatim — so `lib/ad-allocate.js` apportions
in **integer cents by largest remainder** ($422 three ways is 140.67 + 140.67 +
140.66, not 3 × 140.67 = 422.01) and the route asserts `Σ(family) == charge`
before COMMIT. Over-allocation is **refused with both numbers**, never trimmed.

**The charge list comes from `buildPnl`'s own decision**, via a new
`collectLabelLevel` option: the label-level test lives at one call site and this
page lists exactly the rows it fired on. `/pnl/detail` deliberately drops those
rows, so the alternative was a second query with its own idea of label-level —
the shape that once had the drill at $3.73M against a report saying otherwise.
`GET /ad-months` groups ONE such call by month rather than running a P&L per
month.

**A finished charge is still listed.** Once every slice names an artist the
charge is no longer label-level, so the collector cannot see it — and listing
only the collector's output made a completed charge VANISH, taking its allocation
out of the month's total. The root ids are therefore the UNION of the collected
roots and the roots of families already carrying a `campaign_id` in that month.

**Ordering is on a normalized ISO day, never `String(pgDate)`** — that is
`"Tue May 04 2032 …"`, so `localeCompare` sorts by WEEKDAY NAME and the greedy
draw consumed the 10th before the 4th. Same trap as
`String(payment_date).slice(0,4)` returning `"Mon "`.

Both of those bugs passed `vite build` AND `npm run smoke`, and were found by
`client/scripts/adalloc-render-check.jsx` — which renders the components against
a REAL payload captured by `server/scripts/ad-payload-capture.cjs`. smoke renders
a page in its LOADING state, so data branches never run; that harness is how you
cover them. `server/scripts/ad-allocate-fixture.cjs` (60 assertions) proves the
P&L expense total is identical before and after every split, that `by_artist`
still partitions, that a real artist beats the still-live FACEBOOK rule, and that
undo restores both the charge and the pool.

**Allocating moves up to $291k onto the recoupment surfaces.** That was John's
explicit call, knowing it.

### A drill row edits PARTS, not the payment (`part_expense_ids`)

A split payment is one bank row and several ledger rows — a parent plus a child
per slice, each with its own category, artist and amount. The P&L reports the
slices (`attachSplitParts` → `txnParts` → `splitUsd`), so one payment can appear
in several cells, each for its own share, and `split_of` says so on the row.

Every part carries **its own expense id**, surfaced as `part_expense_ids` on the
drill row: only the parts whose share THIS cell counts. `expense_id` still means
the family root, because file flags, `evidence` and the document buttons resolve
there. Three shapes, and the client (`partIdsOf` / `editableHere` in
`Reports.jsx`) turns on the difference:

1. **Unsplit** — one id, the root. Unchanged behaviour.
2. **Parts in different cells** — `split_of` set, one id here. Editing moves that
   part; the rest of the payment keeps its own labels.
3. **Parts all in THIS cell** (split by artist inside one category) — `split_of`
   is NULL because the cell holds the whole payment, and there are several ids.
   Editing applies to all of them. Writing only the root moved one slice and left
   the others behind; 42 live rows are this shape.

Only shape 2 with several parts in one cell (an artist cell spanning two
categories) has no single answer, and that one still goes to Bank Matching.

**Writing a part means keeping `expenses.artist_breakdown` in step.** That JSON on
the parent is a denormalized copy of the family, read by the breakdown editor and
two sensors in `routes/flags.js`. `lib/split-breakdown.js` updates the ONE matching
slice: by position (the split writer does `const [first, ...rest]`, so member i is
slice i) when the counts match and the amounts agree pairwise, otherwise by a
unique amount-plus-old-value match, and if two slices still match it writes
nothing and returns the reason — which `/set-artist` reports as
`breakdowns_stale` and the client shows. Never guess which half of a payment
somebody meant. It also never CREATES a breakdown: a song-split family has
children and a NULL breakdown, and populating one would hand the editor a list it
never had.

`/reports/set-artist` also serves "Attribute all N", so which rows even need a
resync is settled in one query before the loop — not three queries per row.

### An invoice's date is one day, in the company's timezone

`server/lib/payment-terms.js` owns the terms vocabulary (`Net 15/30/45/60/90`,
`Custom`), the arithmetic (`resolveDue`, date-only UTC math), and **`businessDay`**
— the 'YYYY-MM-DD' an instant falls on in `America/Los_Angeles`.

The printed date and the deadline **must be the same day**, and they were not. The
anchor was the UTC day (`toISOString().slice(0,10)`) while the document printed
`created_at` through `toLocaleDateString`, which is the READER's day. Pacific is
UTC-7, so from 5pm onward those differ: a Net 45 invoice raised at 6pm printed a
date **46 days** before its own due date. 5 of the 21 live invoices already print a day
earlier than the day they were anchored on (only their `Due on receipt` terms kept
it harmless).

So: **the client computes no invoice date at all.** `GET /invoices/due-date`
returns `{ terms, due_date, due_by, invoice_date }` — pass `invoice_id` to re-term
an existing invoice from the date it was issued, pass nothing for a new one. Every
row from this router carries `invoice_date`, and the document prints that string.
`POST` pins `created_at` to the very instant its anchor was read from, so the
stored timestamp cannot land on the next day.

**`boom_invoices.created_at` is TIMESTAMPTZ** (migrated Aug 2026). It was
`TIMESTAMP`, whose stored value means "UTC, trust me" — and node-pg parses a
zoneless timestamp in the NODE PROCESS's timezone, so production read the right
instant only because Railway runs UTC, and the same row read from a laptop in Los
Angeles came back seven hours later. The migration is guarded on the current type,
not `IF EXISTS`: re-running `AT TIME ZONE 'UTC'` against a column that is already
timestamptz shifts every value by the session offset.

**The date is EDITABLE, and it is its own column** (2026-09-15). John: *"I want
to be able to edit the start date of an invoice."* It had been derived from
`created_at`, which is right for a document raised today and impossible to
correct afterwards — and `created_at` must not become the editable one, because
it is the audit record of when the row was made and the whole reason that column
was migrated to TIMESTAMPTZ.

`boom_invoices.invoice_date` is **DATE and NULLABLE**, and null means "derive it
from `created_at`" exactly as before — so every invoice already in the table
prints the date it printed yesterday, with no backfill.

**MOVING THE DATE MOVES THE DEADLINE.** Net 30 means thirty days from the day the
invoice is dated, so `PUT` re-anchors `due_by` / `due_date` whenever
`invoice_date` changes. **Custom terms are the exception** and stay exactly as
typed, because there the deadline was never derived from the issue date. An edit
that touches neither moves nothing — fixing a typo in the description must not
re-date a document the client already has.

**`POST` already accepted `invoice_date` and it was half-wired**: the due date
honoured it and the row still stored `created_at`, so the document PRINTED
`businessDay(created_at)`. An invoice created dated last week printed today and
was due from last week — the precise two-different-days state this module exists
to prevent. Latent, because the form never sent one; reachable from the API,
which is enough. The date is now stored.

**Reads select `invoice_date::text AS invoice_day`, and that cast is not
decoration.** node-pg parses a DATE into a JS Date at LOCAL midnight, so on a
machine east of UTC `toISOString().slice(0,10)` reads the day before. Railway
runs UTC and would never have shown it — the same coincidence of configuration
that hid the `created_at` timezone bug until somebody read a row from a laptop
in Los Angeles. Asking Postgres for the text is the one form that cannot be
misparsed.

The form sends `date=` to `GET /invoices/due-date` as you type, so the preview is
anchored on the date being typed rather than the one on file; `date` wins over
`invoice_id` server-side, which is what makes that work.

```bash
cd server && PORT=3011 node index.js &
node scripts/invoice-date-fixture.cjs     # 32 assertions
cd client && npm run invoicedate-dom      # 21 assertions
```

`npm run smoke` renders this page at **255 bytes** — its loading branch — so the
field under test is in the half smoke never reaches, and this page has gone pure
white once already from a temporal-dead-zone read with `vite build` green. The
DOM harness mounts it for real. **Verified all four bite:** reading the printed
date back off `created_at`, leaving the deadline where it was when the date
moves, dropping `date` from the preview request, and rendering the field without
sending it, each turn something red. The fixture's legacy-row assertion
back-dates `created_at` deliberately — with `created_at = today`, "derived" and
"today" are the same answer and the test proves nothing.

Not fixed here, deliberately: **A/R aging still buckets by `created_at`**, not the
new `due_date` (`routes/reports.js`). Switching it moves a reported number.

### Releases page is a subfolder, not a single file
`/releases` used to live in `pages/Releases.jsx` (~1,700 lines). It now lives in `pages/Releases/` with an `index.jsx` that imports self-contained children:

- `constants.js` — pure constants + helpers (`CHECKLIST_ITEMS`, option lists, `parseLocalDate`, `daysUntil`, `getCompletionPercentage`, `getPriorityBadge`, `BLANK_RELEASE`, `TAB_IDS`, etc.)
- `AddReleaseModal.jsx` — owns its own form state + POST, fires `onCreated(release)`
- `MergeFlow.jsx` — floating action bar + modal; parent owns the selection map (for the per-row checkbox) but modal state + POST live here
- `NotificationBanner.jsx` — collapse state local, `onJumpTo(releaseId)` callback
- `CalendarView.jsx` — owns month state, `onReleaseClick(release)` callback
- `index.jsx` — filters, list view, 7-tab expanded row (checklist / metadata / DSP / budget / activity / comments / details), hotkeys, all data fetching, and cross-child orchestration callbacks

Node/Vite resolve `import Releases from './pages/Releases'` → `pages/Releases/index.jsx`. Do NOT reintroduce a sibling `pages/Releases.jsx` — the file-over-directory resolution rule would shadow the index. When extending the page, prefer a new sibling file in the folder over stuffing the index. The 7-tab expanded row is still in the index on purpose (heavy state coupling); splitting it is future work and requires care.

## Adding a New Page

1. Create page component in `client/src/pages/`
2. Add route in `App.jsx`
3. Add the nav entry in **`client/src/navConfig.jsx`** (`NAV_GROUPS`) — one
   definition, and `NAV_PAGES` flattens it for Settings' My Nav + Permissions
   editors. This used to say "Layout.jsx (`allNavGroups`)" and Settings kept a
   parallel `ALL_PAGES` list; that pair drifted (one page you could neither hide
   nor grant, a group listed in a different order, three disagreeing labels) and
   was consolidated. Don't reintroduce a second list.
4. Add the page title in `PAGE_LABELS` in `Layout.jsx` — deliberately separate
   from the nav label, which is shorter to fit a 200px rail
5. Create backend route file in `server/routes/` (if needed)
6. Register route in `server/index.js` (require + `app.use`)

### Renaming a page: change the LABEL, never the PATH

**Page permissions are stored by path.** Changing a route silently revokes access
for every non-admin holding the old one — `AuthContext.canView` carries an
explicit `/duplicates` → `/flags` carve-out for exactly this reason, and the
`/bk/bank-vendors` + `/bk/vendor-flags` redirects exist so old grants and
bookmarks keep resolving. So a rename touches only the user-visible strings:
`navConfig.jsx`, `PAGE_LABELS`, the page's own `<h1>`, `UserManual.jsx`, and any
export sheet title. Leave the path, the filename, and the API route alone.

Done for **`/bk/ledger-matching`**, now labelled **"Bookkeeper Reconcile"** (Aug
2026). "Ledger Matching" was actively misleading: it reads as the bank
statement ↔ ledger matcher, which is the review deck on `/bk/statements`, so it
was the first thing anyone clicked when looking for that. The page actually diffs
the external bookkeeper's uploaded spreadsheet against our ledger. Its header now
links to Statements for the people who land there by mistake.

## Local Development Database

`server/.env` (gitignored) carries a `DATABASE_URL` pointing at a dedicated Neon
project, **boom-dashboard-dev** — not production. Without it `npm run dev:server`
cannot start, and nothing can be exercised in a browser before it deploys; that
gap caused several production regressions that every static check passed.

```bash
npm run dev:server   # Express on :3001 against the dev DB
npm run dev:client   # Vite on :5173
```

Login after seeding: `johns@boomrecords.co` / the `PW_JOHN` value in `server/.env`.

**SSL is decided by the connection string, not NODE_ENV** (`server/db.js`). It
used to be NODE_ENV alone, so a hosted dev database was impossible — any Postgres
that isn't plaintext-on-localhost was unreachable in development. Production is
unchanged.

### Standing up a database from scratch

Boot **twice**. It is not idempotent in one pass:

1. First boot seeds (`users`, `artists`, …) and creates most tables.
2. Second boot creates what depended on the first pass, and applies the ALTERs
   that run *before* their table's `CREATE TABLE`.

That ordering is a real wart, and it used to be fatal rather than merely
awkward: four `ALTER TABLE expenses` statements sit ~750 lines ABOVE the
`CREATE TABLE expenses` in `runMigrations()`. Uncaught, they threw on a fresh
database, the single try/catch around `runMigrations()` swallowed it, and every
table defined after that point was never created — the app could not stand up a
new environment at all. They now `.catch()` and log `[migration] deferred`.

If you add an `ALTER TABLE x` that could run before `x` exists, catch it. A
fresh-database boot is the only thing that surfaces this class of bug, so test
schema changes against an empty database, not just against your dev copy.

## Changing the Database Schema

Most tables are created in `server/index.js` (not `seed.js`). `seed.js` handles only users, artists, releases, tasks, contracts, deals, requests, and activity_log.

**Adding a column to an existing table**: Add it to the `CREATE TABLE IF NOT EXISTS` block AND add a separate `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration line after the CREATE (so existing databases pick it up without a full reseed).

**If you add a column to `expenses`**, also add it to `EXPENSE_LIGHT_COLS` at the top of `server/routes/bookkeeping.js`. That constant is the explicit column list used by every list endpoint (`/bk/entries`, `/bk/approvals`, `/bk/vendors/:payee`) and mutation pre-check — replacing the old `SELECT e.*` that was pulling multi-MB `*_data` blobs into memory just to throw them away. The four base64 TEXT blobs (`invoice_data`, `w9_data`, `proof_data`, `receipt_data`) are the ONLY columns deliberately omitted. A missed column here silently omits the field from list responses.

If changing `data.json`, bump `SEED_VERSION` in `server/index.js`.

## Dark Mode

### Token-driven approach (default)

CSS variables in `src/styles/tokens.css` define both themes. `tailwind.config.js` aliases (`bg-card`, `text-ink`, `border-rule`, `border-divider`, `bg-overlay`) and the `gray` palette (`text-gray-*`, `bg-gray-*`, `border-gray-*`, opacity modifiers included) all read through those vars. Dark mode works natively — no per-class `.dark` override needed. Prefer semantic aliases in new code; `bg-white`/`bg-gray-*` etc. still work but couple you to specific values.

A small residual `.dark` block lives in `index.css` for things the palette can't express cleanly: color-semantic overrides (`bg-amber-*`, `bg-emerald-*`, etc. get flat-tinted in dark), element-level overrides (`.dark input/select/textarea`, `.dark th/td`), BottomNav, shadows, focus rings, scrollbar. Leave that block alone unless you're migrating one of those cases.

### Inline-styled pages

Six Bk pages (`BkLedger`, `BkApprovals`, `BkPayments`, `BkVendors`, `BkInvoices`, `BkBulkDeals`) use inline `style={{…}}` instead of Tailwind classes for pixel-precise table/layout control (frozen columns, custom stripes, per-row hover tints). For these:

1. Import `getDarkColors` from `../utils/darkColors` and `useTheme` from `../context/ThemeContext`
2. Inside the component: `const { theme } = useTheme()` then `const C = getDarkColors(theme)`
3. Use `C.pageBg`, `C.cardBg`, `C.text`, `C.border`, etc. in inline styles
4. For page-specific overrides (e.g. BkLedger's `rowChild` / `rowParent` tints, transparent input chrome, horizontal edge shadow), spread the base and layer overrides: `const C = { ...getDarkColors(theme), rowChild: isDark ? '…' : '…', … }`

**Critical**: `getDarkColors()` must be called INSIDE the component function with the theme parameter from `useTheme()`. Module-level calls capture the theme once at import time and never update when the user toggles dark mode.

When adding a new token to `getDarkColors`, also add the matching CSS variable in `styles/tokens.css` (and a Tailwind alias in `tailwind.config.js` if className pages need it) so both layers stay in sync.

## Loading States

Use the shared `Skeleton` component (`components/Skeleton.jsx`) for loading states, not bare spinners. Available: `Skeleton.PageHeader`, `Skeleton.StatCards`, `Skeleton.Table`, `Skeleton.Card`, `Skeleton.Block`, `Skeleton.Line`, `Skeleton.KanbanBoard`.

## Known Constraints

1. **No ORM** — raw SQL via `pool.query()` with parameterized queries only
2. **bcryptjs not bcrypt** — bcrypt fails to compile on Railway
3. **jsonwebtoken ^9.0.0** — don't upgrade past 9.0.x
4. **multer ^1.4.4-lts.1** — 1.4.5 doesn't exist
5. **Tailwind v3** — postcss.config uses `tailwindcss: {}`. Do NOT use `@tailwindcss/postcss` (that's v4)
6. **Date handling**: Always use `formatDate()` from `client/src/utils.js`. PostgreSQL can return null dates that cause "Invalid Date"
7. **Financials date basis**: Financials page calculates by `COALESCE(payment_date, invoice_date)` — expenses are attributed to when they were paid, not invoiced
8. **Category pickers render SECTIONS** (`bk_categories.ui_group`, added Aug 2026). The list was already ranked by real usage, but the ranking is GLOBAL while a picker is contextual: on the approvals checklist the top read Marketing, Bank Fees, Advertisements, Meals & Entertainment, Travel, Software / Subscriptions — and those five after Marketing have been used on a vendor-submitted invoice **zero** times between them, ranking that high on 1,608 bank and card rows that screen never sees. 18 of 32 categories had never been used there at all. Six sections (campaign / record / artist / people / label / other), usage ranking preserved INSIDE each.

   `ui_group` is orthogonal to `report_section` and both are needed — that one has three values and answers "where on the P&L", so Marketing, Bank Fees, Salary and Rent are all `operating`. Seeded once from `CATEGORY_GROUP_SEED` (`lib/constants.js`, mirrored in `client/src/constants.js` as the offline fallback) with a `group_set` guard, exactly like `report_section`. The seed is **UPDATE-only, never an upsert** — upserting would resurrect the six categories deliberately merged away, which is a reported-number change dressed as a UI tweak. Defaults to `other`, so a category created next month is grouped without a deploy. There is no group editor yet; moving one is a one-row UPDATE.

   **`GET /api/categories` returns `expense_groups` / `expense_order` alongside the unchanged flat `expense`.** `order` is `groups.flatMap(items)` and NOTHING ELSE, because `CategorySelect` numbers options by array index for the review decks' 1-9 hotkeys and the decks resolve a keypress by that same index (`deckOptsFor(item)[Number(e.key) - 1]`) — two separately-built orders drift, and did once, giving a menu that read "1 · Recording" while pressing 1 picked something else. Anywhere options are numbered or indexed by position, use `order`; never re-flatten.

   A caller that passes its own `options` (both review decks do) keeps a FLAT menu on purpose — it owns its hotkey order, and rendering a different one here is precisely that desync. `PickerMenu` gained non-selectable `groups`: headers are rows so they render in order but are skipped by ↑/↓, refused by Enter, and a group whose items all fail the filter is dropped rather than left as a lone header.

9. **Categories are DATA, not constants** (changed Aug 2026 — this gotcha used to say "duplicated in 10 places", and it understated it: there were five separate hardcoded copies of the expense list, including two the note never mentioned). Expense categories and income types now live in the `bk_categories` table (`kind` = `expense` | `income`), seeded idempotently on startup from `CATEGORIES` / `INCOME_CATEGORIES` in `lib/constants.js`. Read them through `useCategories()` / `useIncomeCategories()` / `useCategoriesContext()` (`context/CategoriesContext.jsx`), never by importing the constant — the constants are the seed and the offline fallback only. Use `<CategorySelect>` for any category dropdown; it handles creation inline and, critically, renders a row's own stored value even when that value isn't in the active list. **The table is the source of dropdown OPTIONS, never a constraint on stored data**: `expenses.category` and `artist_income.income_type` are free text and hold historical values that may no longer be offered. Never use the list to reject a write or rewrite a stored row. Two `CATEGORIES` identifiers are deliberately NOT this vocabulary — `LedgerMatching.jsx` (discrepancy types) and `QBImport.jsx`'s `INCOME_TYPES` (a QuickBooks-side mapping list); leave both alone.
10. **No test runner, no linter, no formatter** — don't search for one. Verify changes manually: run `dev:server` + `dev:client` and exercise the affected page in a browser. For backend-only changes, hit the endpoint from the page that uses it.

   **`vite build` succeeding is not evidence a page renders.** `client/scripts/smoke-render.mjs` (`npm run smoke`, from `client/`) renders a page with `renderToString` in node, under the app's real provider stack, and reports which ones throw.

   **A green smoke run is not evidence either, for TWO specific shapes.**

   **(1) A hook below an early return.** My Work went white on 2026-08-25 with a
   `useEffect` under `if (loading) return <Skeleton/>`. React counts hooks per
   render: the loading render stopped short of it, the render after the fetch
   reached it, and React threw *"Rendered more hooks than during the previous
   render"*. smoke could never see it — renderToString never fires effects, so the
   page only ever renders its LOADING branch, the one branch the bug is not in.
   `smoke` now greps for it (**HOOK_AFTER_RETURN**), scoped to the
   default-exported component and matching all three guard shapes (`return` at
   indent 2; `if (x) return …`; `if (x) {` with the return on the next line at
   indent 4 — the first version matched only the first and so missed the very bug
   it was written for). Swept across all 65 pages: My Work was the only one.

   **`client/scripts/mywork-dom-check.mjs`** is the tool for when the grep is not
   enough — it mounts a page under jsdom with `react-dom/client`, so effects run
   and the data branches execute, and prints what actually threw. jsdom is
   deliberately NOT a dependency; the header explains the two-step. This is what
   reproduced the white page (0 bytes rendered, then 16,558 after the fix).

   **(2) An array callback reading state declared below it.** The Ledger went
   white on 2026-08-20 with smoke passing, because state was declared BELOW a
   derivation that reads it inside an array callback:

   ```js
   const selectedRows = renderable.filter(e => selected.has(e.id))   // line 2229
   const [selected, setSelected] = useState(() => new Set())         // line 2403
   ```

   Effects never fire under `renderToString`, so the page renders in its LOADING
   state, `renderable` is `[]`, and `[].filter(cb)` never invokes `cb` — the
   dead-zone read never happens. With one row on screen it throws on every render.
   `smoke` now greps for that shape (`ARRAY_CALLBACK_TDZ`) alongside rendering, and
   fails on it. **Declare state above anything that derives from it**; the two
   pieces of this session's work both needed moving for the same reason. It exists because a `const` read nine lines above its own declaration — a temporal-dead-zone ReferenceError on every render — compiled clean, deployed, and took the create-invoice page pure white; the identifier existed, it just did not exist YET. Run it on any page you touched before pushing. It only proves the component BODY runs (effects never fire, so pages render in their loading state) — which is exactly the class of bug that blanks a page.
11. **Helmet COOP**: Must use `crossOriginOpenerPolicy: { policy: 'unsafe-none' }` — Google SSO popup flow breaks otherwise
12. **User deletion**: Must clean up FK references (activity_log, releases, entity_files, comments, tasks, notifications, permissions) before deleting from users table. See `server/routes/settings.js` DELETE handler.
13. **Expense soft-delete cascades**: Deleting a parent expense must also soft-delete children (`parent_id`). Restoring must also restore children. See `server/routes/bookkeeping.js` DELETE and restore handlers.
14. **Vendor pages are URL-routed**: Each vendor has a unique URL at `/bk/vendors/:vendorName`. The `BkVendors` component uses `useParams` + `useNavigate` — don't use local state for vendor selection.
15. **File MIME detection**: The GET file endpoint (`/entries/:id/file/:type`) detects MIME from extension only. Supports pdf, png, jpg, jpeg, gif, webp, bmp, svg. Filenames in `Content-Disposition` are sanitized.
16. **Auto-split on song commas**: Updating the song field to contain commas (e.g., "Song A, Song B") auto-splits the entry. Splits only on commas (not slashes for display text). Only triggers on entries without existing children.
17. **`EXPENSE_LIGHT_COLS` in sync with schema**: Every column on `expenses` except the four base64 blobs (`invoice_data`, `w9_data`, `proof_data`, `receipt_data`) is listed explicitly at the top of `server/routes/bookkeeping.js`. Adding a column to the `expenses` table without also adding it here silently omits the field from all list responses (`/bk/entries`, `/bk/approvals`, `/bk/vendors/:payee`) and mutation pre-checks.
18. **Mock adapter shape parity**: `client/src/mock/mockApi.js` has matchers for every API route used by the app. When changing a response shape server-side, update the matching matcher; drift has caused white-page regressions for test users (array vs `{data,total}`, missing `thisMonth.total` on Financials summary, `/team/my-work` returning `{users,tasks}` instead of `{releases,upcoming,tasks,activity}`). Matchers for sub-paths must appear BEFORE their catch-all (e.g. `/^\/releases\/duplicates/` before `/^\/releases/`).
19. **Payment Dashboard server-side scope**: `/bk/payments` returns only unpaid + last-14-days-paid by default. Don't remove the clause without replacing it — BkPayments's performance depends on the server filtering down. Escape hatch is `?scope=all`; `/bk/payments/export` is intentionally unscoped.
20. **Gray palette is CSS-var-backed**: `tailwind.config.js` overrides the `gray` color to `rgb(var(--color-gray-{n}) / <alpha-value>)`. Do NOT replace it with literal Tailwind hex values — dark mode for `text-gray-*`, `bg-gray-*`, `border-gray-*`, and their opacity modifiers flows through `:root` / `.dark` CSS vars. One retained legacy override: `.dark hover\:bg-gray-100:hover { background: #262a35 }` — keeps the hover state visibly brighter than `bg-gray-100` at rest (`#1f222c`); the single-color-per-tier palette can't express it.

## Environment Variables

**Server** (see `server/.env.example`): `DATABASE_URL`, `JWT_SECRET`, `PORT` (3001), `NODE_ENV`, `FRONTEND_URL`, `ANTHROPIC_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, Gmail OAuth vars (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER`), Cloudflare R2 vars (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`)

**Client** (see `client/.env.example`): `VITE_API_URL` (defaults handled in `api.js`)

## Stale Docs

`SETUP.md` and `PROMPT.md` (from the original 8-page scaffold) were deleted in July 2026 — this CLAUDE.md is the source of truth. They live in git history if ever needed.
