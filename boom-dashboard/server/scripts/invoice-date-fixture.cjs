/**
 * The date an invoice bears is editable, and the deadline follows it.
 *
 * John, 2026-09-15: "I want to be able to edit the start date of an invoice."
 * It was DERIVED from `created_at` — right for a document raised today, and
 * impossible to correct afterwards.
 *
 * ── What this exists to stop ──
 *
 *   THE TWO DATES STAY ONE DAY   sections 2 and 3. `lib/payment-terms.js`
 *                                exists because a Net 45 invoice once printed a
 *                                date 46 days before its own due date. Making
 *                                the date editable is the most direct way to
 *                                reintroduce that: move the date, leave the
 *                                deadline, and the document disagrees with
 *                                itself.
 *
 *   A SUPPLIED DATE IS STORED    section 2. `POST` already accepted
 *                                `invoice_date` and counted the deadline from
 *                                it — and then stored `created_at` and PRINTED
 *                                businessDay(created_at). So an invoice created
 *                                dated last week printed today and was due from
 *                                last week. Latent: the form never sent one.
 *                                Section 2 fails against the pre-change server.
 *
 *   OLD ROWS DO NOT MOVE         section 1. The column is NULLABLE and null
 *                                means "derive from created_at", so the
 *                                invoices already in the table print exactly
 *                                what they printed before. Asserted against a
 *                                row with a NULL date and a back-dated
 *                                `created_at`, because with created_at = today
 *                                the two answers coincide and the test proves
 *                                nothing — the same trap `dayOf` documents.
 *
 *   CUSTOM IS NOT RE-COUNTED     section 4. A custom deadline was never derived
 *                                from the issue date, so moving the date must
 *                                leave it alone.
 *
 *   AN EDIT IS NOT A RE-DATE     section 5. Fixing a typo in the description
 *                                must not move either date.
 *
 * ── Running ──
 *   cd server
 *   PORT=3011 node index.js &
 *   node scripts/invoice-date-fixture.cjs
 */
require('dotenv').config();
const { Pool } = require('pg');
const { businessDay, addDays } = require('../lib/payment-terms');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'INVDATE-' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const eq = (label, actual, expected) =>
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

