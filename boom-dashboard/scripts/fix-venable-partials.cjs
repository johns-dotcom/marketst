/**
 * Point Venable LLP invoice 2936364 at the two payments that actually settled it.
 *
 * exp1097 ($70,929.68, Partial, invoice dated 2026-06-11) is matched to tx5683,
 * a $70,929.68 debit on 06/26 that was REVERSED on 06/29 (tx1913). So the ledger
 * reports it paid with money that came back.
 *
 * Its real payments are:
 *   tx2079  2026-06-30  $35,000  — currently matched to exp1143 (Distant Matter
 *                                  LLC), claimed by the auto-sameday carve-out
 *                                  because the amounts matched on the same day
 *                                  even though the payee is Venable
 *   tx4614  2026-03-11  $20,000  — unmatched; a retainer paid 92 days before the
 *                                  invoice, so it needs allow_prepayment
 *
 * $55,000 of $70,929.68, which is why the entry reads Partial.
 *
 * Matching is reversible and touches no amounts or payment status. Aborts unless
 * every transaction is in the exact state described above.
 *
 * Run:  node scripts/fix-venable-partials.cjs scripts/.env [--go]
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

const VENABLE = 1097, REVERSED_TX = 5683, PARTIAL_A = 2079, PARTIAL_B = 4614, DISTANT = 1143;

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('deployed commit:', health.commit);

  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const txns = async () => ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
  const show = (all, id) => { const t = all.find((x) => x.id === id) || {}; return `tx${id} ${String(t.txn_date).slice(0, 10)} ${money(t.amount)} matched=${t.matched_expense_id || '-'}`; };

  let all = await txns();
  const t5683 = all.find((t) => t.id === REVERSED_TX);
  const t2079 = all.find((t) => t.id === PARTIAL_A);
  const t4614 = all.find((t) => t.id === PARTIAL_B);

  console.log('\nbefore:');
  [REVERSED_TX, PARTIAL_A, PARTIAL_B].forEach((id) => console.log('   ' + show(all, id)));

  // Refuse to act on anything that isn't in the expected state.
  const problems = [];
  if (t5683?.matched_expense_id !== VENABLE) problems.push(`tx${REVERSED_TX} is not matched to exp${VENABLE}`);
  if (t2079?.matched_expense_id !== DISTANT) problems.push(`tx${PARTIAL_A} is not matched to exp${DISTANT}`);
  if (t4614?.matched_expense_id) problems.push(`tx${PARTIAL_B} is already matched to exp${t4614.matched_expense_id}`);
  if (Number(t2079?.amount) !== 35000 || Number(t4614?.amount) !== 20000) problems.push('partial amounts are not 35,000 / 20,000');
  if (problems.length) { console.error('\nABORTED — state has changed:\n  ' + problems.join('\n  ') + '\nNothing was modified.'); process.exit(2); }

  if (!GO) { console.log('\n--dry: would unmatch tx5683 and tx2079, then match tx2079 + tx4614 (prepayment) to exp1097'); return; }

  const del = async (id) => (await fetch(`${BASE}/api/statements/tx/${id}/match`, { method: 'DELETE', headers: H })).status;
  const put = async (id, expense_id, extra = {}) => {
    const r = await fetch(`${BASE}/api/statements/tx/${id}/match`, {
      method: 'POST', headers: H, body: JSON.stringify({ expense_id, ...extra }) });
    return `${r.status} ${JSON.stringify(await r.json().catch(() => ({}))).slice(0, 120)}`;
  };

  console.log('\n1. unmatch the reversed payment  ->', await del(REVERSED_TX));
  console.log('2. free the Venable transfer from the Distant Matter invoice ->', await del(PARTIAL_A));
  console.log('3. match $35,000 to Venable      ->', await put(PARTIAL_A, VENABLE));
  console.log('4. match $20,000 retainer        ->', await put(PARTIAL_B, VENABLE, { allow_prepayment: true }));

  all = await txns();
  console.log('\nafter:');
  [REVERSED_TX, PARTIAL_A, PARTIAL_B].forEach((id) => console.log('   ' + show(all, id)));
  const onVenable = all.filter((t) => t.matched_expense_id === VENABLE);
  console.log(`\nexp${VENABLE} now backed by ${onVenable.length} payment(s) totalling `
    + money(onVenable.reduce((s, t) => s + Number(t.amount), 0)) + ' of $70,929.68');
  const orphan = all.filter((t) => t.matched_expense_id === DISTANT);
  console.log(`exp${DISTANT} (Distant Matter, invoice 009) now has ${orphan.length} bank match(es) — its real payment tx2326 sits on exp2415`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
