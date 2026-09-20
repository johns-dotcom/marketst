#!/usr/bin/env node
/**
 * Reports, second pass: the basis, the cuts, budget vs actual, the pack.
 *
 *     cd server && PORT=3011 MAIL_DRY_RUN=1 node index.js &
 *     MAIL_DRY_RUN=1 node scripts/reports-basis-fixture.cjs
 *
 * Seeds tagged rows (a paid invoice, an unpaid approved invoice, an income row,
 * a budget) and asserts DELTAS: the bank basis counts none of them (no
 * statement vouches for them), the ledger basis counts the paid one, accrual
 * counts both; vendor and rep cuts equal the P&L's operating expenses on the
 * same basis; intake counts invoices by invoice month; budget vs actual reads
 * the sheet; the pack is a workbook with the promised sheets; the settings
 * round-trip; the balance sheet says where cash comes from. Deletes its rows
 * at the end, pass or fail.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3011/api/reports';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = '__reports-fixture__';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : `— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const made = { users: [], expenses: [], income: [], budgets: [], artists: [] };
  let settingsBefore = null;
  try {
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash) VALUES ('RepFx', 'repfx@reports-fixture.test', 'Superadmin', 'x') RETURNING id, name, email, role`);
    made.users.push(u.id);
    const T = tokenFor(u);
    const call = async (method, path, body, raw = false) => {
      const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null), headers: r.headers };
    };
    // A range nothing else touches: a month far in the past.
    const FROM = '2019-03-01', TO = '2019-03-31';
    const before = {};
    for (const b of ['bank', 'ledger', 'accrual']) before[b] = (await call('GET', `/pnl?from=${FROM}&to=${TO}&basis=${b}`)).body.data;
    const bva0 = (await call('GET', `/budget-vs-actual?from=${FROM}&to=${TO}&basis=ledger`)).body.data;

    const { rows: [ar] } = await pool.query(`INSERT INTO artists (name) VALUES ($1) RETURNING id, name`, [`${TAG} Artist`]); made.artists.push(ar.id);
    const { artistBucketKey } = require('../lib/artist-key');
    const key = artistBucketKey(ar.name);
    const mk = async (fields) => { const cols = Object.keys(fields); const { rows: [e] } = await pool.query(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map((c) => fields[c])); made.expenses.push(e.id); return e.id; };
    const base = { payee: `${TAG} Vendor`, category: 'Marketing', currency: 'USD', description: TAG, artist: ar.name, status: 'approved', boom_rep: 'FxRep', invoice_date: '2019-03-05' };
    const paid = await mk({ ...base, amount: 300, payment_status: 'Paid', payment_date: '2019-03-10' });
    const unpaid = await mk({ ...base, amount: 200, payment_status: 'Unpaid' });
    await mk({ ...base, amount: 50, payment_status: 'Paid', payment_date: '2019-03-12', category: 'Advance', payee: `${TAG} Artist` }); // below the line: counted in advances, not operating
    const { rows: [inc] } = await pool.query(`INSERT INTO artist_income (artist_name, description, amount, income_type, income_date) VALUES ($1, $2, 1000, 'Royalties', '2019-03-15') RETURNING id`, [ar.name, TAG]); made.income.push(inc.id);
    await pool.query(`INSERT INTO artist_budget_sections (artist_key, section, amount) VALUES ($1, 'marketing', 1000), ($1, 'advance', 100) ON CONFLICT DO NOTHING`, [key]); made.budgets.push(key);

    // ── 1. the basis ──
    const after = {};
    for (const b of ['bank', 'ledger', 'accrual']) after[b] = (await call('GET', `/pnl?from=${FROM}&to=${TO}&basis=${b}`)).body.data;
    const dExp = (b) => Number(after[b].expense_totals.total) - Number(before[b].expense_totals.total);
    const dInc = (b) => Number(after[b].income_totals.total) - Number(before[b].income_totals.total);
    check('bank basis counts NONE of the seeded rows (no statement vouches for them)', near(dExp('bank'), 0) && near(dInc('bank'), 0), { dExp: dExp('bank'), dInc: dInc('bank') });
    check('ledger basis counts the PAID invoice only (300) and the income', near(dExp('ledger'), 300) && near(dInc('ledger'), 1000), { dExp: dExp('ledger'), dInc: dInc('ledger') });
    check('accrual basis counts paid AND unpaid (500) and the income', near(dExp('accrual'), 500) && near(dInc('accrual'), 1000), { dExp: dExp('accrual'), dInc: dInc('accrual') });
    check('the payload names its basis', after.ledger.basis === 'ledger' && after.ledger.basis_label === 'Ledger — paid' && after.bank.basis === 'bank');
    check('the advance sits below the line on the ledger basis, not in operating', near(Number(after.ledger.below.expense_totals.total) - Number(before.ledger.below.expense_totals.total), 50));
    check('no "unverified" band on the ledger bases (those rows ARE the report)', after.ledger.unverified.count === 0 && after.accrual.unverified.count === 0);
    const bad = await call('GET', `/pnl?from=${FROM}&to=${TO}&basis=nonsense`);
    check('an unknown basis falls back to the bank basis rather than erroring', bad.status === 200 && bad.body.data.basis === 'bank');
    const def = await call('GET', '/basis');
    check('GET /basis says which basis to open on and why', def.status === 200 && ['bank', 'ledger'].includes(def.body.data.default) && 'statements' in def.body.data && (def.body.data.reconciled_through ? def.body.data.default === 'bank' : def.body.data.default === 'ledger'), def.body.data);

    // ── 2. the drill agrees ──
    const drill = await call('GET', `/pnl/detail?kind=expense&key=Marketing&from=${FROM}&to=${TO}&basis=accrual`);
    const mine = (drill.body.data.rows || []).filter((r) => [paid, unpaid].includes(r.expense_id));
    check('the drill on the accrual basis lists both rows, with the basis named', mine.length === 2 && drill.body.data.basis === 'accrual', { n: mine.length });
    const drillL = await call('GET', `/pnl/detail?kind=expense&key=Marketing&from=${FROM}&to=${TO}&basis=ledger`);
    check('…and on the ledger basis only the paid one', (drillL.body.data.rows || []).filter((r) => [paid, unpaid].includes(r.expense_id)).length === 1);

    // ── 3. cuts equal the P&L ──
    for (const b of ['ledger', 'accrual']) {
      const v = (await call('GET', `/spend-by?dim=vendor&from=${FROM}&to=${TO}&basis=${b}`)).body.data;
      const r = (await call('GET', `/spend-by?dim=rep&from=${FROM}&to=${TO}&basis=${b}`)).body.data;
      check(`spend by vendor on ${b} sums to the P&L's operating expenses`, near(v.total, after[b].expense_totals.total), { cut: v.total, pnl: after[b].expense_totals.total });
      check(`spend by rep on ${b} sums to the same`, near(r.total, after[b].expense_totals.total) && r.rows.some((x) => x.key === 'FxRep'));
    }
    const vend = (await call('GET', `/spend-by?dim=vendor&from=${FROM}&to=${TO}&basis=accrual`)).body.data.rows.find((x) => x.key === `${TAG} Vendor`);
    check('the vendor row carries its month series, row count and top category', vend && near(vend.total, 500) && vend.count === 2 && near(vend.series['2019-03'], 500) && vend.top_category === 'Marketing', vend);

    // ── 4. intake ──
    const intake = (await call('GET', `/intake?from=${FROM}&to=${TO}`)).body.data;
    const m = intake.series['2019-03'];
    check('intake counts invoices RECEIVED by invoice month, paid and unpaid, with the split', m && m.count >= 3 && m.usd >= 550 && m.paid_usd >= 350 && m.approved_usd >= 200, m);

    // ── 5. budget vs actual ──
    const bva = (await call('GET', `/budget-vs-actual?from=${FROM}&to=${TO}&basis=ledger`)).body.data;
    const row = bva.rows.find((r) => r.key === key);
    check('budget vs actual reads the sheet and the P&L: budget 1000, spent 300 (paid only), left 700, advance 50 of 100', row && near(row.budget_marketing, 1000) && near(row.spent_marketing_range, 300) && near(row.left_marketing, 700) && near(row.budget_advance, 100) && near(row.advance_paid_life, 50) && near(row.left_advance, 50) && row.name === ar.name && row.artist_id === ar.id, row);
    check('budgeted count moved by one', bva.budgeted === (bva0.budgeted || 0) + 1);

    // ── 6. the pack ──
    const pack = await call('GET', `/pack.xlsx?from=${FROM}&to=${TO}&basis=accrual`, null, true);
    check('the pack downloads as a workbook', pack.status === 200 && /spreadsheetml/.test(pack.headers.get('content-type') || ''));
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(pack.body);
    const names = wb.worksheets.map((w) => w.name);
    check('…with the promised sheets', ['Cover', 'P&L', 'Balance sheet', 'Spend by artist', 'Spend by vendor', 'Spend by rep', 'Dismissed'].every((n) => names.includes(n)), names);
    const cover = wb.getWorksheet('Cover'); let coverText = ''; cover.eachRow((r) => { coverText += r.values.map((v) => (v == null ? '' : String(v))).join(' ') + '\n'; });
    check('the cover states the period, the basis and what was excluded', /2019-03-01 to 2019-03-31/.test(coverText) && /Accrual — invoiced/.test(coverText) && /Excluded, disclosed/.test(coverText) && /Bank reconciled through/.test(coverText));
    const vs = wb.getWorksheet('Spend by vendor'); let vendText = ''; vs.eachRow((r) => { vendText += r.values.map((v) => (v == null ? '' : String(v))).join(' ') + '\n'; });
    check('the vendor sheet holds the seeded vendor', vendText.includes(`${TAG} Vendor`));

    // ── 7. pack settings + send (dry run) ──
    settingsBefore = (await call('GET', '/pack/settings')).body.data;
    const put = await call('PUT', '/pack/settings', { enabled: true, day: 7, recipients: 'a@b.co, c@d.co', basis: 'ledger' });
    check('PUT settings round-trips (day clamped 1–28, recipients tidied, basis validated)', put.status === 200 && put.body.data.enabled === true && put.body.data.day === 7 && put.body.data.recipients === 'a@b.co, c@d.co' && put.body.data.basis === 'ledger', put.body);
    const putBad = await call('PUT', '/pack/settings', { enabled: true, recipients: '' });
    check('turning it on with no recipients is refused', putBad.status === 400);
    if (process.env.MAIL_DRY_RUN === '1') {
      // A dry-run send still needs a mailbox owning the Team purpose (lib/mail resolves the sender first).
      const paymentCrypto = require('../lib/payment-crypto');
      const { rows: [mb] } = await pool.query(`INSERT INTO mailboxes (address, display_name, kind, refresh_token_enc, source, status, connected_by) VALUES ($1, 'Fixture AP', 'shared', $2, 'oauth', 'active', $3) RETURNING id`,
        [`${TAG.toLowerCase()}-ap@marketst.test`, paymentCrypto.isConfigured() ? paymentCrypto.encrypt('fake-refresh-token') : null, u.id]);
      made.mailboxes = [mb.id];
      const { rows: prevPurpose } = await pool.query(`SELECT mailbox_id FROM mailbox_purposes WHERE purpose = 'team'`);
      made.prevTeam = prevPurpose[0]?.mailbox_id ?? null;
      await pool.query(`INSERT INTO mailbox_purposes (purpose, mailbox_id) VALUES ('team', $1) ON CONFLICT (purpose) DO UPDATE SET mailbox_id = $1`, [mb.id]);
      const sent = await call('POST', '/pack/send', { from: FROM, to: TO, basis: 'ledger', recipients: 'acct@example.test' });
      check('send now (MAIL_DRY_RUN) reports the recipients and the filename', sent.status === 200 && sent.body.data.sent_to.includes('acct@example.test') && /accountant-pack/.test(sent.body.data.filename), sent.body);
    } else check('send now (needs MAIL_DRY_RUN=1 on the server and here — skipped)', true, 'skipped');

    // ── 8. the balance sheet says where cash comes from ──
    const bs = (await call('GET', `/balance-sheet?as_of=${TO}`)).body.data;
    check('the balance sheet carries a proof note, cash_known, and a source per line', bs.proof && typeof bs.proof.cash_known === 'boolean' && Array.isArray(bs.proof.sources) && bs.proof.sources.some((s) => s.line === 'Accounts payable') && /journal/.test(bs.proof.note));
  } catch (e) {
    console.error('FIXTURE ERROR', e); results.push({ name: 'fixture threw', ok: false });
  } finally {
    if (settingsBefore) await pool.query(`UPDATE report_pack_settings SET enabled = $1, day = $2, recipients = $3, basis = $4 WHERE id = 1`, [!!settingsBefore.enabled, settingsBefore.day || 5, settingsBefore.recipients || '', settingsBefore.basis || 'bank']).catch(() => {});
    if (made.mailboxes) {
      await pool.query(`UPDATE mailbox_purposes SET mailbox_id = $1 WHERE purpose = 'team'`, [made.prevTeam]).catch(() => {});
      await pool.query('DELETE FROM mail_log WHERE mailbox_id = ANY($1)', [made.mailboxes]).catch(() => {});
      await pool.query('DELETE FROM mailboxes WHERE id = ANY($1)', [made.mailboxes]).catch(() => {});
    }
    await pool.query('DELETE FROM artist_budget_sections WHERE artist_key = ANY($1)', [made.budgets]).catch(() => {});
    await pool.query('DELETE FROM artist_income WHERE id = ANY($1)', [made.income]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1)', [made.expenses]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1)', [made.artists]).catch(() => {});
    await pool.query('DELETE FROM activity_log WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM bk_audit_log WHERE user_id = ANY($1)', [made.users]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]).catch(() => {});
    await pool.end();
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
  }
})();
