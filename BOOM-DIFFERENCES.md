# Market Street vs. Boom: what changed since the fork

A porting guide. The Market Street dashboard was forked from the Boom Records
dashboard's working tree on 2026-09-15. Since then, 43 commits have reshaped it.
This document lists every difference, says why it was made, names the files,
and marks whether it belongs in Cadence.

**Reading the tags**

- **PORT** — general improvement; belongs in Cadence as-is.
- **PORT (config)** — belongs in Cadence, but the label-specific values (names,
  colours, copy) need to become configuration.
- **LABEL** — a Market Street decision; do not port without asking.

**What did NOT change, on purpose.** Architecture (Express + pg raw SQL, React 18
+ Vite + Tailwind, Railway, Neon), every route path, every table name, and every
internal identifier: `boom_rep`, `BOOM_REPS`, `BoomRepsContext`, the `boom-*`
Tailwind accent classes, `boom_invoices` / `boom_ndas` / `boom_label_waivers`,
`BOOM_INFO`, `BOOM_DEFAULTS`. The app still lives in a folder called
`boom-dashboard/` so fixes port between repos by path. Boom's own guide,
`boom-dashboard/CLAUDE.md`, is kept verbatim under a fork notice.

---

## 1. Identity and setup

| Change | Tag | Where |
|---|---|---|
| Visible rebrand only: strings, emails, domain, package names, favicon, accent | PORT (config) | grep for `Market Street`; `client/tailwind.config.js` `boom` palette, `client/src/styles/tokens.css` |
| Seed is one Superadmin from `PW_JOHN`; no business data carried over | PORT | `server/seed.js`, `syncUsers` in `server/index.js` |
| Empty data shells: `server/data.json`, `server/data/pending-contracts.js`, payroll/category seeds carry no rows | PORT | those files |
| URL fallbacks point at the Railway domain instead of `boom-ap.com` | PORT (config) | `FRONTEND_URL` fallbacks, `client/.env.production`, og tags, user manual |
| Bank-statement parsers still tuned on Boom's Bank of America layout; the AI fallback does the work until a real statement is seen | LABEL | `server/lib/statements.js`, `funding-pairs.js` |

**Cadence note:** everything in this table is the kind of thing Cadence should
read from a `label` config or the `label_settings` row (section 7), never from
code.

## 2. Removed from Boom

| Removed | Why | Tag |
|---|---|---|
| Bulk upload, bulk re-upload, QuickBooks import, master-sheet import, Legal page and their routes (`routes/import.js`, `lib/masterSheet.js`, `scripts/import-master-sheet.js`, `GET /bk/admin/corrupt-invoices`) | Boom-specific migration tooling; "not needed, remove the code" | LABEL (Cadence may want import tools; the QuickBooks *import* is superseded by the *push* sync in section 11) |
| Test users: mock axios adapter, `testUserGuard`, Test Users tab, Demo Mode banner, every `is_test` read | Feature not wanted; column left in the DB unread | PORT (removal simplifies) |
| Boom's five overwrite-on-apply permission templates | Replaced by additive presets (section 4) | PORT |
| The Users tab and Permissions matrix in Settings | Replaced by People + per-person Access editor (section 7) | PORT |
| Label stat cards and the dead Flask `/api/dashboard-summary` fetch on Home | Home became the loop (section 5) | PORT |
| `TODO(marketst)` placeholders for EIN, address, bank, signatory | Moved into Settings › Label | PORT |

## 3. Sidebar: 43 rows became 16 — PORT

`client/src/navConfig.jsx` groups pages into `tabbed` families (Releases,
Contracts, Documents, Invoices, Bank, Vendors, Recoupments, Artist Spend,
Settings) that render as tabs across the top. **No path moved.** Pages leave
the sidebar with `hidden: true`, never by deletion, so a hidden page stays
grantable and ⌘K-searchable. Hidden: Financials, Recording Budgets, Salary,
Bulk Deals, Invoices View, Bookkeeper Reconcile, Add Reimbursement, Analytics.
`client/scripts/nav-fixture.mjs` encodes the layout; the page-access fixture
must stay byte-identical across any nav change.

Boom reverted a similar regroup in Aug 2026, so port this deliberately and
with the fixture.

