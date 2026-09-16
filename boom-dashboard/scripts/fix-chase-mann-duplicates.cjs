/**
 * Chase Mann: remove booked duplicates and give the real invoices their payments.
 *
 * Same shape as the Distant Matter fix. A bank debit was booked as its own ledger
 * entry ('created', entry_source='bank_statement') while the vendor invoice it
 * actually paid already existed — so the spend is counted twice in the ledger and
 * the genuine invoice shows no evidence.
 *
 *   tx99    2026-01-27  $2,000.00  booked exp3620  ->  exp124  inv 533, 2026-01-26
 *   tx3674  2026-07-02    $450.00  booked exp3340  ->  exp1160 inv 569, 2026-07-02
 *
 * Both are the ONLY unmatched Chase Mann invoice at that amount within 10 days,
 * and tx3674/exp1160 agree to the day. In both cases the debit falls on or after
 * the invoice date, so neither trips the prepayment guard.
 *
 * NOT included, because the evidence does not single out one answer:
 *
 *   exp3650  2026-03-05  $1,000  two candidates — exp235 (inv 541, same day, a
 *                                two-row split family) and exp320 (inv 544, five
 *                                days later)
 *   exp3651  2026-02-25  $1,000  its only candidate is exp235, which is dated
 *                                eight days AFTER the debit and is also exp3650's
 *                                best candidate. Two booked entries cannot both
 *                                be the same invoice.
 *
 * Guessing between them would put $1,000 on the wrong invoice and leave a real
 * one unevidenced, which is worse than leaving both flagged. exp2426 (Salary),
 * exp3646, exp3647, exp3648 and exp3654 have no candidate at all — they look
 * like genuine spend with no invoice on file.
 *
 * `unbook` is the designed inverse of booking a debit: it soft-deletes the
 * created entry (restorable), cascades to split children, clears the match, and
 * un-teaches the payee/category mappings the booking taught.
 *
 * Aborts unless every row is in exactly the state described.
 *
 * Run:  node scripts/fix-chase-mann-duplicates.cjs scripts/.env [--go]
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-production.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });

const CASES = [
  { tx: 99, dupe: 3620, real: 124, invoice: '533', amount: 2000 },
  { tx: 3674, dupe: 3340, real: 1160, invoice: '569', amount: 450 },
];

(async () => {
  console.log('deployed commit:', (await (await fetch(`${BASE}/health`)).json()).commit);
  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = async () => {
    const all = ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
    const ej = await (await fetch(`${BASE}/api/bk/entries?status=approved&limit=99999`, { headers: H })).json();
    const list = Array.isArray(ej.data) ? ej.data : (ej.data?.data || []);
    return { all, list };
  };

  let { all, list } = await load();
  const byId = (id) => list.find((e) => e.id === id);
  const famTotal = (e) => Number(e.amount)
    + list.filter((c) => c.parent_id === e.id).reduce((s, c) => s + Number(c.amount), 0);

  console.log('\nbefore:');
  const problems = [];
  for (const c of CASES) {
    const t = all.find((x) => x.id === c.tx);
    const dupe = byId(c.dupe);
    const real = byId(c.real);
    console.log(`   tx${String(c.tx).padEnd(5)}${money(c.amount).padStart(11)}  booked exp${c.dupe}`
      + `  ->  exp${c.real} inv ${c.invoice}`);
    if (!t) { problems.push(`tx${c.tx} not found`); continue; }
    if (t.match_method !== 'created') problems.push(`tx${c.tx} is not booked (method=${t.match_method})`);
    if (t.matched_expense_id !== c.dupe) problems.push(`tx${c.tx} points at ${t.matched_expense_id}, expected ${c.dupe}`);
    if (!dupe) { problems.push(`exp${c.dupe} not found`); continue; }
    if (dupe.entry_source !== 'bank_statement') problems.push(`exp${c.dupe} is not bank-derived — refusing to remove it`);
    if (String(dupe.invoice_number || '').trim()) problems.push(`exp${c.dupe} has an invoice number — may not be a duplicate`);
    if (!real) { problems.push(`exp${c.real} not found`); continue; }
    if (String(real.invoice_number || '').trim() !== c.invoice) problems.push(`exp${c.real} is not invoice ${c.invoice}`);
    if (Math.abs(famTotal(real) - c.amount) > 0.01) problems.push(`exp${c.real} family total is ${money(famTotal(real))}, expected ${money(c.amount)}`);
    if (all.some((x) => x.matched_expense_id === c.real)) problems.push(`exp${c.real} already has bank evidence`);
  }
  if (problems.length) {
    console.error('\nABORTED:\n  ' + problems.join('\n  ') + '\nNothing was modified.');
    process.exit(2);
  }

  if (!GO) { console.log(`\n--dry: both pairs are in the expected state; would unbook then re-point each`); return; }

  console.log();
  for (const c of CASES) {
    const r1 = await fetch(`${BASE}/api/statements/tx/${c.tx}/unbook`, { method: 'POST', headers: H });
    console.log(`unbook tx${String(c.tx).padEnd(5)} (removes exp${c.dupe}) -> ${r1.status}`);
    const r2 = await fetch(`${BASE}/api/statements/tx/${c.tx}/match`, {
      method: 'POST', headers: H, body: JSON.stringify({ expense_id: c.real }) });
    console.log(`match  tx${String(c.tx).padEnd(5)} -> exp${c.real} (inv ${c.invoice})   -> ${r2.status} `
      + JSON.stringify(await r2.json().catch(() => ({}))).slice(0, 80));
  }

  ({ all, list } = await load());
  console.log('\nafter:');
  for (const c of CASES) {
    const t = all.find((x) => x.id === c.tx) || {};
    console.log(`   tx${String(c.tx).padEnd(5)} -> exp${t.matched_expense_id || '-'}`
      + `   exp${c.dupe} ${byId(c.dupe) ? 'STILL PRESENT' : 'removed (restorable)'}`
      + `   exp${c.real} backed: ${t.matched_expense_id === c.real ? 'yes' : 'NO'}`);
  }
  const cm = list.filter((e) => /chase mann/i.test(e.payee || ''));
  console.log(`\nChase Mann ledger total now ${money(cm.reduce((s, e) => s + Number(e.amount), 0))}`
    + `  across ${cm.length} entries (${cm.filter((e) => e.entry_source === 'bank_statement').length} still bank-booked)`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
