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
- **The label's own details live in Settings › Label**, not in code (since 2026-09-19). Fill them there before the first invoice or NDA goes out; the invoice page counts the blanks.
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
  preset carries Flags. **Executive** (2026-09-19, John: "for ceo, coo, etc.") is
  the fifth department/preset — roster, releases, deals, contracts, Reports,
  recoupments, budgets, campaigns, People; no queues — and a new Executive
  defaults to hierarchy_level 1 (`DEPARTMENT_LEVEL`). DEPARTMENTS is now
  Executive, A&R, Marketing, Finance, Operations. My Nav lists only pages the
  sidebar DRAWS for the person (hidden pages are reached from Settings or other
  pages) and names a family child as `Releases › Pipeline`.
  `client/scripts/navpresets-fixture.mjs` (34 assertions)
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
- **Settings, rebuilt (2026-09-19):**
  https://claude.ai/code/artifact/6b91930c-f930-40c7-bbe2-696c2ac4599c is the
  design; all five stages shipped. **Two halves** in `pages/Settings.jsx`: My
  settings (Profile · Sign-in · Notifications · Theme · My Nav) for everyone,
  Label settings (People · Label · Integrations · Activity · Sandbox · Archive)
  for Admin/Superadmin; People/Activity/Sandbox are LINKS to `/team`,
  `/activity`, `/admin/vendor-lab` (paths unchanged, grants unchanged; those
  three are `hidden: true` in navConfig so the sidebar family is Settings ·
  Admin docs). `?tab=` deep-links. Routes: `GET/PUT /settings/me`,
  `GET /settings/me/sessions` (user_login_logs), `GET/PUT
  /settings/me/notifications` (`users.notification_prefs` JSONB — stored, not
  sent until Gmail; the tab says so), `POST /auth/change-password` +
  `/auth/logout-all` finally have screens. **People** = `/team`
  (`pages/Team.jsx`, admins land on the Directory view: `GET /settings/people`
  → role, department, rows→presets, last sign-in, open tasks, invite pending)
  + `/team/:id` Access tab (`components/PeopleAdmin.jsx`: `PersonModal`,
  `DeleteConfirm`, `BoomRepsPanel` extracted from Settings, new `AccessEditor`
  — additive presets, page checkboxes, reachable pages via the real
  `canViewPath`; view-as, `POST /settings/users/:id/logout-all`, remove). The
  Users tab, the Permissions matrix and the permission-templates routes are
  GONE. **Label** = `label_settings` (one row; `routes/label.js`: `GET /label`
  masked for everyone, `PUT /label` Admin — EIN and bank account number
  Superadmin-only, encrypted with `PAYMENT_DETAILS_KEY`, last four shown; `GET
  /label/remittance` bookkeeping roles, decrypted, one `bk_audit_log` row per
  read). Consumers: CreateInvoice `BOOM_INFO` (filled by `applyLabel` from the
  remittance read, gaps banner), NDA `BOOM_DEFAULTS` (`applyLabelDefaults`),
  CreateLabelWaiver, Layout billing-address copy, the approval-summary
  greeting — via `hooks/useLabel.js`. **The TODO(marketst) placeholders are
  gone**; a blank Label field prints blank. **Invites** = `user_invites`
  (`lib/invites.js`: token in the URL, SHA-256 in the table, 7 days, resend
  voids unused); `POST /settings/users` creates with `password_hash NULL` and
  returns `invite.path`; `PersonModal` shows the link with Copy; People rows
  flagged pending offer "copy a new link" (`POST /settings/users/:id/invite`);
  public `GET/POST /auth/invite/:token` + `pages/SetPassword.jsx` at
  `/invite/:token` (before the login gate in App.jsx); login refuses a
  password-less account with a sentence naming the invite. **Integrations** =
  `GET /settings/integrations` (env presence only: gmail, google_signin,
  spotify, storage, ai, encryption; never a key). Harnesses: `npm run
  settings-dom` (admin · user · people), `server/scripts/settings-fixture.cjs`
  (17), `label-fixture.cjs` (14), `invite-fixture.cjs` (19); nav-fixture's
  hidden list and `/team` label updated. Left open: avatars (initials only),
  editable departments, whether Admins may see the label's bank block (today:
  see masked, only Superadmin writes).