## 4. Roles, presets, departments — PORT

- **Presets are additive** (`client/src/lib/navPresets.js`): anr, marketing,
  bookkeeper, ops, executive. A department seeds the default tick when an
  account is made; an admin can tick a second preset and the pages union.
  "Add preset…" adds pages; Clear starts over. `navpresets-fixture.mjs` checks
  each list against `NAV_PAGES` and the real `canViewPath`.
- **Departments:** Executive, A&R, Marketing, Finance, Operations. Executive
  defaults to `hierarchy_level` 1.
- **My Nav** lists only pages the sidebar draws for the person, naming family
  children as `Releases › Pipeline`.
- **Roles page** (`client/src/lib/roles.js`, Settings › Roles): the four roles
  described from the code that enforces them, with Can / Cannot / Pages, and the
  four axes people conflate (role, pages, department, hierarchy level). The role
  picker shows the one-liner and links there. There is no Bookkeeper role; that
  is a preset.

## 5. Home is the loop — PORT

`GET /api/dashboard/loop` returns approvals, payments, bank, releases,
onboarding, each a count + USD + one destination, each NULL when the caller
cannot open that destination (`pagesReachable` in
`middleware/pagePermission.js`). The client's `canView` is the second gate.
Order: Loop → Start (quick actions) → Next 7 days + Recent activity → Latest
releases → charts. When every section is zero the six tiles collapse to one
line. Empty sections say what fills them, never a bare 0. Charts render only
with data. Recent activity is everyone else's changes via `lib/activityText.js`
`humanizeAction`, shared with the Activity page. Harnesses: `home-dom` (49),
`home-loop-fixture.cjs`.

## 6. Flow: empty states, hand-offs, artist hub, team calendar — PORT

Plan: https://claude.ai/code/artifact/2390f265-defe-4019-b14d-5e3965a2f44b

- **A. Empty states.** `components/EmptyState.jsx` is THE empty state (title,
  one-sentence body, one action, a source link). Wired into every list page.
  The Roster gained **Add artist**; nothing could create an artist by hand
  before.
- **B. Hand-off prompts.** `components/NextStepPrompt.jsx` + `useNextStep()`:
  a dismissible card with ONE prefilled link, never a redirect. Deal → Signed
  prompts a contract; saved contract prompts a release; release prompts the
  budget; first approval prompts Payments; first mark-paid prompts Statements;
  reconciling prompts Reports. `handoff-dom` (17).
- **C. Artist hub.** The profile has Budget, Recoupments and Campaigns tabs
  (read-only, gated by the same `canView` as the page behind each, fetched on
  open). `GET /artists/resolve?name=` folds a spelling to the roster row;
  `hooks/useArtistLink.js` gives name-keyed pages a Breadcrumb back to the
  profile. Generated NDAs save to the recipient artist's Documents.
  `hub-dom` (37).
- **D. Team calendar.** `GET /calendar` is one typed feed: release dates, DSP
  dates, signings, contract expiries as renewals, task due dates, payment due
  dates, manual events, each carrying `to`. Gated by `pagesReachable`, never
  role name; `sources` says which feeds were withheld. The legend IS the
  filter. `calendar-dom` (31), `calendar-fixture.cjs` (18).

## 7. Settings, rebuilt — PORT

Plan: https://claude.ai/code/artifact/6b91930c-f930-40c7-bbe2-696c2ac4599c

- **Two halves** with a left rail (`components/SettingsShell.jsx`): My settings
  (Profile, Sign-in, Notifications, My mailbox, Theme, My Nav) for everyone;
  Label settings (People, Label, Integrations, Roles, Activity, Admin docs,
  Sandbox, Archive) for admins. `?tab=` deep-links.
- **People** = `/team` directory (role, department, presets, last sign-in, open
  tasks, invite pending) + `/team/:id` Access tab (`AccessEditor`). Replaces
  the Users tab and the permissions matrix.
- **Label record** = `label_settings` (one row; `routes/label.js`): legal and
  display name, address, contact, signatory name/title/email, payment terms,
  EIN and bank encrypted with last-four shown. Consumers: invoice remittance,
  NDA and waiver defaults, email footers. EIN and bank writes are
  Superadmin-only; `GET /label/remittance` is audited.
