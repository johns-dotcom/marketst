# Cadence port log

One row per Market Street commit that should also land in Cadence
(`/Users/johnskead/Desktop/DevProjects/cadence`). This is the CHECKLIST;
`BOOM-DIFFERENCES.md` is the narrative — the section number in each row says
where the reasoning, file list and harness for that change are written up.
Root `CLAUDE.md` "Fork rules" carries the full rule for each.

**How to use it from the Cadence repo (Claude Code):**

1. `node /Users/johnskead/Desktop/DevProjects/marketst-dashboard/tools/port-log.mjs`
   prints every `todo` row, oldest first. Port in that order unless a row says
   otherwise — later rows build on earlier ones (the tour engine, the Flags
   register, the shortcut vocabulary).
2. For a row, read its `BOOM-DIFFERENCES.md §` and `git show <commit>` in the
   Market Street repo. Files port by PATH: both apps keep the `boom-dashboard/`
   layout (Cadence: `client/`, `server/` at its root; Market Street:
   `boom-dashboard/client`, `boom-dashboard/server`). Cadence is multi-tenant —
   every table read or written needs its `label_id` / tenant scoping added;
   every label-specific string becomes tenant config.
3. When it is in: `node …/tools/port-log.mjs done <ms-commit> <cadence-commit>`
   (or `skip <ms-commit> "reason"`). The row's Status column is the record.

**How to keep it (Market Street, Claude Code):** right AFTER committing a change,
run `node tools/port-log.mjs add HEAD PORT <§> --commit` — it writes the row from
the commit message and commits the log on its own ("Port log: row N for …").
The row needs the hash, which exists only after the commit, and amending would
change it — so the row always rides in the next commit, and port-log commits
themselves never get a row. Housekeeping commits (docs only, fork bookkeeping,
label-only looks) get a `skip` row so the list stays complete rather than curated.

**Tags:** PORT = as-is · PORT (config) = port, but label-specific values become
tenant config · LABEL = a Market Street decision, do not port without asking ·
HOUSEKEEPING = nothing to port.

**Status:** `todo` · `done <cadence-sha>` · `skip — reason`

