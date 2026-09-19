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
  **Home, second pass (2026-09-18, John: "improve the home page"):** order is
  Loop → Start (quick actions) → Next 7 days + Recent activity → Latest
  releases → charts. **When every present loop section is zero and no task is
  open, the six tiles collapse to ONE line** (`data-loop-clear`, naming each
  clear source); a failed loop read (null) never collapses. **Quick actions**
  (Add invoice `/bk/add`, Add release `/releases?add=1`, New deal `/deals?new=1`
  — DealPipeline reads `?new=1`) each render only under `canView`. **Next 7
  days** reads the calendar feed (`GET /calendar`, already typed and
  permission-gated) and drops events whose page this user cannot open — the
  same double gate the tiles have. **Recent activity** = `/dashboard/activity`
  minus the caller's own rows, last 20, `humanizeAction` from
  `lib/activityText.js` (extracted from ActivityHistory so both say the same
  thing); the server now returns `[]` unless `/activity` is reachable, and the
  panel renders only under `canView('/activity')`; the old notification alerts
  sit as its top rows. **Charts render only when there is data to chart.** The
  Notifications and Upcoming Releases panels are gone (folded into the two
  above). Harnesses: `cd client && npm run home-dom` (49, four scenarios: admin
  · anr · empty · down — `anr` proves a payment due in the calendar stub never
  reaches the page) and `server/scripts/home-loop-fixture.cjs` (needs a server
  on :3011). `mywork-dom.vite.config.mjs` takes `AUTH_STUB` so a harness can
  bring a configurable canView.
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
  **Phase C shipped (2026-09-18):** the artist profile is the hub. Three more
  tabs — **Budget** (the simple sheet's lines, read-only, "Open the sheet" by
  KEY carrying `?name=`), **Recoupments** (the four bank states explained, link
  by NAME), **Campaigns** (this artist's card off `/artist-campaigns`, link by
  NAME) — each gated by the same `canView` as the page behind it, each fetched
  only when opened. `GET /artists/resolve?name=` folds a spelling to the roster
  row (`artistBucketKey`, placeholders 400, unknown 404) and
  `hooks/useArtistLink.js` caches it per name, so the name-keyed pages —
  budget sheet (simple + `/detail`), Recoupments artist page, Campaigns artist
  and song pages — carry a **Breadcrumb** whose artist crumb links to the
  profile when the artist is on the roster and reads as text when not. Budget
  payloads carry `artist_id` for the same reason. A generated NDA is saved to
  the recipient's artist Documents when the recipient resolves to a roster
  artist (`POST /artists/:id/files` now takes a `label`); waivers and
  clearances already attached server-side. Harness `npm run hub-dom` (37, three
  scenarios incl. the gated one); `budgetsimple-dom` grew the breadcrumb checks;
  `artist-budget-name-fixture.cjs` (14) covers resolve + `artist_id`. Trap hit
  twice this phase: a hook placed below the profile's `if (loading) return`
  (smoke's HOOK_AFTER_RETURN caught it), and a stub answering `[]` for
  `/artists/*` making an empty list truthy — the hook now accepts only an
  object with an id.
  **Phase D shipped (2026-09-18):** the calendar is the TEAM calendar. `GET
  /calendar` (routes/calendar.js) is one typed feed — release dates, DSP
  dates, contract signings, contract expiries as **renewals**, task due dates,
  and **payment due dates** (approved unpaid family roots on
  `scheduled_payment_date`, the Payments queue's own predicate; on hold and
  rush carried in `meta`), plus manual events — every event carrying `to`,
  the page it came from (`/releases`, `/contracts`, `/renewals`, `/my-work`
  or `/team/:id`, `/bk/payments`). Gated by `pagesReachable`, never by role
  name: a source the caller cannot open is not queried, and `sources` in the
  payload says which feeds were withheld (`tasks` is `'team'` when `/team` is
  reachable — everyone's open tasks — else `'own'`). On the page the legend IS
  the filter: one toggle per source with its count over everything loaded, a
  withheld source rendered locked as "not in your pages", a "Show all" reset,
  the header counting what the legend hides; the old chip row is gone. Every
  event in the day panel links to its page; an empty calendar is an
  `EmptyState` naming the four things that fill it. Harnesses: `npm run
  calendar-dom` (31, scenarios full · gated · empty) and
  `server/scripts/calendar-fixture.cjs` (18, seeds both a Superadmin's and a
  `/releases`-only User's view). `AdminRoute` on `/renewals` is a `canView`
  gate, so a User granted the page reaches it from a renewal event.
- **Signing an artist (2026-09-18, built):**
  https://claude.ai/code/artifact/c4388ce4-710c-48d4-8128-81f37bfbf826 is the
  design. **Terms and contact live on the DEAL** (advance, royalty_split,
  term_months, territory, num_releases, option_periods, artist_email,
  artist_phone, manager_name, manager_email, socials JSONB, spotify_url —
  edited in the deal's detail panel, `PUT /deals/:id` writes what is PRESENT so
  `''` clears). **`signDeal()` in routes/deals.js is what "Signed" does**, in
  one transaction, idempotent, run from the PUT stage transition (only when
  `stage` was in the body), from POST-created-Signed, and from
  `POST /deals/:id/sign`: roster row created or matched by `artistBucketKey`
  (fills only empty contact fields, stamps `signed_at`/`signed_deal_id`); the
  advance as an approved Unpaid Net-30 `Advance` expense payable to the artist
  (`vendor_email` = artist email, `recoupable` + `recoup_reviewed` TRUE,
  `entry_source 'signing'`; `recoup_reviewed_by` is an INTEGER id while
  `approved_by`/`created_by` are TEXT names — pass both); a `calendar_events`
  row of type `signed` (description `deal:<id>` is the idempotency tag, `link`
  → the profile; the feed marks it non-deletable). The deal remembers all three
  (`signed_artist_id`, `signed_at`, `advance_expense_id`). Response carries
  `signing: {artist, advance_expense_id, created}` and the pipeline's prompt
  SAYS what happened before handing to `/contracts?new=1&artist=&deal=`, which
  now prefills the contract from `GET /deals/:id` (type mapped to the form's
  vocabulary, expiry = today + term_months, blank fields only).
  **The checklist is computed, never stored** — `lib/onboarding.js`
  `onboardingFor(artistId)`: contract (Active + a file), payment (a
  `vendor_payment_details` row for the artist's email AND `HAS_W9_SQL` on the
  payee), advance (its expense Paid, or no advance → done), budget (both simple
  lines typed), release (one with a date). `onboarded_at` is stamped on first
  completion, never cleared. Surfaces: `components/OnboardingPanel.jsx` at the
  top of the profile (renders only for `signed_at`; collapses to "Onboarded on
  …"), `GET /artists/onboarding` → roster chip "Onboarding 2 of 5" + an
  Onboarding filter (`?onboarding=1`), Home loop `onboarding` section gated on
  `/artists`. **Payment details:** "Copy the form link" / mailto (the public
  vendor form — NOT prefilled; that form is sandbox-managed) or **Type in**
  (`POST /artists/:id/payment-details`, Admin/Superadmin/Approver, same
  `validatePaymentFields` + encrypted upsert the vendor form uses, one
  `bk_audit_log` row, never echoes a number; 503 without `PAYMENT_DETAILS_KEY`).
  `PUT /artists/:id/contact` edits email/phone/manager/socials/spotify.
  Migrations are the `for (const col of …)` loops after `artists.archived_by`
  in index.js — they run AFTER the server starts listening, so a fixture that
  fires on `/health` can beat them on a fresh database. Harnesses:
  `server/scripts/signing-fixture.cjs` (41: terms, sign, idempotent, no-advance,
  matched roster row, checklist ticking from data), `npm run onboarding-dom`
  (32: panel, type-in POST shape, no-email path, roster chip + filter),
  `handoff-dom` scenario `terms` (contract prefill), `home-dom` (onboarding
  tile). Left open, on purpose: payee spelling on the advance (roster name
  today), term as months not dates, planned marketing not on the deal.
- **The public vendor form wears Market Street's own look (2026-09-19).**
  `client/src/styles/marketst-form.css` is a THEME LAYER scoped to `.ms-form`:
  halftone paper, torn-paper cards (`ms-card`, clip-path) and notes
  (`ms-note`), a green MARKET.ST street sign for the header (`ms-sign`),
  striped awnings for the three steps (`ms-steps`, `--a` per step: brick ·
  royal · forest, `data-step` on the root drives `--ms-step`), and every
  primary button as a "] NEXT [ENTER]" block (`ms-enter`, the bracket and the
  `kbd` are `aria-hidden`, so the harness's text regexes still match). IBM Plex
  Mono for headings/labels/buttons, the sans stays for body copy. Second pass
  the same day (John: "a bit more professional"): straight edges + soft
  shadows, fainter grain, flat colour bars for steps, the note as a plain
  callout, bracket glyph hidden — CSS only, no promote needed. Built in the
  LAB and promoted with `sync-vendor-lab.mjs --promote`; the hooks live outside
  the four sync deltas so both files carry them. `npm run vendorform-dom`
  (both pages, all scenarios) is the regression check; the look was verified
  with a headless-Chrome screenshot of the production build on :3011
  (`NODE_ENV=production PORT=3011 node index.js`, then Chrome
  `--headless=new --screenshot`). Reference: the market.st site's paper-cutout
  street. jsdom for the harnesses lives in `/tmp/domtest` and macOS prunes
  files there after three days — `cd /tmp/domtest && npm i jsdom` when a
  harness says "did not mount".
- **Test users are gone (2026-09-19, John: "this feature is not needed").**
  Deleted: `client/src/mock/` (the mock axios adapter + fake data — so the inner
  guide's "mock adapter shape parity" rule no longer applies here),
  `server/middleware/testUserGuard.js`, the `/settings/test-users` routes, the
  Settings "Test Users" tab, the Demo Mode banner in Layout, the Messages demo
  panel, and every `is_test` read in auth/chat/realtime/activityBot/index.js.
  The `users.is_test` column is left in place, unread — dropping a column is
  not reversible and nothing writes it any more. `GET /settings/users` lists
  every user now.
- **Settings plan (2026-09-19, designed, NOT built):**
  https://claude.ai/code/artifact/6b91930c-f930-40c7-bbe2-696c2ac4599c — two
  halves (My settings: Profile · Sign-in · Notifications · Theme · My Nav;
  Label settings: People · Label · Integrations · Activity · Sandbox · Archive);
  `/team` becomes the one People page with an Access panel per person
  (Users tab + Permissions matrix + templates routes retire); a `label_settings`
  record replaces `BOOM_INFO` / `BOOM_DEFAULTS` / the TODO(marketst)
  placeholders (EIN + bank numbers encrypted, masked reads); invite links
  (`user_invites`, public set-password page); read-only Integrations status;
  family shrinks to Settings · Admin docs. NO PATH CHANGES. Five build stages in
  the plan.
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