let token = null;
const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
const J = async (method, url, body) => {
  const r = await fetch(BASE + '/api' + url, {
    method, headers: H(), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { code: r.status, j: await r.json().catch(() => null) };
};

const made = [];
const create = async (over = {}) => {
  const r = await J('POST', '/invoices', {
    bill_to: TAG, description: 'Fixture line', amount: 100,
    line_items: [{ description: 'Fixture line', amount: 100 }],
    payment_terms: 'Net 30', ...over,
  });
  if (r.j?.data?.id) made.push(r.j.data.id);
  return r;
};

(async () => {
  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database');

    // runMigrations() runs in the BACKGROUND after app.listen, so a fixture that
    // starts too soon races it — and the failure reads like a missing migration
    // ("column invoice_date does not exist") when it is a missing wait. Same
    // poll vendor-required-fixture.cjs carries, for the same reason.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'boom_invoices' AND column_name = 'invoice_date') AS c`);
      ready = rows[0].c;
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    ok(ready, 'schema is migrated (boom_invoices.invoice_date)');

    const today = businessDay(new Date());

    // ══ 1. nothing said, nothing changed ══════════════════════════════════════
    console.log('\n1. an invoice with no date given is dated today');
    const plain = await create();
    ok(plain.code === 200, `created (${plain.code}) ${plain.code !== 200 ? JSON.stringify(plain.j?.error) : ''}`);
    eq('it bears today', plain.j?.data?.invoice_date, today);
    eq('and is due 30 days from today', plain.j?.data?.due_date?.slice(0, 10), addDays(today, 30));
    // The pre-existing rows: NULL invoice_date, and a created_at that is NOT
    // today, so "derived from created_at" and "today" are different answers.
    await pool.query(
      `UPDATE boom_invoices SET invoice_date = NULL, created_at = NOW() - INTERVAL '40 days' WHERE id = $1`,
      [plain.j.data.id]);
    const legacy = (await J('GET', '/invoices')).j?.data?.find(x => x.id === plain.j.data.id);
    const derived = businessDay(new Date(Date.now() - 40 * 86400000));
    eq('a row with no stored date still derives it from created_at',
      legacy?.invoice_date, derived);
    ok(legacy?.invoice_date !== today, 'which is NOT today — so the fallback is really being exercised');

    // ══ 2. a date given at creation is STORED, not just counted from ══════════
    console.log('\n2. a date given at creation is the date it bears');
    const back = addDays(today, -10);
    const dated = await create({ invoice_date: back });
    ok(dated.code === 200, `created (${dated.code})`);
    eq('the document bears the date asked for', dated.j?.data?.invoice_date, back);
    eq('and the deadline counts from THAT day', dated.j?.data?.due_date?.slice(0, 10), addDays(back, 30));
    // The bug this replaces: the due date honoured the request and the printed
    // date did not, so the document disagreed with itself.
    ok(dated.j?.data?.invoice_date !== today,
      'the printed date is NOT quietly today while the deadline counts from elsewhere');
    const { rows: stored } = await pool.query(
      'SELECT invoice_date::text AS d, created_at FROM boom_invoices WHERE id = $1', [dated.j.data.id]);
    eq('it is stored in its own column', stored[0].d, back);
    ok(businessDay(stored[0].created_at) === today,
      'while created_at still records WHEN THE ROW WAS MADE, which is today');

    // ══ 3. moving the date moves the deadline ════════════════════════════════
    console.log('\n3. moving the date moves the deadline with it');
    const moved = addDays(today, -3);
    const put = await J('PUT', `/invoices/${dated.j.data.id}`, { invoice_date: moved });
    ok(put.code === 200, `the edit is accepted (${put.code}) ${put.code !== 200 ? JSON.stringify(put.j?.error) : ''}`);
    eq('the document bears the new date', put.j?.data?.invoice_date, moved);
    eq('and Net 30 is counted from it', put.j?.data?.due_date?.slice(0, 10), addDays(moved, 30));
    ok(/\w/.test(String(put.j?.data?.due_by || '')), `the printed deadline line is rewritten too (${put.j?.data?.due_by})`);
    const reread = (await J('GET', '/invoices')).j?.data?.find(x => x.id === dated.j.data.id);
    eq('and it survives a re-read', reread?.invoice_date, moved);
    ok(typeof reread?.invoice_date === 'string',
      'as a STRING, not a Date — the ::text cast is what stops a DATE being reparsed a day out');

    // ══ 4. a custom deadline is not re-counted ═══════════════════════════════
    console.log('\n4. a custom deadline stays where it was put');
    const fixed = addDays(today, 90);
    const custom = await create({ payment_terms: 'Custom', due_date: fixed });
    ok(custom.code === 200, `created with a custom deadline (${custom.code}) `
      + `${custom.code !== 200 ? JSON.stringify(custom.j?.error) : ''}`);
    eq('the deadline is the day chosen', custom.j?.data?.due_date?.slice(0, 10), fixed);
    const cmoved = await J('PUT', `/invoices/${custom.j.data.id}`, { invoice_date: addDays(today, -5) });
    ok(cmoved.code === 200, `its date can still be moved (${cmoved.code})`);
    eq('the date moved', cmoved.j?.data?.invoice_date, addDays(today, -5));
    eq('and the custom deadline did NOT', cmoved.j?.data?.due_date?.slice(0, 10), fixed);

    // ══ 5. an unrelated edit moves neither date ══════════════════════════════
    console.log('\n5. fixing a typo moves nothing');
    const before = (await J('GET', '/invoices')).j.data.find(x => x.id === dated.j.data.id);
    const typo = await J('PUT', `/invoices/${dated.j.data.id}`, { description: 'Fixture line, corrected' });
    ok(typo.code === 200, `the edit is accepted (${typo.code})`);
    eq('the date is untouched', typo.j?.data?.invoice_date, before.invoice_date);
    eq('and so is the deadline', typo.j?.data?.due_date?.slice(0, 10), before.due_date?.slice(0, 10));

    // ══ 6. the preview asks the same question the save answers ═══════════════
    console.log('\n6. the preview and the save agree');
    const ask = await J('GET', `/invoices/due-date?terms=Net%2045&date=${back}`);
    eq('the preview anchors on the date being typed', ask.j?.data?.invoice_date, back);
    eq('and reports the deadline that would be stored', ask.j?.data?.due_date, addDays(back, 45));
    const saved = await create({ invoice_date: back, payment_terms: 'Net 45' });
    eq('which is exactly what saving produces', saved.j?.data?.due_date?.slice(0, 10), ask.j?.data?.due_date);

    // ══ 7. a date that is not a date is refused ══════════════════════════════
    console.log('\n7. an unreadable date is refused, not guessed at');
    const junk = await J('PUT', `/invoices/${dated.j.data.id}`, { invoice_date: 'last tuesday' });
    ok(junk.code === 400, `refused (${junk.code})`);
    ok(/YYYY-MM-DD/.test(String(junk.j?.error || '')), `saying what shape it wants (${junk.j?.error})`);
    const after = (await J('GET', '/invoices')).j.data.find(x => x.id === dated.j.data.id);
    eq('and nothing moved', after?.invoice_date, before.invoice_date);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\nFIXTURE ERROR:', err.message);
    fail++;
  } finally {
    if (made.length) {
      await pool.query('DELETE FROM boom_invoices WHERE id = ANY($1::int[])', [made]).catch(() => {});
    }
    await pool.query('DELETE FROM boom_invoices WHERE bill_to = $1', [TAG]).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
