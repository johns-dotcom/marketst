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
  permission walk). `client/scripts/nav-fixture.mjs` encodes this layout; the
  page-access fixture must stay byte-identical across any nav change. Boom
  reverted a similar regroup in Aug 2026 — do not port this back without asking.
  Plan: https://claude.ai/code/artifact/3e97eb42-7e5d-41c3-b7c4-b20b8f424e28
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