- **Brand (2026-09-19, John: "a brand page where users can upload and download
  company photos and logos").** `/brand` is a child of the Documents family
  (`pages/Brand.jsx`, `routes/brand.js`), in COMMON so every preset grants it.
  Files are `entity_files` rows (`entity_type 'brand'`, `entity_id 1`, `label`
  = category logo · photo · other), bytes in R2 when configured else the
  legacy `file_data` column (dev has no bucket), downloaded through the same
  `/uploads/:filename` route as every attachment — which serves SVG and
  unknown types as ATTACHMENTS, so a vector logo can hold script and never
  run on our origin; only raster images preview inline. Its own multer filter
  allows png/jpg/gif/webp/svg/pdf/ai/eps/zip/tiff (secureFileFilter blocks SVG
  on purpose for vendor files). Anyone signed in uploads and downloads;
  removing is the uploader or an admin. NAV_PAGES is 49 now.
  `server/scripts/brand-fixture.cjs` (12) covers upload, the HTML refusal, the
  byte-identical download, the SVG-as-attachment rule and the delete gate.
- **Connected mailboxes (2026-09-19, built; plan
  https://claude.ai/code/artifact/c64c206d-780f-4a15-9ea7-e7f63e0f2ce5).**
  `mailboxes` (address, kind shared|personal, owner, `refresh_token_enc`
  under PAYMENT_DETAILS_KEY, `source` oauth|env, status active|
  needs_reconnect), `mailbox_purposes` (purpose → mailbox: payments · vendors
  · team · artists · clients), `mail_log` (every attempt), `mail_jobs`
  (scheduler periods). **`lib/mail.js` `sendMail({ purpose|kind, to, cc,
  subject, html, attachments, from, replyTo, entity })` is the ONE send path**
  — the Gmail HTTPS call lives in `lib/gmail-transport.js` (extracted from
  services/email.js; the copies in routes/team.js and routes/requests.js are
  gone). Every sender in services/email.js calls `sendMail({ kind })`;
  `PURPOSE_OF_KIND` maps kinds to purposes. `runWithMailContext({ actor,
  fromMailboxId }, fn)` (AsyncLocalStorage) is how `POST /email/send` passes
  WHO is sending: a human sending from a SHARED box gets Reply-To = their
  address; `from_mailbox_id` lets them send as their own (personal) box.
  Unassigned purpose → `MailNotConnected` (code MAIL_NOT_CONNECTED, 409 from
  the send route) whose message is the sentence screens show; `invalid_grant`
  → status needs_reconnect, never retried. `MAIL_DRY_RUN=1` logs without
  calling Gmail (fixtures). **The env sender (GMAIL_USER + token) is imported
  on boot as the first shared mailbox owning every purpose** (no-op once any
  row exists) — so mail kept working through the change; the env vars can go
  once a real mailbox is connected. `routes/mail.js`: status · mailboxes ·
  connect (returns the Google consent URL, `state` = 10-minute JWT bound to
  the user and kind) · PUBLIC `oauth/callback` (exchanges the code with
  GMAIL_CLIENT_ID/SECRET, reads the address from userinfo, upserts, first
  shared box claims all purposes, redirects to
  `/settings?tab=integrations|mailbox&mail=connected|denied|badstate|norefresh`)
  · purposes PUT · test send · disconnect (purposes go unassigned, reported) ·
  log. **Ops step:** `https://marketst-production.up.railway.app/api/mail/oauth/callback`
  (and the localhost one) must be an authorised redirect URI on the OAuth
  client. UI: `components/MailCard.jsx` (Integrations card: boxes, purposes
  matrix, recent sends, reconnect) and `MyMailbox` (My settings › My mailbox);
  `EmailPreviewModal` gained a From selector. `lib/notifier.js` runs hourly:
  approvals_waiting (09:00 LA daily), payments_due (Mon 09:00), renewals_coming
  (daily, contracts hitting exactly 90 days out), weekly_digest (Fri 16:00) —
  each claimed once per period in `mail_jobs`; `notifyAssigned` emails a task
  immediately when the assignee's pref is on (then no preview is offered).
  **Every email renders inside `server/lib/email-layout.js`** (2026-09-20,
  John: "make the emails more unique to market street"): `layout({ title,
  eyebrow, body, cta, accent, preheader, footerNote })` is the Market Street
  frame — paper ground, the green MARKET ST street sign, IBM Plex Mono
  headings, a flat accent bar (forest · brick · royal · mustard by email
  kind), a footer with the label's name/address/contact from Settings › Label
  (cached in-process, refreshed every 5 min — `layout` is SYNC because every
  builder is sync and the preview modal calls them inline). Helpers `rows`,
  `p`, `button`, `esc`. Users: every builder in services/email.js, notifier's
  `wrap`, routes/team.js (now calls `buildTaskAssignmentHtml`), the approval
  summary in bookkeeping.js (its tables are the `body`), the invite mail in
  settings.js, the test send in mail.js. The same palette as
  client/src/styles/marketst-form.css. A new template goes through `layout`;
  do not hand-roll a header. **My mailbox** says so when the person's own
  address is already the label's SHARED mailbox (`data-shared-is-mine`) —
  before, it read "No mailbox connected" while Integrations showed it active.
  `mail-fixture.cjs` calls `sendMail` in-process, so run it with
  `MAIL_DRY_RUN=1` on BOTH the server and the fixture command.
  Invites: `POST /settings/users/:id/invite?send=1` emails the link; PersonModal
  "Email it", People "email it". Integrations' Mail row now reads the mailboxes
  table. Fixtures: `mail-fixture.cjs` (21, needs `MAIL_DRY_RUN=1` on the
  server), `gmail-transport-fixture.cjs` now tests lib/gmail-transport directly.
- **Click-through tours (2026-09-19, John: "updated every time something in
  the dashboard is updated").** `client/src/tours/index.js` is THE list: a
  welcome tour (auto-starts on first sign-in) and one short tour per page
  (auto-starts the first time that page is opened, after welcome; replay any
  from the `?` help modal's Tours section). `components/Tour.jsx` is the
  spotlight engine, mounted once in Layout (`TourProvider` wraps
  `LayoutInner`); steps point at elements by CSS selector — `data-tour="…"` on
  the element (PageHeader takes a `tour` prop) or a data-attribute the page
  already has — and a step whose target is not on screen is skipped, never
  shown empty. Tours are gated by `canView(tour.path)`, the sidebar's gate.
  Completion is per user, per VERSION: `users.tours_done` JSONB via `PUT/DELETE
  /settings/me/tours`; a person who finished an older version sees the tour
  offered again as "updated". **THE RULE: a change to a page changes its tour
  in the same commit and bumps that tour's `version` (a date).**
  **Every visible page has a tour, and the welcome walk covers the whole nav
  (2026-09-20, John: "releases only shows the pipeline, not the catalog. make
  sure each walkthrough covers every feature").** 48 page tours, 3–5 steps
  each (header + every visible control; nothing opened or clicked), for every
  page in NAV_GROUPS including the 8 hidden ones (own tour, skipped by the
  walk) and `/activity`. The WELCOME is BUILT FROM THE NAV in sidebar order:
  for each group → item; a tabbed family gets a step on its tab strip
  (`TabbedShell` renders `data-tour="family-tabs" data-family={key}`) then
  EVERY step of each visible tab's tour (stamped `path`, `page`, `family`,
  `familyLabel`); a plain page gets its whole tour too — John, same day: "the
  full dashboard walkthrough still skips to the next page before finishing a
  page's walkthrough", so the one-step-per-page form lasted an hour. ~150
  steps for a Superadmin; the counter reads `Family › Page 2 of 4`. Finishing
  welcome records ONLY welcome (the page the walk ends on is held back for the
  session). **A step whose anchor never renders is SHOWN, not skipped**: after
  the 4s wait ON the page the card renders centered with an amber "appears
  once there is something to show here" line (`data-tour-anchor-missing`) and
  waits for Next — the silent auto-advance was what read as "skipping"; only a
  step whose PAGE never loads (a guard redirected) still drops the page. The
  card offers **Skip this page**, **Skip <family>** (jumps past the family;
  shown only when it differs from Skip this page) and **Skip tour**. Admin-
  only pages carry `roles` so a User's walk drops them. Anchors: PageHeader
  `tour="x-header"` on every page that has one; `data-tour` on panels; the
  bank pages share `data-tour="bank-scope"` from `BankShell`; component-root
  anchors (FlagsNav, Overview, NDAPreview, FilterBar, MonthlyRollup…) sit on
  the component's root DOM node, never on the JSX call. `tours-fixture` now
  asserts: every visible nav page has a tour; the walk visits each once;
  every family has a strip step; hidden pages have tours and are NOT walked.
  `anchors-dom` mounts ALL 48 pages against the empty stub (184 checks; shell
  anchors are skipped there). The `tour-api-stub` marks welcome done at the
  CURRENT version (bumping the version broke the 'done' scenario once).
  **Earlier form (superseded):**
  **The welcome tour walks the pages AND runs each page's whole tour there**
  (bug fixed 2026-09-19, John: "doesnt go through a full page before moving
  on"). `WELCOME` is BUILT from `PAGE_TOURS` — `WALK` lists the pages in
  order and every step of that page's tour is spliced in with `path` and
  `page` — so the two can never disagree; do not hand-write welcome steps.
  The engine navigates, waits up to `window.__TOUR_WAIT_MS__` (4s) for the
  anchor, and drops steps on pages the person cannot open (`step.needs` gates
  a step on a second page, e.g. Home's activity card on `/activity`).
  **Anchors that exist only with data carry a fallback**: a target is a
  comma-separated selector list and the first that renders wins
  (`[data-tour="releases-list"], [data-tour="releases-header"]`) — an empty
  label must not make the walk skip pages after the 4s timeout. Finishing
  welcome PUTs a batch (`{ tours: [...] }`, `WELCOME_COVERS`) that also marks
  every page tour it ran as done, so no page re-offers its tour right after.
  A page the person SKIPS with Skip this page is left out of that batch (it
  keeps its first-open tour for a later session; `startedOnPath` stops it
  pouncing the moment the walk ends). `tour.roles` / `step.roles` gate on the
  role — People's anchors are admin views, so the People tour is
  Admin/Superadmin only and a User's walk drops those steps (the harness's
  `user` scenario). Bug-check pass the same day: the auto-start timer marks
  "started" when it FIRES, not when scheduled (canView is a new function on
  every auth render, so the effect re-runs and cleared the timer while the
  one-shot guard kept the welcome from ever starting); keys typed in a field
  or Enter on a focused button (which also clicks) are not shortcuts, and
  Enter/→ do nothing while a page is loading; a step that times out OFF its
  page (a route guard redirected) drops the whole page, not one 4s wait per
  step. `PUT /me/tours` caps a batch at 50.
  **Phones (2026-09-19, John: "make sure the mobile version is updated"):**
  below 640px the card is a BOTTOM SHEET (`data-tour-sheet="1"`, anchors
  scrolled to `block: 'start'` so the sheet does not cover them); below 1024px
  the sidebar is a drawer, so the sidebar step carries `prepare: 'sidebar'` —
  the engine fires a `tour:prepare` window event (`{prepare, active}`) and
  Layout opens the drawer while the step shows and closes it after; the
  measurement waits 260ms for the slide. A target's selector list is walked
  in PREFERENCE order and the first VISIBLE match wins (`findTarget`), so an
  element hidden by a responsive class never stalls a step — the outro
  targets `[data-tour="walkthrough"], [data-tour="help"]` because the `?`
  button is `hidden sm:`. The Walkthrough button renders on every width: on a
  phone it is a footprints icon whose list opens as a sheet (first row "This
  page"). `useMedia(query)`, `SMALL`, `DRAWER` are exported from Tour.jsx.
  The harness's `mobile` scenario stubs matchMedia and a zero-size help
  button. Not done: swipe gestures; the auto-start is the same on any width.
  `target: null` is a centered card. The card offers **Skip this page**
  (multipage only) and **Skip tour**; Esc skips the tour. The fixture asserts
  the welcome tour visits every main page, runs every step of every page tour
  it visits, that each page step's anchor renders without data or carries a
  fallback that does, and that it starts and ends on Home.
  `npm run tours-fixture` (`client/scripts/tours-fixture.mjs`) fails when a
  tour names a page not in the nav or a selector no page renders — run it with
  nav-fixture before pushing. **`npm run anchors-dom`** (2026-09-20, second
  bug-test) renders every page tour's REAL page component against an EMPTY
  label (`scripts/anchors-api-stub.js`, every list `[]`) and asserts each
  step's selector list finds an element — the check that actually catches an
  anchor that only renders with data (jsdom has no layout, so existence not
  visibility; Layout-owned anchors are skipped there and covered by tour-dom;
  `/settings` is wrapped in `SettingsShell` as Layout does). Run it when a
  tour or a page's anchors change. It showed `releases-list` and `deal-board`
  DO render empty — the fallbacks on those steps are belt-and-braces. `npm run tour-dom` drives the engine (fresh ·
  done). Adding a page: add its tour, or the page has no first-open help. The
  header has a **Walkthrough** button beside the manual (`WalkthroughButton`
  in Layout): one click replays this page's tour, the chevron lists them all;
  picking another page's tour navigates there first. A tour that finds none
  of its anchors closes WITHOUT recording completion.
- **My Work, rebuilt (2026-09-19, John: "improve the look").** `pages/MyWork.jsx`
  is ~300 lines replacing a 1,400-line two-pane page (its `MyWorkRail`,
  `components/mywork/TaskList`, `TaskDetail`, `useAutosave` are deleted).
  Plain "My Work" header with a summary line (Home greets). ONE list, grouped
  Overdue · Today · This week · Later · No date, rows expanding IN PLACE to
  edit description, notes, status, priority, category, due date and assignee
  (`PUT /team/tasks/:id`, `PUT /team/tasks/:id/assign`); done tasks folded
  behind a count. An inline composer (`n` focuses it; `@` filters the team,
  picking assigns; `POST /team/tasks`). **This week, mine** = the calendar
  feed's next 7 days filtered to my task deadlines, releases assigned to me
  (`/team/my-work` releases), and payment/renewal dates I can open.
  **Waiting on you** (right rail, hidden when empty) holds only what this
  person can unblock: approvals awaiting (loop), unread mentions, invites they
  sent that are unused (`invites_pending`, new on `/team/my-work`), the
  statement cutoff (20th, within 7 days), tours updated since taken. Dropped
  on purpose: drag-reorder, pins, per-task calendar view, group-by
  switcher, the My Releases tab (the agenda carries my releases). Harness:
  `npm run mywork-dom` (21, full · empty). The my-work tour has four steps.
- **Three integrations (2026-09-20, John: "add quickbooks online, docusign,
  spotify for artists").** Shared plumbing: `server/lib/integrations-schema.js`
  (all tables, called from runMigrations after the mail tables),
  `server/lib/http-json.js` (the one HTTPS helper), `server/lib/integrations-worker.js`
  (its OWN ticker — notifier's tick bails when the Team mailbox is off — every
  10 min: QuickBooks queue + DocuSign poll; daily ≥06:00 LA: artist stats,
  claimed in `integration_jobs`). Every OAuth follows routes/mail.js: state =
  signed JWT, PUBLIC `oauth/callback`, redirect to `/settings?tab=integrations&qb|ds=…`,
  tokens encrypted under PAYMENT_DETAILS_KEY. Each has a `*_DRY_RUN=1` in-memory
  fake so its fixture runs with no keys (server on :3011 with all three dry-run
  vars). Integrations rows for quickbooks/docusign/spotify/chartmetric in
  routes/settings.js are DB-backed IIFEs.
  **QuickBooks Online is a PUSH** (`lib/qbo.js`, `routes/quickbooks.js`,
  `components/QuickBooksCard.jsx`; env QBO_CLIENT_ID/SECRET, QBO_ENV): the
  ledger is `expenses` (NOT boom_invoices — those are invoices the label
  issues; there is no vendors table, vendors are payee strings). Approve
  (`/bk/entries/:id/approve`, bulk-approve) enqueues `bill`; PUT
  `/bk/payments/:id` to Paid enqueues `payment` — `qbo.enqueue` is fire-and-
  forget AFTER the response and a no-op until connected. `qbo_queue` (one row
  per kind+root expense, SKIP LOCKED claim, backoff 1h→24h, 10 attempts; a 4xx
  from Intuit is `retryable: false` and fails once with Intuit's sentence),
  `qbo_links` (Vendor/Bill/BillPayment ids + SyncToken so a second push UPDATES),
  `qbo_connection` (one row; refresh tokens ROTATE — always store the one that
  comes back; 100-day idle expiry → `needs_reconnect`). One Bill per family
  (root + split children as lines), account per line from
  `settings.category_map[category]` else `default_expense_account` else the
  push fails naming the category; BillPayment = Check from `settings.bank_account`
  linked to the Bill; success flags `expenses.in_quickbooks='Yes'`. The card
  maps categories → accounts (read live from QuickBooks) and shows the queue
  with Retry. `server/scripts/qbo-fixture.cjs` (21).
  **DocuSign** (`lib/docusign.js`, `routes/docusign.js`,
  `components/DocuSignCard.jsx` + `components/SendForSignature.jsx`; env
  DOCUSIGN_INTEGRATION_KEY/SECRET, DOCUSIGN_ENV=demo|production): one account
  row; `POST /docusign/send` (multipart) makes an envelope — counterparty
  routingOrder 1, then the label signer from `label_settings.signatory_name`
  + NEW `signatory_email` (Settings › Label; refused with a sentence until set);
  FREE-FORM signing (no anchor tabs — the PDFs come in several layouts). Docs:
  contract (PDF from its entity_files, or uploaded), nda (rendered in the
  browser by `buildNdaPdf` and POSTed along — the server has no NDA bytes;
  `boom_ndas.recipient_email` is new), waiver (`file_id`). The source PDF is
  kept as an entity_files row on the doc. `signature_envelopes` tracks status;
  polled every 10 min / on demand / nudged by the public Connect webhook
  (which only re-reads DocuSign, never trusts the body). Completion stores the
  combined signed PDF on the ARTIST's Documents (label "Signed contract" etc.)
  and on the contract's own files, stamping `contracts.date_signed`. The pen
  icon + `SignatureBadge` sit in the row actions of Contracts, NDAs and
  Waivers. `server/scripts/docusign-fixture.cjs` (22).
  **Spotify for Artists has NO API** — the "Spotify" integration is
  `lib/artist-stats.js`: the Spotify Web API (client credentials via
  `services/spotify.getAccessToken`, now exported) writes followers,
  popularity and top tracks to `artist_stats` (one row per artist·source·day;
  `artists.spotify_id` resolved from spotify_url → artist_links → name search
  and stored), and Chartmetric (paid, CHARTMETRIC_REFRESH_TOKEN; `artists.chartmetric_id`
  looked up from the Spotify id via `/artist/spotify/:id/get-ids` — that
  endpoint's shape is read defensively and UNVERIFIED against a live key)
  writes monthly listeners. `GET /artists/:id/stats` (latest + 90-day series +
  deltas), `POST /artists/:id/stats/refresh`, admin `POST /artists/stats/refresh`;
  the roster list LEFT JOINs the latest row (`spotify_followers`,
  `monthly_listeners`, `stats_day`) for the card chip. Profile: `ArtistStatsBlock`
  at the top of the Spotify tab (sparklines, Refresh now) and a header chip.
  `server/scripts/artist-stats-fixture.cjs` (8). Tours bumped to 2026-09-20:
  artists, artist-profile, contracts. Ops: create the Intuit app (redirect
  `…/api/quickbooks/oauth/callback`), the DocuSign app (`…/api/docusign/oauth/callback`),
  set the env vars, connect both under Settings › Integrations, fill
  Settings › Label › Signatory email, map QuickBooks accounts.
- **Roles (2026-09-20, John: "whats the difference between superadmin and
  admin? add role descriptions"):** `client/src/lib/roles.js` is THE
  description of the four roles — Superadmin · Admin · Approver · User (there
  is no Bookkeeper role; that is a nav preset) — written from the code that
  enforces them, rendered as Label settings › **Roles** (`?tab=roles`,
  `RolesTab` in Settings.jsx: cards with Can / Cannot / Pages, plus the four
  axes role · pages · department · hierarchy level) and as the one-line help
  under the role picker in PersonModal (which links there). Only a Superadmin:
  manages Admin/Superadmin accounts and their page rows, writes the label's
  EIN and bank account, View-as, Restricted admin docs, permanent artist
  delete, the full archive. Page rows never bind a Superadmin, bind an Admin
  once curated, and bind an Approver/User always. When a gate changes, change
  roles.js in the same commit.
- **Flags is the exception REGISTER, with memory (2026-09-20, John: "improve the
  flags page so that nothing is missed from the get go"; his calls: absorb
  workflow stalls + setup/ops health + compliance, push via Home tile + My Work,
  Assign makes a task, sweep HOURLY).** `server/lib/flags-register.js` is the
  engine: `flag_register (kind, key)` rows upserted by a SWEEP that runs every
  detector — ~35 new ones in `DETECTORS` (Setup: label blanks, encryption key,
  mail/QuickBooks/DocuSign health, failed sends and pushes, unmapped QuickBooks
  categories, stale artist stats, statement never came, unused invites, never
  signed in · Workflow: approvals stale, payments overdue / unscheduled, holds
  and rushes aging, envelopes stuck, Signed deal with no contract, onboarding
  stalled, expired contract with no replacement, contract with no file, artist
  releasing with no contract, release unassigned / behind, tasks overdue ·
  Compliance: invoice scan discrepancies, no W-9, approved with no payment
  details, zero/negative amounts, no category, no document, foreign paid with
  no rate, advance with no artist) PLUS the data-quality detectors exported as
  `router.detectors` from routes/flags.js. A row keeps `first_seen`, gets
  `resolved_at` when a sweep stops seeing it, and is NEW to a viewer when
  first_seen > `users.flags_seen_at` (`POST /flags/seen`, stamped by the page
  AFTER its first load; the page keeps the first seen-at in a ref so a refetch
  does not erase "new"). **Dismiss and snooze bind to a fingerprint of the
  flagged VALUE** — a changed row resurfaces; the old row-level
  `flag_dismissals` gained `value_fingerprint` for the same reason.
  **A detector that throws does not clear its rows**; the error lands in
  `flag_sweeps.errors` and the page names the check ("2 checks could not run").
  Thresholds are `DAYS` at the top of the lib. Gating is the loop's: every kind
  carries the `page` that resolves it and is shown only under `pagesReachable`;
  Setup and bank kinds also carry `roles`. Hourly: `integrations-worker` claims
  `flags_sweep` per hour; `POST /flags/sweep` (Admin) is the page's "Check now".
  `GET /flags` returns `{ data, meta }` — register categories carry
  `register: true` and render through ONE component
  (`components/flags/RegisterSection.jsx`: Open · Assign · Snooze · Dismiss);
  data-quality categories carry `tracking` {new, oldest_days, owner} and
  `truncated`/`shown` when the body is capped (the header used to say 1,240
  over 500 rows with nothing admitting it). **Assign** (`POST /flags/assign`,
  key `'*'` = the whole category) makes ONE task (`tasks.flag_kind/flag_key`,
  `flag_assignments`) in the assignee's My Work, linked back, and the sweep
  closes it with a note when the flag clears. Push: Home loop section `flags`
  (`summaryFor`) → the Flags tile; My Work "Waiting on you" row. The rail lists
  only categories with something in them plus "N checks clear" per group; the
  all-clear card lists every group with its count of checks. Order: Setup ·
  Money · Workflow · Compliance · Ledger · Catalog · Artists. **Boom-tuned rules
  made data:** `bk_categories.artist_required` (seeded from the ten hard-coded
  names; missing artist/song read it), socials scope = Campaigns'
  `CAMPAIGN_CATEGORIES` + PR. Left alone on purpose: `unknown` stays a real
  artist name (John's Boom call, recorded in lib/artist-key.js — ask before
  changing); the statements engine's 31 flag types are not in the register
  (they keep fingerprint acks on Statements); 1099 readiness, the recoupment
  audit's five checks and `/statements/unattributed` are not detectors yet (their
  logic is embedded in route handlers). Harnesses: `server/scripts/flags-register-fixture.cjs`
  (45), `npm run flags-dom` (35, admin · section · empty · user); home-dom (51)
  and mywork-dom (24) grew the tile and the rail row. Tours `flags` and `home`
  bumped to 2026-09-21.
- **Keyboard: ONE vocabulary, one file (2026-09-20, John: "what other
  keyboard shortcuts would be useful?" — his calls: g-then-letter navigation,
  standardise even where it renames an old key, keys on every list page and
  the forms, discovery by context-aware ? help + hover hints + a one-time toast
  + a step in every page tour).** `client/src/lib/shortcuts.js` is THE list:
  `PAGE_KEYS[path]` (key spec + label per page), `GOTO` (g then h/m/f/c/i/t/r/
  d/k/a/p/l/b/v/e/o/s), `GLOBAL_KEYS`. Three readers, so nothing drifts: pages
  bind through `hooks/usePageShortcuts(path, { spec: handler })` (a handler for
  a key not in PAGE_KEYS is refused; `null` = advertised, handled elsewhere —
  Messages' ⌘Enter, My Work's n); `components/KeyboardShortcutsHelp` lists
  THIS page's bound keys first (from `context/ShortcutsContext`), then the
  global keys and the go-to letters the viewer can open; `tours/index.js`
  appends a "Keys on this page" step to every page tour with keys, BEFORE the
  welcome walk is built (versions bumped to 2026-09-22). The vocabulary: j/k
  move, Enter open, e edit, x select, f filter, n new, . refresh, s sort, y
  sync, [ ] section, z/⌘Z undo. Renamed: Home r→., Catalog s→y, Ledger export
  x→Shift+X (x is select). **Row navigation is DOM-driven**
  (`hooks/useListKeys`): rows carry `data-row` (+ `data-entry-id` where a verb
  needs the record), verbs click `[data-key="p"]` inside the focused row, Enter
  prefers `[data-row-open]`; the focused row is `data-row-focused="1"`
  (index.css draws the rail); rows under `[hidden]` are skipped, geometry is
  never consulted (jsdom). `f` focuses the first visible `[data-filter]` —
  `ListSearch` carries it, so every page using it got f for free.
  `components/GoToChords.jsx`: the chord listener is CAPTURE-phase (page
  hotkeys register before Layout's, so a bubble listener would let `g f` both
  jump AND hit the page's f) with a 1.5s hint panel; `useShortcutChrome` does
  ⌘Z → the page's `registerUndo` (Payments' showUndo and Ledger's handleUndo
  register), the one-time toast (`shortcuts_hint_v1`), and a MutationObserver
  that appends " · P" to the title of every `[data-key]` control. Wired:
  Flags, Payments (p/h/u/x/Enter act on the focused row's entry), Approvals,
  Ledger, Vendors, Roster, Contracts, Releases, Catalog, Calendar, Deals, Team,
  Activity, Home (1-6 open the tiles), Create invoice, Messages, My Work.
  Fixtures: `npm run shortcuts-fixture` (paths in nav, no duplicate keys, no
  global key rebound, every keyed tour ends on its keys, no bare `useHotkeys`
  left on a page), flags-dom grew j/d assertions, tour-dom grew the keys step.
  Not done: Esc as a universal modal close (each modal owns its own), ⌘S on the
  NDA/waiver/Settings forms (they have no single save), Enter/e on Ledger rows
  (inline editing has no single "open").
- **Reports, second pass (2026-09-20, John's calls: selectable basis with a
  data-driven default · prior period + year-over-year · budget vs actual ·
  quarter and year columns · charts incl. invoices received · monthly
  accountant pack by email · spend by vendor and by rep · an honest balance
  sheet).** **THE BASIS** (`routes/reports.js`): `rowsFor(from, to, basis)`
  hands `buildPnl` / `pnlDetail` either `bankRows` (statements are the
  master — the only PROVABLE basis) or `ledgerRows` in the SAME row shape:
  `ledger` = every alive approved row marked Paid by `payment_date`, statement
  or not; `accrual` = every alive approved row by `COALESCE(invoice_date,
  created_at)`, paid or not; income from `artist_income.income_date` on both.
  Each ledger row is its own part (a family is root slice + children, each
  with its own category/artist), dismissals bind by the SAME fingerprint so
  one dismissal holds on every basis, and the "unverified" band exists only on
  the bank basis. `?basis=` on /pnl, /pnl/detail, /spend-by-artist and the
  exports; unknown → bank. `GET /reports/basis` → default `bank` once ANY
  `statement_months` row is reconciled, else `ledger` — a fresh label read
  zero under the bank basis however much it had paid. The client remembers a
  chosen basis (`reports_basis`) and an email link's `?basis=` wins; nothing
  money-shaped is fetched until a basis is known. **Cuts:** `GET /spend-by?dim=
  vendor|rep` (`buildSpendBy`: operating expense parts by payee / `m_rep`,
  months across, equals the P&L's operating total — fixture-asserted),
  `GET /intake` (vendor invoices RECEIVED by invoice month with the
  pending/approved/paid split; basis-free), `GET /budget-vs-actual` (the
  simple sheet's Advance + Marketing vs the P&L's per-artist range and
  lifetime figures). **Client** (`pages/Reports.jsx` + `components/reports/*`,
  `lib/pnlRollup.js`): `pnlRaw` is the state, `pnl = rollupPnl(pnlRaw, gran)`
  sums every month-keyed series into quarters/years (a period drill asks the
  server for the period's from/to); compare = a SECOND fetch of the same
  report for `shiftRange(from, to, 'prior'|'yoy')` on the same basis,
  rendered as `ComparePanel` (totals + biggest movers), never as extra table
  columns; `ReportCharts` (recharts, measured widths — no ResizeObserver in
  jsdom; palette validated with the dataviz skill; ONE axis per chart) reads
  the same payloads as the tables; tabs Vendors · Reps · Budget vs actual.
  **The accountant pack:** `buildPack(from, to, basis)` → Cover (period,
  basis, reconciled-through, excluded counts) · P&L · Balance sheet as of `to`
  · Spend by artist · vendor · rep · Dismissed; `GET /pack.xlsx`;
  `report_pack_settings` (id 1: enabled, day 1–28, recipients, basis,
  last_sent_period) via GET/PUT `/pack/settings`; `POST /pack/send` (needs the
  Team mailbox; `MailNotConnected` → 409); notifier job `accountant_pack`
  claims DAILY at 09:00 and sends the previous calendar month once, on or
  after the day, remembering `last_sent_period`. **Balance sheet honesty:**
  `proof { cash_known, note, sources[] }` — no journal, so it cannot fail to
  balance and says so; cash is UNKNOWN (not zero) with no statement; the
  derived line is labelled "Unexplained difference (derived)", not equity.
  Financials stays (hidden) and links to Reports on accrual. Harnesses:
  `server/scripts/reports-basis-fixture.cjs` (26, run with `MAIL_DRY_RUN=1`
  on both sides — it seeds a Team mailbox for the send), `npm run reports-dom`
  (27: full · empty · bs · vendors · budget). Left open: the 1099 readiness
  sheet in the pack (its builder is embedded in the /bk/1099 route), saved
  named reports, cell notes, closed-month locks.
- **Ledger, second pass (2026-09-20, John's calls: filters behind one button
  + chips + URL + saved views · a row drawer with core default columns ·
  summary strip · group by with subtotals · a Needs-attention filter · row
  utilities · the desktop empty state · Tone Labels → Recoup label).**
  `components/ledger/LedgerFilters.jsx`: `FilterPopover` (the nine dropdowns
  + amount, driven by a `filterFields` model in BkLedger), `ActiveChips`,
  `DateRange` (invoice date, `QUICK_RANGES`), `AttentionToggle`, `SavedViews`
  (built-ins + this browser's, `bk_ledger_views_v1`), and `needsAttention(e,
  ctx)` — flagged · no document · no W-9 · paid with no bank line
  (`bankUnverified`) · not in QuickBooks when QuickBooks is in use — ONE
  predicate the toggle and the summary share. **Filters live in the URL**
  (`q amt qb recoup cat artist paid method flag bulk src from to attn group
  sort`; read once on mount, written with `replace`; only these keys are
  touched — `focus` / `xhalf` / `stmt` belong to other code in the file).
  `LedgerSummary.jsx` sits above the table: root-row count, total by
  currency, paid vs unpaid, attention count, and the Group by picker;
  grouping inserts `{ __group: true }` header rows into `flat` with family
  subtotals (root slice + children), groups in the order the sort first
  meets them; `renderable` lets them through. `LedgerDrawer.jsx` opens from
  the › in the payee cell (`data-row-open`), a double-click on a row (not on
  a control), or Enter on the focused row: details, documents with a
  drop-to-attach chooser (`POST /bk/entries/:id/file/:type`), the split
  family, bank evidence, QuickBooks, history (`GET /bk/entries/:id/history`,
  bookkeeping roles — `bk_audit_log` by entry), Clone (`POST /bk/entries`
  with `cloneBody`: same fields, dated today, unpaid, no invoice number) and
  Save as template (`ledger_templates`, GET/POST/DELETE `/bk/templates`,
  `TemplatesMenu` "From template" in the toolbar). Dropping a file on a ROW
  opens the drawer with the file staged. **Core columns**: Description,
  Email, Bank, Socials, Rep, Paid By, Recoup label and Reimb? default OFF;
  storage keys bumped (`bk_ledger_hidden_cols_v2`, `bk_bank_…_v3`) so an
  old key cannot pin the old default. The desktop table's "No entries
  found." is now the same `EmptyState` the mobile list had, and a filter
  that matches nothing offers Clear filters. Harnesses: `npm run ledger-dom`
  (30: full · empty · url), `ledgervendor-dom` still green. Not done:
  column resize/reorder, a density toggle, recurring schedules (a template
  is one click, not a timer).
- **Vendor form bug pass (2026-09-20, John: "check the vendor submit form for
  any bugs").** A code review found 21 defects; the harnesses were green
  through all of them because none pressed Back, pressed Enter, removed an
  invoice, or drove a real parse result (the stub returned `{ parsed: {} }`,
  a shape the page never reads). Fixed on `VendorSubmit.jsx` and mirrored to
  the lab with `sync-vendor-lab.mjs --force`: **Back from step 3 saves the
  invoice's answers** (`saveProject(active)`) and Next reuses a parse for an
  unchanged file (`parsedFor`) instead of wiping every field and re-spending
  the AI; **Enter never submits from steps 1–2** (a form-level onKeyDown
  advances the step; `handleSubmit` refuses off step 3); **invoices carry a
  stable `key`** and the scan / dup check write back by key with a
  same-file guard (`updateInvoiceByKey`), so removing a row mid-scan cannot
  strand `validating` or land a verdict on the wrong card;
  `payment-on-file` no longer overrides a chosen method and "use details on
  file" applies only while the METHOD matches; the client mirrors the
  server's shape checks (ABA checksum, 4–17 digit US account, IBAN/SWIFT,
  PayPal) so a typo fails on step 1 not after the wizard; `applyParsed`
  reads the project being LOADED, not the stale render closure; category /
  currency / rep carry to a fresh invoice (`freshProject` — CLAUDE.md said so,
  the code never did); two cards sharing a number are refused on the client;
  file inputs are keyboard-reachable (`sr-only` + a keyboard-operable drop
  zone); Submit Another keeps the just-uploaded W-9 as on file; a
  `beforeunload` warning past step 1. Server (`routes/vendor-submit.js`,
  `index.js`): **the invoice-number gate skips reimbursements** (a receipt
  has no invoice number; the client already skipped the parse for them, so
  reimbursements were unfinishable whenever the AI read the receipt
  confidently); the AI limiter is 30/min (a ten-invoice batch 429'd at the
  sixth call and the pre-flight gate fell open silently); `/roster` hides
  archived artists; `/payment-on-file` and `/roster` sit behind
  `vendorReadLimiter`; the 500 body carries `detail` only outside production;
  the validation prompt's alias list is real again ("Market.st", "Market St"
  — it read "Market Street" three times). `vendorform-dom` gained `backnext`
  · `enter` · `remove` (PARSE=1 makes the parse stub answer in the page's
  shape; SLOWSCAN=1 delays the second scan). Not fixed: the localStorage
  draft saves one invoice's answers for a multi-invoice batch (restore lands
  them on invoice 1); a 429 on the pre-flight parse is still silent (the
  server gate still runs at Submit).
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
- **Provisioned:** Railway service (`marketst-production.up.railway.app`, root dir `boom-dashboard`, auto-deploy on `main`), Cloudflare R2, Anthropic key, `PAYMENT_DETAILS_KEY`. **Not yet:** Gmail sender, Google OAuth client. Settings › Integrations shows which is which; the env var names the server reads are listed as comments at the bottom of `server/.env`.

## Root-Level Files

- `boom-dashboard/` — the monorepo (client + server)
- `README.md` — what the app is and what it is for, plus the fork status
- `BOOM-DIFFERENCES.md` — every difference from the Boom dashboard since the fork, tagged PORT / PORT (config) / LABEL, written as the porting guide for the Cadence project. Update it when a fork rule is added.
- `tools/` — one-off operator scripts, run by hand, never by the app
  - `get-refresh-token.js` / `.py` — mint a Gmail API refresh token for the server's `GMAIL_REFRESH_TOKEN`. They need a Google OAuth `client_secret_*.json` beside them (sensitive — gitignored, not copied from Boom)

## Nothing is installed at the root

There is no root `package.json`, and `node_modules/` is ignored here. If you find dependencies at this level, they are a mistake from an `npm install` run in the wrong directory.
