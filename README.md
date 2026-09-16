# Market Street Dashboard

The internal admin system for **Market Street**, an independent record label.
One web app, used by the label's staff, that runs the parts of the business
that otherwise live in spreadsheets and inboxes: what the label is releasing,
who it owes money to, what it has spent on each artist, and what it can recoup.

Forked on 2026-09-15 from the Boom Records dashboard (`boom-dashboard`), with
the same architecture and feature set. Not yet deployed — see "Status" below.

---

## What it is for

A label spends money on an artist long before that artist earns any — advances,
recording, marketing, PR, distribution — and most of that spend is *recoupable*,
meaning it comes back out of the artist's future earnings. Getting that wrong in
either direction is expensive: claim too much and you owe an artist money you
already took; claim too little and the label eats costs it was entitled to
recover.

Everything here serves that one problem. The app exists to make each of these
answerable from a screen rather than from somebody's memory:

| Question | Where it is answered |
|---|---|
| What are we releasing, and is it on track? | Release Tracker, Calendar |
| Who have we agreed to pay, and by when? | Payments, Approvals, Invoices |
| Did that payment actually leave the bank? | Bank Matching, Statements |
| What have we spent on this artist? | Artist Budgets, Artist Campaigns |
| What can we recoup, and can we prove it? | Recoupments |
| What does the P&L say, and does it tie out? | Reports, Financials |
| Who do we pay, and do we hold their W-9? | Vendors, 1099 |

### The ideas the app is built around

**Spent is not committed.** An unpaid invoice sitting in a drawer is not an
expenditure. Spend, open invoices and committed totals are reported separately
everywhere.

**The bank is the evidence.** A payment marked paid is a claim; a matching line
on a bank statement is proof. Every money surface distinguishes *confirmed on a
statement*, *paid but no statement uploaded yet*, *paid with no matching line*
(a real discrepancy), and *unpaid*.

**Vendors submit their own invoices.** `/submit` is a public form vendors reach
from an email — it collects the invoice, the W-9 and the bank details needed to
actually pay them, validates the documents with AI, and lands the result on an
approvals queue rather than in somebody's inbox.

**A number you cannot open is a number nobody trusts.** Totals drill down to the
rows behind them, and where two surfaces could disagree they are made to read
from one definition instead of two.

---

## Layout

```
boom-dashboard/        the application — everything that deploys
  client/              React 18 + Vite front end
  server/              Express + PostgreSQL API
  CLAUDE.md            the authoritative engineering guide — read this first
tools/                 one-off operator scripts (Gmail OAuth refresh token)
CLAUDE.md              pointer to the guide above
```

The app folder is still named `boom-dashboard/` on purpose: it keeps every file
path identical to the Boom repo, so a fix made in one can be ported to the other
by path. Renaming it is a deploy-config change (Railway's service root
directory) and touches every path in the engineering guide — do it deliberately
or not at all.

**`boom-dashboard/CLAUDE.md` is the real documentation** — architecture, the API
routes, the bookkeeping subsystem, the schema-migration rules, and a long list of
gotchas that were each learned from a production incident at Boom. They apply
here unchanged; the guide's history and examples refer to Boom.

## Status (2026-09-15)

- **Code:** full fork, visibly rebranded. Internal identifiers (`boom_rep`,
  `BOOM_REPS`, `boom-*` Tailwind classes, `boom_invoices` and other table names)
  are kept so patches port cleanly.
- **Data:** none. The seed creates one Superadmin account (`john@deanst.co`) and
  nothing else — no artists, releases, deals, payroll or reps beyond that user.
- **Placeholders to fill before the first real document goes out** — grep for
  `TODO(marketst)`:
  - invoice remittance block (company address, EIN, bank details) in
    `client/src/pages/CreateInvoice.jsx` and the sidebar "Billing" copy button
  - NDA owner address in `client/src/pages/nda-templates/shared.js`
  - approval-summary recipients (currently every option routes to the seeded
    account) in `server/routes/bookkeeping.js` and `client/src/pages/BkPayments.jsx`
  - the accent colour: a neutral slate placeholder in `client/tailwind.config.js`
    (`boom` palette), `client/src/styles/tokens.css`, and the favicon
  - the production URL: `marketst-production.up.railway.app` stands in wherever
    `boom-ap.com` used to be, until a domain exists
- **Infra:** dev database is Neon project `marketst-dashboard-dev`. No Railway
  service, R2 bucket, Gmail sender or Anthropic key yet — the features that need
  them (document parsing, email, file storage) are dormant until those env vars
  are set.

## Running it

```bash
cd boom-dashboard
npm install          # installs root + server + client
npm run dev:server   # Express on :3001
npm run dev:client   # Vite on :5173
```

`server/.env` holds `DATABASE_URL` (the Neon dev database, not production),
`JWT_SECRET`, `PW_JOHN` and `PAYMENT_DETAILS_KEY`. Log in with
`john@deanst.co` and the `PW_JOHN` value.

There is **no test runner, linter or formatter** — deliberately. Changes are
verified by fixtures that exercise real endpoints against the dev database, and
by DOM harnesses that mount a page and drive it:

```bash
cd server && PORT=3011 node index.js &
node scripts/<name>-fixture.cjs        # server behaviour, real HTTP + SQL
cd client && npm run smoke             # does the page's component body run?
cd client && npm run <name>-dom        # does the page actually work?
```

A green `vite build` is not evidence a page renders.

## Stack

React 18 · Vite 5 · Tailwind 3 · Express 4 · PostgreSQL (raw SQL, no ORM) · JWT
auth · Anthropic Claude for document parsing · Cloudflare R2 for file storage ·
Railway for hosting. No TypeScript.
