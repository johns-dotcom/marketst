# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The **Market Street** label dashboard — a fork of the Boom Records dashboard
taken on 2026-09-15 from boom-dashboard's working tree. Same architecture, same
feature set, visibly rebranded, with no business data carried over.

## Repo Layout

The git root is `marketst-dashboard/` but the actual application lives in
`boom-dashboard/`. All development, builds, and deploys operate from that
subfolder. **The subfolder keeps its Boom name on purpose** so every path
matches the Boom repo and fixes port between the two by path. Renaming it means
changing Railway's service root directory in the same sitting and rewriting
every path in the guide — do it deliberately or not at all.

Authoritative project guide: **`boom-dashboard/CLAUDE.md`** — read it before making changes. It covers the architecture, the API routes, the bookkeeping subsystem, AI-powered features, dark mode conventions, schema-migration rules, and the full list of gotchas. Its history, examples, dollar figures and people refer to **Boom**; the engineering rules apply here unchanged.

## Fork rules

- **Internal identifiers are NOT renamed**: `boom_rep`, `BOOM_REPS`, `BoomRepsContext`, the `boom-*` Tailwind accent classes, `boom_invoices` / `boom_ndas` / `boom_label_waivers` tables, `BOOM_INFO`, `BOOM_DEFAULTS`. Only user-visible strings, emails, the domain, package names and colours changed. Keep it that way so patches port.
- **Placeholders are marked `TODO(marketst)`** — grep for it. They print on real documents (invoice remittance block, NDA owner address), so fill them before the first document goes out.
- **The accent palette is a slate placeholder** — `boom` in `client/tailwind.config.js`, `--color-brand*` in `client/src/styles/tokens.css`, the favicon, and the hex fills in server-side Excel/email templates (`#334155`). Swap values, not class names.
- **No Market Street domain yet** — `marketst-production.up.railway.app` stands in wherever `boom-ap.com` was (`FRONTEND_URL` fallbacks, `client/.env.production`, og tags, the user manual). Replace when a domain exists.
- **Seed = one account.** `server/seed.js` and `syncUsers` in `server/index.js` create `john@deanst.co` (Superadmin) from `PW_JOHN`. `server/data.json` and `server/data/pending-contracts.js` are empty shells; the payroll and category seeds carry no Boom rows.
- **The sidebar is Market Street's own (2026-09-18), Boom's is not.** 43 rows became
  16 via `tabbed` families in `client/src/navConfig.jsx` — Releases, Contracts,
  Documents, Invoices, Bank, Vendors, Recoupments, Artist Spend, Settings. NO PATH
  MOVED. Pages leave the sidebar with `hidden: true`, never by deletion: a hidden
  page stays in `NAV_PAGES` (grantable, ⌘K-searchable, a known page for the
  permission walk). Hidden as of 2026-09-18: Financials, Recording Budgets, Salary,
  Bulk Deals, Invoices View, Bookkeeper Reconcile, Add Reimbursement, Analytics.
  **DELETED outright** (John: "not needed … remove the code"): Bulk upload,
  Bulk re-upload, QuickBooks import, Master sheet import, Legal — their pages,
  routes, `server/routes/import.js`, `server/lib/masterSheet.js`,
  `scripts/import-master-sheet.js` and `GET /bk/admin/corrupt-invoices` are gone.
  `/bk/parse`, `/bk/parse-proof`, `/bk/entries/batch` stay (Add Invoice and
  Add Reimbursement use them). Settings' tab bar is Settings · Members ·
  Activity · Admin docs · Sandbox. The inner guide still describes these
  features as Boom history. `client/scripts/nav-fixture.mjs` encodes this layout; the
  page-access fixture must stay byte-identical across any nav change. Boom
  reverted a similar regroup in Aug 2026 — do not port this back without asking.
  Plan: https://claude.ai/code/artifact/3e97eb42-7e5d-41c3-b7c4-b20b8f424e28
- **Role presets are ADDITIVE and live in `client/src/lib/navPresets.js`** (Phase 2,
  2026-09-18): anr, marketing, bookkeeper, ops. A department seeds the default
  tick on the user form; an admin can tick a second preset for somebody who does
  two jobs and the pages union. The Permissions editor's "Add preset…" ADDS pages
  (Clear to start over). Every preset except ops excludes hidden pages; every
  preset carries Flags. `client/scripts/navpresets-fixture.mjs` (33 assertions)
  checks the lists against NAV_PAGES and the real canViewPath. Boom's five
  templates (marketing/bookkeeping/anr/finance_exec/legal, overwrite-on-apply)
  are gone here. DEPARTMENTS is now A&R, Marketing, Finance, Operations.