- **Invites** = `user_invites` (`lib/invites.js`): token in the URL, SHA-256 in
  the table, 7 days, resend voids. New accounts have `password_hash NULL`;
  `/invite/:token` sets the password; login refuses a password-less account
  with a sentence naming the invite. Invites can be emailed.
- **Integrations tab** reads env presence and DB state, never a key. Cards for
  Mail, QuickBooks, DocuSign sit above the list.
- **Activity page** hides reads by default and no longer logs page views.

## 8. Signing an artist — PORT

Plan: https://claude.ai/code/artifact/c4388ce4-710c-48d4-8128-81f37bfbf826

Terms and contact live on the **deal** (advance, split, term, territory,
releases, options, emails, manager, socials, Spotify URL). `signDeal()` in
`routes/deals.js` runs once, in a transaction, idempotently, when a deal
reaches Signed: roster row created or matched, the advance as an approved
Unpaid Net-30 recoupable expense payable to the artist, a `signed` calendar
event. The **onboarding checklist is computed, never stored**
(`lib/onboarding.js`): contract on file, payment details + W-9, advance paid,
budget typed, first release dated. Surfaces: profile panel, roster chip and
filter, Home loop tile. `POST /artists/:id/payment-details` lets an admin type
bank details in; `PUT /artists/:id/contact` edits contact.
`signing-fixture.cjs` (41), `onboarding-dom` (32).

## 9. Simpler artist budgets — PORT (ask first)

`/artist-budgets/:key` is a two-total sheet (Advance, Total marketing) with
release budgets under marketing and a read-only Other spend line; the
32-category grid moved to `/detail` ("Full breakdown"). Category sets are
imported from reports.js and artist-campaigns.js so the sheet cannot disagree
with the P&L. Boom's users may prefer the full grid as the default.

## 10. My Work, rebuilt — PORT

`pages/MyWork.jsx` (about 300 lines) replaces a 1,400-line two-pane page. One
list grouped Overdue · Today · This week · Later · No date, rows expanding in
place; an inline composer with `@` assignment; "This week, mine" from the
calendar feed; a "Waiting on you" rail (approvals, mentions, unused invites,
statement cutoff, updated tours) hidden when empty. Dropped: drag-reorder, pins,
per-task calendar, group-by switcher, My Releases tab. `mywork-dom` (21).

## 11. Integrations added — PORT (config)

Shared plumbing: `server/lib/integrations-schema.js`, `lib/http-json.js`,
`lib/integrations-worker.js` (its own ticker: every 10 min QuickBooks queue +
DocuSign poll; daily artist stats). Every OAuth copies `routes/mail.js`: state
is a signed JWT, the callback is public, tokens are encrypted under
`PAYMENT_DETAILS_KEY`, failures redirect to Settings with a reason. Each service
has a `*_DRY_RUN=1` in-memory fake so its fixture runs with no keys.

- **Connected mailboxes** (`lib/mail.js`, `lib/gmail-transport.js`,
  `routes/mail.js`): `sendMail({ purpose | kind, … })` is the ONE send path.
  Shared and personal Google mailboxes, five purposes (payments, vendors, team,
  artists, clients), a From selector on the preview modal, Reply-To for a human
  sending from a shared box, `mail_log`, `MailNotConnected` with a sentence
  screens show. The env sender is imported on boot as the first shared mailbox.
  `lib/notifier.js` runs hourly digests (approvals waiting, payments due,
  renewals, weekly) claimed once per period. `mail-fixture.cjs` (21, needs
  `MAIL_DRY_RUN=1` on server and fixture).
- **QuickBooks Online push** (`lib/qbo.js`, `routes/quickbooks.js`,
  `components/QuickBooksCard.jsx`): approve → Bill (vendor matched or created,
  one line per split, account from the category map or default), mark paid →
  BillPayment from a chosen bank account. Retry queue with backoff, links so a
  second push updates, rotating refresh tokens. Flags
  `expenses.in_quickbooks`. `qbo-fixture.cjs` (21).