| # | Date | Commit | Update | Tag | § | Status |
|---|---|---|---|---|---|---|
| 1 | 2026-09-15 | aebc187 | Fork the Boom Records dashboard as the Market Street dashboard | HOUSEKEEPING | 1 | skip — the fork itself |
| 2 | 2026-09-15 | 23044fe | Point URL fallbacks at the real Railway domain | PORT (config) | 1 | skip — Cadence has tenant domains |
| 3 | 2026-09-16 | 97d0d1f | Empty the Boom catalog checklist the startup import reads | PORT | 2 | todo |
| 4 | 2026-09-16 | 8a06a91 | Script to remove the Boom checklist import from production | HOUSEKEEPING | 2 | skip — one-off |
| 5 | 2026-09-16 | ec9cdd8 | Cleanup script pages through artists | HOUSEKEEPING | 2 | skip — one-off |
| 6 | 2026-09-18 | 5f60b4d | Regroup the sidebar: 43 rows become 16, no path moves (tabbed families, hidden pages) | PORT | 3 | todo |
| 7 | 2026-09-18 | aaa7276 | Role presets: additive, department-seeded, one definition (lib/navPresets.js) | PORT | 4 | todo |
| 8 | 2026-09-18 | cf03e2f | Home is the loop: four tiles, one endpoint, gated on the server | PORT | 5 | todo |
| 9 | 2026-09-18 | ea46a67 | Artist budgets can be started by hand | PORT | 9 | todo |
| 10 | 2026-09-18 | 1bc2061 | Hide the import tools and Legal from Settings | PORT | 2 | todo |
| 11 | 2026-09-18 | 55a01d7 | Remove bulk upload, re-upload, QuickBooks import, master sheet, Legal | PORT (ask first) | 2 | todo |
| 12 | 2026-09-18 | 1a6a386 | The artist budget sheet is two totals and the releases under them | PORT (ask first) | 9 | todo |
| 13 | 2026-09-18 | 01fa83e | Every empty page says what fills it (EmptyState), and the Roster can add an artist | PORT | 6 | todo |
| 14 | 2026-09-18 | b7ce29d | Hand the next step over at every transition (NextStepPrompt) | PORT | 6 | todo |
| 15 | 2026-09-18 | 8ae50de | The artist profile is the hub (Budget · Recoupments · Campaigns tabs, breadcrumbs, /artists/resolve) | PORT | 6 | todo |
| 16 | 2026-09-18 | 7efedc8 | The calendar is the team's calendar (one typed feed, legend is the filter) | PORT | 6 | todo |
| 17 | 2026-09-18 | 119819c | Note the signing plan in the fork rules | HOUSEKEEPING | 8 | skip — docs |
| 18 | 2026-09-18 | c684c5c | Signing an artist: terms on the deal, one signing call, a checklist that ticks itself | PORT | 8 | todo |
| 19 | 2026-09-18 | 47e9c1c | Home, second pass: loop → start → next 7 days + recent activity → releases → charts | PORT | 5 | todo |
| 20 | 2026-09-19 | 46d9216 | The vendor form wears Market Street's own look | LABEL | 15 | skip — a look, per tenant |
| 21 | 2026-09-19 | 9847489 | The vendor form, a notch more professional | LABEL | 15 | skip — a look, per tenant |
| 22 | 2026-09-19 | 6fef6ca | Remove test users (mock adapter, demo mode, is_test reads) | PORT (ask first) | 2 | todo |
| 23 | 2026-09-19 | 7545ff6 | Note the settings plan in the fork rules | HOUSEKEEPING | 7 | skip — docs |
| 24 | 2026-09-19 | c42e073 | Settings in two halves, and People as one page | PORT | 7 | todo |
| 25 | 2026-09-19 | 12ccee0 | The label's own details leave the code (label_settings, /label, remittance read) | PORT (config) | 7 | todo — Cadence: per tenant |
| 26 | 2026-09-19 | 0311ba0 | Invite links, an Integrations tab, and a smaller Settings family | PORT | 7 | todo |
| 27 | 2026-09-19 | a0676a3 | Executive is a department, and My Nav lists only what the sidebar draws | PORT | 4 | todo |
| 28 | 2026-09-19 | d3691ef | Settings gets a left rail, Label gets cards and a live preview, Activity loses its noise | PORT | 7 | todo |
| 29 | 2026-09-19 | a803ae1 | Brand: the label's logos and photos, uploaded and downloaded by anyone on the team | PORT | 14 | todo |
| 30 | 2026-09-19 | de385ec | Note the connected-mailboxes plan in the fork rules | HOUSEKEEPING | 11 | skip — docs |
| 31 | 2026-09-19 | 06b7998 | Link the mail plan | HOUSEKEEPING | 11 | skip — docs |
| 32 | 2026-09-19 | fa8a35e | Connected mailboxes: every kind of mail from the address that owns it (lib/mail.js, mailboxes, purposes) | PORT (config) | 11 | todo — Cadence: per tenant OAuth |
| 33 | 2026-09-19 | 247e6de | Click-through tours, and a fixture that fails when they go stale | PORT | 13 | todo |
| 34 | 2026-09-19 | ffbd271 | A Walkthrough button in the header, beside the manual | PORT | 13 | todo |
| 35 | 2026-09-19 | 70629dc | My Work is one list | PORT | 10 | todo |
| 36 | 2026-09-19 | e98a22e | The welcome tour walks every page, and can skip a page or the whole tour | PORT | 13 | todo |
| 37 | 2026-09-19 | a17a349 | The welcome walk runs every page's full tour, with anchors that always render | PORT | 13 | todo |
| 38 | 2026-09-19 | 944962c | Tour engine bug-check: auto-start that could never fire, double Enter, role-gated People, skipped pages | PORT | 13 | todo |
| 39 | 2026-09-19 | dd909b5 | Tours on a phone: bottom-sheet card, the drawer opens for the sidebar step, a replay icon in the header | PORT | 13 | todo |
| 40 | 2026-09-19 | a66d15a | QuickBooks Online push sync, DocuSign signatures, and a daily Spotify + Chartmetric artist stats feed | PORT (config) | 11 | todo — Cadence: per tenant connections |
| 41 | 2026-09-19 | 7e95744 | Every email wears the label's look (lib/email-layout.js); My mailbox recognises the shared address | PORT (config) | 12 | todo |
| 42 | 2026-09-19 | 0d81f0b | Roles: a Label settings page that says what each role can and cannot do (lib/roles.js) | PORT | 4 | todo |
| 43 | 2026-09-19 | d4f7417 | Guide: the Roles page and the Superadmin/Admin split | HOUSEKEEPING | 4 | skip — docs |
| 44 | 2026-09-19 | 5f51517 | BOOM-DIFFERENCES.md: the porting guide | HOUSEKEEPING | — | skip — docs |
| 45 | 2026-09-19 | 4a63472 | anchors-dom: every tour anchor checked on the real pages with an empty label | PORT | 16 | todo |
| 46 | 2026-09-19 | 438a371 | Every page has a tour; the welcome walk covers the whole nav, family by family | PORT | 13 | todo |
| 47 | 2026-09-19 | 1a83da2 | My Work: notes sit beside each task, always visible, saved on blur | PORT | 10 | todo |
| 48 | 2026-09-19 | e5b59ab | The walk runs every step of every page, and a missing anchor shows the step instead of skipping it | PORT | 13 | todo |
| 49 | 2026-09-20 | 42fa9d8 | Flags is the exception register: hourly sweep, new/age/owner, Assign makes a task, Home tile + My Work row | PORT | 17 | todo |
| 50 | 2026-09-20 | 7f4c5ac | Tours: the arrow keys work with a tour button focused | PORT | 13 | todo |
| 51 | 2026-09-20 | 6f07bdb | Walkthrough menu: a pattern-matched tour (artist profile) is offered only on a matching page | PORT | 13 | todo |
| 52 | 2026-09-20 | 8bb4375 | One keyboard vocabulary: g-then-letter navigation, j/k on every list, context-aware ? help, keys in every tour | PORT | 18 | todo |
| 53 | 2026-09-20 | 65b4eab | Reports: selectable basis, comparisons, quarter/year columns, charts, vendor/rep/budget tabs, accountant pack, honest balance sheet | PORT | 19 | todo |
| 54 | 2026-09-20 | c617f55 | Tours: a page tour closes when its page is left; g-chords wait while a tour is up | PORT | 13 | todo |
| 55 | 2026-09-20 | 2835981 | Ledger: filters behind one button with chips, URL state and saved views; date range; Needs attention; summary strip; grouping; drawer; templates | PORT | 20 | todo |
| 56 | 2026-09-20 | a3e0c88 | Vendor form bug pass: Back keeps the answers, Enter never submits early, reimbursements pass the gate, scans write back by key | PORT | 16 | todo |
| 57 | 2026-09-20 | aa41732 | Security pass: session-only tokens, query tokens on file routes only, per-row and role gates, public-form oracles closed | PORT | 21 | todo — highest priority |
| 58 | 2026-09-20 | e81b7a2 | My Work: notes are a small document (NotesEditor), and the whole row opens on click | PORT | 22 | todo |
| 59 | 2026-09-20 | ef7eb02 | Deal pipeline, second pass: owners, timeline, folded Signed/Passed, URL filters, list and funnel views, passed reasons | PORT | 23 | todo |
| 60 | 2026-09-21 | 033f0d7 | Vendor form: the song is a picker over the chosen artist's releases, with an Other escape | PORT | 24 | todo |
| 61 | 2026-09-21 | 9b31db1 | Tours: a walkthrough auto-starts once per person, ever | PORT | 13 | skip — superseded by #67 |
| 62 | 2026-09-21 | a900493 | Tours: every route has a walkthrough — fourteen detail-page tours, root anchors, a fixture that fails when a route lacks one | PORT | 25 | todo |
| 63 | 2026-09-21 | 2f27fce | Walkthrough bug pass 3: page-aware steps (Messages redirect), ? menu navigates, the walk records the tours it ran, keyboard quiet under a tour | PORT | 26 | todo |
| 64 | 2026-09-21 | 110fa8b | Song campaigns: a budget and owner per song, spend from the ledger, a checklist that warns, confirm → Ready for recoupment → Uploaded | PORT | 27 | todo |
| 65 | 2026-09-22 | 02a48ed | Superadmin controls sidebars and department navs: My Nav on the account, another person's sidebar editable, a department's nav is its page list | PORT | 28 | todo |
| 66 | 2026-09-22 | 26731ab | Sign-in: an account that accepted its invite with Google can set its first password | PORT | 29 | todo |
| 67 | 2026-09-22 | 3821758 | Walkthroughs are optional: nothing auto-starts; every tour begins from the Walkthrough button or the ? help | PORT | 30 | done 1860780 |
| 68 | 2026-09-22 | f98fe43 | Cadence port log: the checklist, the tool, the habit | HOUSEKEEPING | — | skip — docs and tooling |