- **Home is the loop, not a label overview** (Phase 3, 2026-09-18). `GET
  /api/dashboard/loop` (routes/dashboard.js) returns four sections — approvals,
  payments, bank, releases — each a count + USD + one destination, and each NULL
  for a caller who could not open that destination (`pagesReachable` in
  middleware/pagePermission.js, the middleware's rules as a set). The client's
  `canView` is the second gate. Empty sections render a sentence saying what
  fills them, never a bare 0; a failed loop read renders no tiles. The label
  stat cards (Total Artists/Releases/Team) and the dead Flask
  `/api/dashboard-summary` fetch are gone. Release-shaped panels (Latest
  Releases, charts, Upcoming) render only for someone who can open Releases.
  Harnesses: `cd client && npm run home-dom` (36, four scenarios: admin · anr ·
  empty · down) and `server/scripts/home-loop-fixture.cjs` (20, delta-based,
  needs a server on :3011). Both verified to fail when a predicate is dropped.
  `mywork-dom.vite.config.mjs` now takes `AUTH_STUB` so a harness can bring a
  configurable canView.
- **The artist budget sheet is the SIMPLE one** (2026-09-18, John: "basic and
  editable … total artist budgets (advance, total marketing) and release budgets
  inside that"). `/artist-budgets/:key` → `ArtistBudgetSimple.jsx`: Advance and
  Total marketing typed (stored in `artist_budget_sections` under keys `advance`
  / `marketing`), releases under marketing (`artist_budget_releases`,
  independent of the total, gap shown), a read-only Other spend line, columns
  Budget · Spent · Left (Spent = paid; unpaid is a note). `GET
  /artist-budgets/:key/simple` builds it; category sets are imported from
  reports.js (ADVANCE_CATEGORIES) and artist-campaigns.js (CAMPAIGN_CATEGORIES)
  so the sheet cannot disagree with the P&L or Campaigns. The 32-category grid
  moved to `/artist-budgets/:key/detail` ("Full breakdown"). The index's
  `budget` is the two simple totals when either is typed, else the category sum
  — never both. Harnesses: `npm run budgetsimple-dom` (29),
  `server/scripts/artist-budget-simple-fixture.cjs` (21). Index has a "New
  budget" button (roster picker → the sheet by key, `?name=` carries spelling).
- **Flow plan (2026-09-18):** https://claude.ai/code/artifact/2390f265-defe-4019-b14d-5e3965a2f44b
  — measured link graph, then four phases: A empty states · B hand-off prompts ·
  C artist hub + breadcrumbs (+ generated PDFs saved to the artist) · D team
  calendar (releases + tasks + payment due dates + renewals). **Phase A shipped:**
  `components/EmptyState.jsx` is THE empty state (title, one-sentence body, one
  action, a source link); wired into Roster, Releases, Catalog, Deals, Pending,
  Renewals, Approvals, Payments, Ledger (both halves), Creators, Rules, Vendors,
  Recoupments, Campaigns. The Roster gained **Add artist** (name + genre →
  `POST /artists`, opens the profile) — nothing in the app could create an
  artist by hand before; Boom's roster came from the deleted master-sheet import.
  **Phase B shipped:** `components/NextStepPrompt.jsx` + `useNextStep()` is the
  hand-off (a dismissible card with ONE prefilled link — never a redirect).
  Deal → Signed prompts `/contracts?new=1&artist=&deal=`; Contracts reads it,
  opens the form with the artist picked, and offers "Add X to the roster" if the
  deal named someone not on it; saved contract prompts `/releases?add=1&artist=`;
  Releases reads it and prefills Add release (`initialArtistName`); created
  release prompts the budget sheet by key; first approval per visit prompts
  Payments; first mark-paid per visit prompts Statements (Payments also carries a
  standing "Upload statements on Bank" link); reconciling a month prompts
  Reports. `npm run handoff-dom` (17) covers the URL contracts end to end.
- **Bank-statement heuristics were tuned on Boom's Bank of America statements.** The own-name lists (`statements.js` stop-words, `funding-pairs.js` account-trailer strip) now say Market Street, but the layout parsers have not seen a Market Street statement yet. Expect the AI fallback to do the work until they do.

## Commands (run from `boom-dashboard/`)

```bash
npm install            # installs root + server + client (via postinstall)
npm run dev:server     # Express on :3001 (nodemon)
npm run dev:client     # Vite on :5173
npm run build          # client → client/dist/
npm start              # serves Express + React build
npm run seed           # creates tables + seeds the first account
```

No lint, no formatter, no test runner — verify changes by running `dev:server` + `dev:client` and exercising the affected page in a browser. `cd client && npm run smoke` renders the pages you changed in node first; a green `vite build` does not prove a page renders.

## Infrastructure

- **Dev DB:** Neon project `marketst-dashboard-dev` (`misty-fog-44061928`, us-west-2, pg17), database `marketst_dashboard`. Connection string in `server/.env` (gitignored).
- **GitHub:** `github.com/johns-dotcom/marketst`, pushed over the `github.com-marketst` SSH alias (deploy key `~/.ssh/marketst_deploy`).
- **Not provisioned:** Railway service, Cloudflare R2 bucket, Gmail sender, Anthropic key, Google OAuth client. The env var names the server reads are listed as comments at the bottom of `server/.env`.

## Root-Level Files

- `boom-dashboard/` — the monorepo (client + server)
- `README.md` — what the app is and what it is for, plus the fork status
- `tools/` — one-off operator scripts, run by hand, never by the app
  - `get-refresh-token.js` / `.py` — mint a Gmail API refresh token for the server's `GMAIL_REFRESH_TOKEN`. They need a Google OAuth `client_secret_*.json` beside them (sensitive — gitignored, not copied from Boom)

## Nothing is installed at the root

There is no root `package.json`, and `node_modules/` is ignored here. If you find dependencies at this level, they are a mistake from an `npm install` run in the wrong directory.