- **DocuSign** (`lib/docusign.js`, `routes/docusign.js`,
  `components/SendForSignature.jsx`, `DocuSignCard.jsx`): Send for signature on
  Contracts, NDAs and Waivers; counterparty first, then the label signer from
  Settings › Label; free-form signing; status polled and webhook-nudged; the
  signed PDF lands on the artist's Documents and the contract.
  `boom_ndas.recipient_email` is new. `docusign-fixture.cjs` (22).
- **Artist stats** (`lib/artist-stats.js`): Spotify for Artists has no API, so
  the Spotify Web API writes followers, popularity and top tracks daily to
  `artist_stats`, and Chartmetric (paid) writes monthly listeners. Roster chips,
  profile header chip, sparklines on the Spotify tab. `artists.spotify_id` and
  `chartmetric_id` are resolved and stored. `artist-stats-fixture.cjs` (8).

## 12. Emails wear the label's look — PORT (config)

`server/lib/email-layout.js` is the one frame: paper ground, a green street
sign with the label's short name, monospace headings, a flat accent bar per
email kind, a footer with the label's details from `label_settings`. Every
template (welcome, invite, approved, rejected, payment confirmations, task,
mention, request, digests, approval summary, test) renders through it. For
Cadence, the palette and the sign are the parts to make configurable.

## 13. Click-through tours — PORT

