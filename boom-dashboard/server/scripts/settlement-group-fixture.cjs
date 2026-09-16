/**
 * Two invoices, one payment.
 *
 * John: "when 2 invoices are sent in one payment, how can I make note of this
 * when uploading their invoices so it's an easy match when statements are
 * uploaded?"
 *
 * ── THE HOLE, PROVED FIRST ──
 * Test 1 builds exactly that: two invoices for one vendor whose totals sum to a
 * single bank debit to the cent, runs the matcher, and asserts NEITHER matches.
 * That is not a bug in the tiers — every one of them is 1:1 on an amount equal
 * to the cent, so each invoice is smaller than the payment and none can take it.
 * The assertion stays true forever: an UNMARKED pair must never auto-match,
 * because guessing which invoices add up to a payment marks the wrong invoice
 * NUMBERS settled and nothing downstream contradicts it.
 *
 * ── What the marker changes ──
 * A group somebody declared (expenses.settlement_group, written by
 * /api/bk/settlement-groups) is summed by the matcher and settled through the
 * SAME function /tx/:txId/attach uses — which is the load-bearing decision here.
 * Writing matched_expense_id straight from the matcher would bypass four guards
 * AND skip soft-deleting the entry the app invented for that bank line, leaving
 * the payment counted twice: once as an invented expense, once as the invoices.
 *
 * ── Where each guard actually bites ──
 * Named per test rather than assumed, because the layer matters. An
 * undocumented-added row and a bank-born entry never reach the settle at all —
 * the matcher's candidate query excludes them — so the group is refused by never
 * becoming settleable. A split child is refused at MARKING time by
 * validateGroup. The overpay guard is what the claims map enforces per member.
 * Asserting "the wrong thing did not happen" is the same assertion either way;
 * saying which layer said no is what makes the test readable in a year.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');

const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'SG' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
// pg hands back a JS Date for DATE columns, and String(aDate) is
// "Thu Aug 27 2026 …" — slicing that gives "Thu Aug 2".
const day = (d) => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};
const plus = (iso, n) => {
  const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n);
  return day(x);
};
const money = (n) => '$' + Number(n).toFixed(2);

(async () => {
  const made = { exp: [], stmt: [], txn: [] };
  let token = null;
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
  const j = async (path, opts) => {
    const r = await fetch(BASE + '/api' + path, { headers: H(), ...opts });
    let body = null; try { body = await r.json() } catch {}
    return { code: r.status, body };
  };

  // ── World building ─────────────────────────────────────────────────────────
  const stmt = async (s, e) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`, [`${TAG}.pdf`, s, e]);
    made.stmt.push(r.id); return r.id;
  };
  // vendor_submitted = true so UNDOCUMENTED_ADDED_SQL does not exclude it: a
  // hand-added row with no document is refused from matching everywhere, and a
  // fixture that forgot this would "prove" the tier broken.
  const inv = async (payee, amount, invDate, over = {}) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         payment_status, payment_method, vendor_submitted, entry_source, invoice_number, invoice_filename)
       VALUES ($1,$2,'USD','Services',$3,'approved','Unpaid','Wire',$4,$5,$6,$7) RETURNING id`,
      [payee, amount, invDate,
        over.vendor_submitted === undefined ? true : over.vendor_submitted,
        over.entry_source || null,
        over.invoice_number || `${TAG}-${Math.floor(Math.random() * 100000)}`,
        over.invoice_filename === undefined ? `${TAG}.pdf` : over.invoice_filename]);
    made.exp.push(r.id); return r.id;
  };
  const child = async (parentId, payee, amount, invDate) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         payment_status, payment_method, vendor_submitted, parent_id)
       VALUES ($1,$2,'USD','Services',$3,'approved','Unpaid','Wire',true,$4) RETURNING id`,
      [payee, amount, invDate, parentId]);
    made.exp.push(r.id); return r.id;
  };
  const txnOf = async (stId, payee, amount, date, over = {}) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, amount,
         direction, currency, dismissed)
       VALUES ($1,$2,$3,$4,$5,'debit','USD',false) RETURNING id`,
      [stId, date, over.description || `WIRE TYPE:WIRE OUT ${payee}`, payee, amount]);
    made.txn.push(r.id); return r.id;
  };
  const tx = async (id) => (await pool.query(
    `SELECT matched_expense_id, match_method, match_score, dismissed FROM bank_transactions WHERE id = $1`,
    [id])).rows[0];
  const links = async (id) => (await pool.query(
    `SELECT expense_id FROM bank_txn_invoice_links WHERE txn_id = $1 ORDER BY expense_id`, [id])).rows
    .map((r) => r.expense_id);
  const groupOf = async (id) => (await pool.query(
    `SELECT settlement_group FROM expenses WHERE id = $1`, [id])).rows[0]?.settlement_group;
  // Every live dollar in the ledger. Grouping RE-LABELS how money reconciles; it
  // must never create or destroy any.
  const ledgerTotal = async () => Number((await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM expenses
      WHERE (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)`)).rows[0].t);

  let SID = null;
  const runMatcher = async () => {
    const r = await j(`/statements/rematch-all?statement_id=${SID}`, { method: 'POST' });
    if (r.code === 409) {                       // a pass already holds the lock
      await new Promise((s) => setTimeout(s, 4000));
      return runMatcher();
    }
    return r;
  };

  try {
    const L = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }),
    });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }
    console.log('logged in against the DEV database\n');

    // A period past everything already in dev, so no leftover fixture row can
    // land inside it and change what "this statement" contains.
    const { rows: [cov] } = await pool.query(
      `SELECT MAX(period_end) AS e FROM bank_statements WHERE status = 'ready'`);
    const P0 = plus(day(cov.e || new Date('2026-01-01T00:00:00Z')), 40);
    const P1 = plus(P0, 29);
    const PAID = plus(P0, 10);          // the day the money moves
    const INVD = plus(P0, 2);           // invoices dated before it
    SID = await stmt(P0, P1);
    console.log(`        statement ${P0} → ${P1}, payment day ${PAID}\n`);

    // Amounts carry cents derived from the pid, so no unrelated row in dev can
    // accidentally equal one of them and turn a clean tier into "ambiguous".
    const C = (process.pid % 90) + 5;
    const A_AMT = 3000 + C / 100;                 // e.g. 3000.47
    const B_AMT = 4000 + (99 - C) / 100;
    const TOTAL = Math.round((A_AMT + B_AMT) * 100) / 100;

    const V = `Groupco ${TAG}`;
    const t0 = await ledgerTotal();

    // ── 1. THE HOLE ────────────────────────────────────────────────────────
    console.log('1. two invoices summing to one payment, UNMARKED — neither matches');
    const A = await inv(V, A_AMT, INVD);
    const B = await inv(V, B_AMT, INVD);
    const T1 = await txnOf(SID, V, TOTAL, PAID);
    console.log(`        ${money(A_AMT)} + ${money(B_AMT)} = ${money(TOTAL)}, one debit of ${money(TOTAL)}`);
    const m1 = await runMatcher();
    ok(m1.code === 200, `matcher ran (${m1.code})`);
    const s1 = await tx(T1);
    ok(!s1.matched_expense_id, `the payment is STILL unmatched — the hole (${s1.matched_expense_id || 'null'})`);
    ok((await links(T1)).length === 0, 'and nothing was linked');

    // ── 2. marked, and it settles ──────────────────────────────────────────
    console.log('\n2. marked as one payment — the matcher settles the whole group');
    const g = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [A, B] }) });
    ok(g.code === 200, `group created (${g.code}) ${g.body?.data?.group || g.body?.error || ''}`);
    const KEY = g.body?.data?.group;
    ok(await groupOf(A) === KEY && await groupOf(B) === KEY, 'both invoices carry the marker');
    const m2 = await runMatcher();
    ok(m2.code === 200, `matcher ran again (${m2.code})`);
    const s2 = await tx(T1);
    ok(s2.matched_expense_id === Math.min(A, B), `settled, primary is the first invoice (#${s2.matched_expense_id})`);
    ok(s2.match_method === 'group', `match_method is 'group' (${s2.match_method})`);
    ok(Number(s2.match_score) === 100, `score 100 — the same a person's attach writes (${s2.match_score})`);
    const l2 = await links(T1);
    ok(l2.length === 2 && l2.includes(A) && l2.includes(B),
      `BOTH invoices are linked, not just the primary (${l2.join(', ')})`);
    // Tolerance, not equality: these are floats, and 3000.40 + 4000.59 is not
    // exactly 7000.99 in binary. Round once, at the comparison.
    ok(Math.abs(await ledgerTotal() - (t0 + A_AMT + B_AMT)) < 0.005,
      'the ledger holds exactly the two invoices it gained — settling created and destroyed no money');

    // ── 3. claims are credited per MEMBER ──────────────────────────────────
    console.log('\n3. a second payment cannot re-settle invoices the group already covered');
    const T2 = await txnOf(SID, V, TOTAL, plus(PAID, 1));
    const m3 = await runMatcher();
    ok(m3.code === 200, `matcher ran (${m3.code})`);
    ok(!(await tx(T2)).matched_expense_id,
      'the duplicate-sized payment is unmatched — every member was credited, not just the primary');
    ok((await tx(T1)).matched_expense_id === Math.min(A, B), 'and the first settle is untouched');

    // ── 4. one cent out is not a match ─────────────────────────────────────
    console.log('\n4. a group one cent short of the payment does not match');
    const V4 = `Centco ${TAG}`;
    const E = await inv(V4, 1000.00, INVD);
    const F = await inv(V4, 2000.00, INVD);
    const g4 = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [E, F] }) });
    ok(g4.code === 200, `group created (${g4.code})`);
    const T4 = await txnOf(SID, V4, 3000.01, PAID);
    await runMatcher();
    ok(!(await tx(T4)).matched_expense_id, 'off by $0.01 — refused');

    // ── 5. the name veto ──────────────────────────────────────────────────
    console.log('\n5. a group whose vendor disagrees with the bank line does not match');
    const V5 = `Nameco ${TAG}`;
    const G1 = await inv(V5, 1500.00, INVD);
    const G2 = await inv(V5, 2500.00, INVD);
    const g5 = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [G1, G2] }) });
    ok(g5.code === 200, `group created (${g5.code})`);
    const T5 = await txnOf(SID, `Zeta Unrelated ${TAG}`, 4000.00, PAID);
    await runMatcher();
    ok(!(await tx(T5)).matched_expense_id,
      'exact to the cent and still refused — an amount is not an identity');

    // ── 6. two groups, same total: refuse and say so ───────────────────────
    console.log('\n6. two groups both totalling the payment — the matcher refuses to guess');
    const V6 = `Ambico ${TAG}`;
    const H1 = await inv(V6, 900.00, INVD);
    const H2 = await inv(V6, 1100.00, INVD);
    const H3 = await inv(V6, 800.00, INVD);
    const H4 = await inv(V6, 1200.00, INVD);
    const ga = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [H1, H2] }) });
    const gb = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [H3, H4] }) });
    ok(ga.code === 200 && gb.code === 200 && ga.body.data.group !== gb.body.data.group,
      'two separate groups, both $2,000.00');
    const T6 = await txnOf(SID, V6, 2000.00, PAID);
    await runMatcher();
    ok(!(await tx(T6)).matched_expense_id, 'the payment is left for a person');
    // /rematch-all returns counts; the REASONS live on /:id/why, which re-runs
    // the same matcher in dry-run. That is the surface a person reads, so the
    // reason is asserted where they would see it.
    const w6 = await j(`/statements/${SID}/why`);
    const why6 = (w6.body?.data?.rows || []).find((d) => d.txn_id === T6);
    ok(why6?.reason === 'ambiguous-group',
      `and the reason SAYS why: ${why6?.reason || '(nothing reported)'} ${why6?.groups?.join(' / ') || ''}`);

    // ── 7. what may not be a group ────────────────────────────────────────
    console.log('\n7. marking refuses what could not physically be one payment');
    const one = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [A] }) });
    ok(one.code === 400, `a group of one (${one.code}) ${String(one.body?.error || '').slice(0, 45)}`);
    const two = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [E, G1] }) });
    ok(two.code === 400 && /different vendors/i.test(two.body?.error || ''),
      `two vendors (${two.code}) ${String(two.body?.error || '').slice(0, 45)}`);
    const par = await inv(`Splitco ${TAG}`, 500, INVD);
    const kid = await child(par, `Splitco ${TAG}`, 250, INVD);
    const spl = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [kid, E] }) });
    ok(spl.code === 400 && /split/i.test(spl.body?.error || ''),
      `a split child (${spl.code}) ${String(spl.body?.error || '').slice(0, 60)}`);
    const born = await inv(`Bankco ${TAG}`, 700, INVD, { entry_source: 'bank_statement' });
    const bank = await j('/bk/settlement-groups', { method: 'POST',
      body: JSON.stringify({ expense_ids: [born, await inv(`Bankco ${TAG}`, 300, INVD)] }) });
    ok(bank.code === 400 && /bank line/i.test(bank.body?.error || ''),
      `an entry the app invented (${bank.code}) ${String(bank.body?.error || '').slice(0, 55)}`);
    const alr = await j('/bk/settlement-groups', { method: 'POST',
      body: JSON.stringify({ expense_ids: [A, await inv(V, 10, INVD)] }) });
    ok(alr.code === 400 && /already matched/i.test(alr.body?.error || ''),
      `an invoice already settled by a bank line (${alr.code}) ${String(alr.body?.error || '').slice(0, 50)}`);

    // ── 8. a member with no document keeps the group unsettleable ─────────
    console.log('\n8. a group carrying an undocumented hand-added row never settles');
    const V8 = `Nodocco ${TAG}`;
    const D1 = await inv(V8, 600.00, INVD);
    const D2 = await inv(V8, 400.00, INVD, { vendor_submitted: false, invoice_filename: null });
    const g8 = await j('/bk/settlement-groups', { method: 'POST', body: JSON.stringify({ expense_ids: [D1, D2] }) });
    ok(g8.code === 200, `the group can be marked (${g8.code}) — the refusal is the matcher's, not the marker's`);
    const T8 = await txnOf(SID, V8, 1000.00, PAID);
    await runMatcher();
    ok(!(await tx(T8)).matched_expense_id,
      'unsettled: the undocumented member is not a matcher candidate at all, so the group can never be complete');

    // ── 9. ungrouping is a label change, never an unmatch ─────────────────
    console.log('\n9. ungrouping clears the marker and leaves the settle standing');
    const d9 = await j(`/bk/settlement-groups/${KEY}`, { method: 'DELETE' });
    ok(d9.code === 200, `ungrouped (${d9.code})`);
    ok(!(await groupOf(A)) && !(await groupOf(B)), 'the marker is gone from both invoices');
    const s9 = await tx(T1);
    ok(s9.matched_expense_id === Math.min(A, B) && s9.match_method === 'group',
      'and the payment is still settled — tidying a label must not unreconcile money');
    ok((await links(T1)).length === 2, 'both link rows survive');

    // ── 10. the disposition ───────────────────────────────────────────────
    console.log("\n10. 'group' is a MATCHED disposition, not a booking");
    const lens = await import('../../client/src/lib/statementLens.js');
    const disp = lens.dispositionOf({ match_method: 'group', matched_expense_id: 7 });
    ok(disp === 'matched', `dispositionOf('group') = '${disp}' — invoice-backed, the funding-sweep mistake checked`);
    ok(lens.dispositionOf({ match_method: 'created', matched_expense_id: 7 }) === 'booked'
      && lens.dispositionOf({ match_method: 'creator', matched_expense_id: 7 }) === 'creator',
      'and the two dispositions that must NOT be matched still are not');
    const comp = await j(`/statements/completion?statement_id=${SID}`);
    const backed = comp.body?.data?.invoice_backed_pct;
    ok(comp.code === 200 && Number(backed) > 0,
      `/completion counts it as invoice-backed (${backed}% of the statement's debits)`);

    // ── 12. an UNMARKED pair is PROPOSED, never applied ──────────────────
    console.log('\n12. the invoices nobody marked are offered, not taken');
    const V12 = `Offerco ${TAG}`;
    const O1 = await inv(V12, 1234.00, INVD);
    const O2 = await inv(V12, 2766.00, INVD);
    const T12 = await txnOf(SID, V12, 4000.00, PAID);
    await runMatcher();
    ok(!(await tx(T12)).matched_expense_id, 'still unmatched — a guess is never written');
    const det = await j(`/statements/${SID}`);
    const rows12 = det.body?.data?.transactions || det.body?.data?.txns || [];
    const r12 = rows12.find((x) => x.id === T12);
    ok(!!r12, `the row is in the statement payload (${rows12.length} rows)`);
    const gp = r12?.group_proposal;
    ok(!!gp, `a group proposal is attached${gp ? ` (${gp.combinations} combination(s))` : ''}`);
    ok(gp && !gp.ambiguous && (gp.expense_ids || []).length === 2
      && gp.expense_ids.includes(O1) && gp.expense_ids.includes(O2),
      `it names both invoices (${(gp?.expense_ids || []).join(', ')})`);
    ok(gp && gp.considered >= 2 && typeof gp.capped === 'boolean',
      `and it states its own bound: searched ${gp?.considered} of ${gp?.available}, capped=${gp?.capped}`);

    // ── 13. the OFFER is accepted through /attach — the same settle ───────
    console.log('\n13. accepting the offer settles it through /attach');
    const sent = gp?.expense_ids || [O1, O2];
    const at = await j(`/statements/tx/${T12}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: sent }) });
    ok(at.code === 200, `attached (${at.code}) ${at.body?.error || ''}`);
    const s13 = await tx(T12);
    // The primary is the CALLER's first id — /attach has always treated
    // expense_ids[0] that way, and the proposal orders by amount descending.
    ok(s13.matched_expense_id === sent[0],
      `primary is the first id sent (#${s13.matched_expense_id} of ${sent.join(', ')})`);
    ok(s13.match_method === 'manual', `method 'manual' — a person's act, not the matcher's (${s13.match_method})`);
    ok((await links(T12)).length === 2, 'both invoices linked');

    // ── 14. /attach on a BOOKED row still displaces the invented entry ────
    //
    // The branch the matcher can never reach (runAutoMatch skips booked rows),
    // and the one that makes any of this correct: leave the invented entry alive
    // and the payment is counted twice. Re-asserted because the settle was
    // extracted into a shared function this session.
    console.log('\n14. a BOOKED row: the invented entry is displaced, not left behind');
    const V14 = `Bookedco ${TAG}`;
    const K1 = await inv(V14, 1111.00, INVD);
    const K2 = await inv(V14, 2222.00, INVD);
    const T14 = await txnOf(SID, V14, 3333.00, PAID);
    const INVENT = await inv(V14, 3333.00, PAID, { entry_source: 'bank_statement', vendor_submitted: false, invoice_filename: null });
    await pool.query(
      `UPDATE bank_transactions SET matched_expense_id = $1, match_method = 'created' WHERE id = $2`,
      [INVENT, T14]);
    const before14 = await ledgerTotal();
    const at14 = await j(`/statements/tx/${T14}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [K1, K2] }) });
    ok(at14.code === 200, `attached over the booking (${at14.code}) ${at14.body?.error || ''}`);
    ok(at14.body?.data?.unbooked_entry_id === INVENT,
      `it reports which entry it removed (#${at14.body?.data?.unbooked_entry_id})`);
    const gone14 = (await pool.query(`SELECT deleted FROM expenses WHERE id = $1`, [INVENT])).rows[0];
    ok(gone14?.deleted === true, 'the invented entry is soft-deleted — the double count is gone');
    ok(Math.abs((await ledgerTotal()) - (before14 - 3333.00)) < 0.005,
      'and the ledger fell by exactly the invented amount, nothing else');
    ok((await tx(T14)).match_method === 'rematch', "the row reads 'rematch', which is what /unattach reverses");
    ok((await links(T14)).length === 2, 'both real invoices linked');

    // ── 15. the guards still bite through the shared settle ──────────────
    console.log('\n15. /attach refusals survived the extraction');
    const T15 = await txnOf(SID, V14, 3333.00, PAID);
    const over = await j(`/statements/tx/${T15}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [K1, K2] }) });
    ok(over.code === 409 && /overpay/i.test(over.body?.error || ''),
      `overpaying an invoice already covered (${over.code}) ${String(over.body?.error || '').slice(0, 50)}`);
    const LATE = await inv(V14, 500.00, plus(PAID, 30));
    const T15b = await txnOf(SID, V14, 500.00, PAID);
    const pre = await j(`/statements/tx/${T15b}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [LATE] }) });
    ok(pre.code === 400 && pre.body?.prepayment_possible === true,
      `a debit that left before the invoice existed (${pre.code}), offering the prepayment override`);
    const okd = await j(`/statements/tx/${T15b}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [LATE], allow_prepayment: true }) });
    ok(okd.code === 200, `and the override lands it (${okd.code})`);
    const aud = (await pool.query(
      `SELECT details FROM bk_audit_log WHERE entry_id = $1 AND action = 'statement_attached'
        ORDER BY id DESC LIMIT 1`, [LATE])).rows[0];
    ok(/PREPAYMENT/.test(aud?.details || ''),
      'and the audit line SAYS it was overruled as a prepayment');
    const T15c = await txnOf(SID, `Nodocco ${TAG}`, 400.00, PAID);
    const nod = await j(`/statements/tx/${T15c}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [D2] }) });
    ok(nod.code === 400 && /no invoice on file/i.test(nod.body?.error || ''),
      `a hand-added row with no document (${nod.code}) ${String(nod.body?.error || '').slice(0, 45)}`);
    const T15d = await txnOf(SID, `Splitco ${TAG}`, 250.00, PAID);
    const kd = await j(`/statements/tx/${T15d}/attach`,
      { method: 'POST', body: JSON.stringify({ expense_ids: [kid] }) });
    ok(kd.code === 400 && /split/i.test(kd.body?.error || ''),
      `a split child (${kd.code}) ${String(kd.body?.error || '').slice(0, 45)}`);

    // ── 17. marked AT UPLOAD, through the batch endpoint ────────────────
    //
    // What John actually asked for: note it while uploading the invoices. The
    // label is resolved server-side because the ids do not exist until the
    // INSERT — correlating created rows back to submitted ones on the client
    // would be ambiguous exactly when it matters (two invoices, one vendor).
    console.log('\n17. Bulk Upload can declare it while uploading');
    const V17 = `Uploadco ${TAG}`;
    const b17 = await j('/bk/entries/batch', { method: 'POST', body: JSON.stringify({ entries: [
      { payee: V17, amount: 700, invoice_date: INVD, category: 'Services', invoice_number: `${TAG}-U1`, settlement_label: 'A' },
      { payee: V17, amount: 300, invoice_date: INVD, category: 'Services', invoice_number: `${TAG}-U2`, settlement_label: 'A' },
      { payee: `Otherco ${TAG}`, amount: 100, invoice_date: INVD, category: 'Services', invoice_number: `${TAG}-U3`, settlement_label: 'B' },
      { payee: V17, amount: 100, invoice_date: INVD, category: 'Services', invoice_number: `${TAG}-U4`, settlement_label: 'B' },
    ] }) });
    ok(b17.code === 200, `batch accepted (${b17.code}) ${b17.body?.error || ''}`);
    for (const r of (b17.body?.data || [])) made.exp.push(r.id);
    const gs = b17.body?.groups || [];
    ok(gs.length === 1 && gs[0].label === 'A' && gs[0].members.length === 2,
      `label A became a group of 2 (${JSON.stringify(gs.map((x) => [x.label, x.members.length]))})`);
    ok((await groupOf(gs[0]?.members?.[0])) === gs[0]?.group, 'and the rows carry the marker');
    const ge = b17.body?.group_errors || [];
    ok(ge.length === 1 && ge[0].label === 'B' && /different vendors/i.test(ge[0].error),
      `label B was REFUSED and says why: ${ge[0]?.error?.slice(0, 55) || '(silent)'}`);
    ok((b17.body?.data || []).length === 4,
      'all four invoices were still created — a refused group does not lose an invoice');

    // ── 16. the money did not move ────────────────────────────────────────
    console.log('\n16. the whole exercise created and destroyed no money');
    const inserted = (await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE id = ANY($1::int[])
         AND (deleted = false OR deleted IS NULL)`, [made.exp])).rows[0].t;
    ok(Math.abs(await ledgerTotal() - (t0 + Number(inserted))) < 0.005,
      `the ledger is its old total plus exactly what this fixture inserted (${money(inserted)})`);
  } catch (err) {
    console.error('\nfixture blew up:', err.message);
    fail++;
  } finally {
    // Order matters: links, then transactions, then statements, then expenses.
    for (const id of made.txn) await pool.query(`DELETE FROM bank_txn_invoice_links WHERE txn_id = $1`, [id]).catch(() => {});
    if (made.stmt.length) await pool.query(`DELETE FROM bank_transactions WHERE statement_id = ANY($1::int[])`, [made.stmt]).catch(() => {});
    if (made.stmt.length) await pool.query(`DELETE FROM bank_statements WHERE id = ANY($1::int[])`, [made.stmt]).catch(() => {});
    if (made.exp.length) {
      await pool.query(`DELETE FROM bk_audit_log WHERE entry_id = ANY($1::int[])`, [made.exp]).catch(() => {});
      await pool.query(`DELETE FROM expenses WHERE parent_id = ANY($1::int[])`, [made.exp]).catch(() => {});
      await pool.query(`DELETE FROM expenses WHERE id = ANY($1::int[])`, [made.exp]).catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