`client/src/tours/index.js` is the list: a welcome walk built from the page
tours (every step of every page's tour, in order), and one short tour per
page. `components/Tour.jsx` is the spotlight engine: anchors by
`data-tour="…"`, comma-separated fallbacks with the first visible match,
`step.needs` and `roles` gating, Skip this page / Skip tour, completion per
user per VERSION in `users.tours_done`, a Walkthrough button in the header,
bottom-sheet card and drawer handling on phones. THE RULE: a change to a page
changes its tour in the same commit and bumps its version. `tours-fixture.mjs`
fails when a tour points at an element no page renders. `tour-dom` (33).

## 14. Brand page — PORT

`/brand` (`pages/Brand.jsx`, `routes/brand.js`): the label's logos and photos
as `entity_files` rows, uploaded and downloaded by anyone on the team, SVG
served as an attachment so a vector logo can never run on the origin.

## 15. The public vendor form theme — LABEL

`client/src/styles/marketst-form.css` is a theme layer scoped to `.ms-form`:
halftone paper, a MARKET.ST street sign, flat colour bars for the steps,
"ENTER" buttons, IBM Plex Mono headings. Built in `VendorSubmitLab.jsx` and
promoted with `sync-vendor-lab.mjs --promote`. Cadence would want its own
theme layer using the same hooks, not this one.

## 16. Harnesses and fixtures added

Client (`cd client && npm run …`): `home-dom`, `handoff-dom`, `hub-dom`,
`calendar-dom`, `budgetsimple-dom`, `onboarding-dom`, `settings-dom`,
`mywork-dom`, `tour-dom`, `tours-fixture`, `nav-fixture`, `navpresets-fixture`,
`vendorform-dom`, `flags-dom`, `shortcuts-fixture`, `reports-dom`, `ledger-dom`. Server (`server/scripts/*.cjs`, against a server on :3011):
`home-loop`, `calendar`, `signing`, `artist-budget-simple`,
`artist-budget-name`, `settings`, `label`, `invite`, `brand`, `mail`,
`gmail-transport`, `qbo`, `docusign`, `artist-stats`, `flags-register`, `reports-basis`. Two harness lessons
worth carrying: migrations run AFTER listen, so fixtures sleep after `/health`;
and jsdom for the client harnesses lives in `/tmp/domtest`, which macOS prunes.

---

## 17. Flags is an exception register — PORT

`server/lib/flags-register.js` (new), `routes/flags.js` (exports `detectors`,
returns `{ data, meta }`, endpoints `/summary` `/seen` `/sweep`
`/register/dismiss` `/assign`), `routes/dashboard.js` (loop section `flags`),
`lib/integrations-worker.js` (hourly claim), `components/flags/RegisterSection.jsx`,
`pages/Duplicates.jsx`, `Dashboard.jsx`, `MyWork.jsx`. Tables `flag_register`,
`flag_sweeps`, `flag_assignments`; columns `users.flags_seen_at`,
`tasks.flag_kind/flag_key`, `flag_dismissals.value_fingerprint`,
`bk_categories.artist_required`. Root CLAUDE.md "Flags is the exception
REGISTER" has the rules. Ports cleanly: nothing in it names Market Street; the
Setup detectors read `label_settings`, `mailboxes`, `qbo_connection`,
`docusign_account` which Cadence would map to its own tables. The LABEL-shaped
part is the seed for `artist_required` (Boom's ten category names) and the
`DAYS` thresholds.

## 18. Keyboard vocabulary — PORT

`client/src/lib/shortcuts.js` (PAGE_KEYS / GOTO / GLOBAL_KEYS), `hooks/usePageShortcuts.js`,
`hooks/useListKeys.js`, `context/ShortcutsContext.jsx`, `components/GoToChords.jsx`,
`components/KeyboardShortcutsHelp.jsx` (context-aware), `data-row` / `data-key` /
`data-filter` attributes on the list pages, the keys step in `tours/index.js`,
`scripts/shortcuts-fixture.mjs`. Nothing label-shaped in it; GOTO's letters
follow the nav paths, which Cadence shares. Root CLAUDE.md "Keyboard: ONE
vocabulary" has the rules.

## 19. Reports: selectable basis, cuts, charts, the accountant pack — PORT

`routes/reports.js` (`rowsFor` / `ledgerRows` / `defaultBasis` / `buildSpendBy` /
`buildPack` / pack settings + send), `lib/notifier.js` (job `accountant_pack`),
`components/reports/*`, `lib/pnlRollup.js`, `pages/Reports.jsx`. Table
`report_pack_settings`. Nothing label-shaped; Cadence is ledger-mastered so its
default basis would simply be `ledger`. Root CLAUDE.md "Reports, second pass".

## 20. Ledger: filters behind one button, URL state, saved views, drawer, grouping — PORT

`components/ledger/*` (LedgerFilters, LedgerSummary, LedgerDrawer + TemplatesMenu),
`pages/BkLedger.jsx` (filterFields model, URL sync, grouping in `flat`, the
drawer), `routes/bookkeeping.js` (`GET /entries/:id/history`, `/templates`
CRUD, table `ledger_templates`). Nothing label-shaped. Root CLAUDE.md "Ledger,
second pass" has the rules; the storage-key bump matters when porting.

## 21. Security pass — PORT

`middleware/auth.js` (session-token check, `QUERY_TOKEN_PATHS`),
`routes/auth.js` (register tiering, `email_verified`, impersonation `imp`
claim + audit), `routes/bookkeeping.js` (per-row checks on PUT and every
document route, W-9 role gate, `entry_source` admin-only, inline MIME
allowlist, CSV formula guard), `routes/label.js` (`BANK_FIELDS` masking),
`routes/team.js` `routes/calendar.js` `routes/invoices.js` `routes/artists.js`
`routes/deals.js` `routes/flags.js` (owner/role gates), `routes/settings.js`
(token_version bump), `routes/vendor-submit.js` (holder_name dropped,
check-similar needs email, multer caps, daily AI limiter, `singleUpload` 400s),
`middleware/secureUpload.js`, `lib/notifier.js`, `lib/email-layout.js`,
`index.js` (CORS, referrer policy, static uploads removed, google limiter),
`routes/statements.js` one-character fix; client `window.open` noopener and the
vendor form no longer showing the account holder. Fixture
`server/scripts/security-gates-fixture.cjs`. Nothing label-shaped — Boom has
every one of these holes; port the whole commit. Root CLAUDE.md "Security pass"
lists what was recommended but not done.

## Suggested order for Cadence

1. Sections 3, 4, 7 (sidebar, presets, Settings) — they define the shape
   everything else hangs on.
2. Sections 5, 6, 8 (Home loop, flow phases, signing) — the operational core.
3. Section 11 (integrations), then 12 and 13 (emails, tours) — each is
   self-contained behind env vars and a DRY_RUN fake.
4. Sections 9, 10, 14 as wanted.
5. Skip 15; ask before 2's LABEL rows.

Every section above has a fuller entry in this repo's `CLAUDE.md` under "Fork
rules", with the gotchas that bit while building it.
