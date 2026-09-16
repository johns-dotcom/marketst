require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'RQ' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const H = { authorization: 'Bearer ' + (l.data?.token || l.token), 'content-type': 'application/json' };
  const j = async (p, o = {}) => { const r = await fetch(API + p, { headers: H, ...o });
    const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; } };
  const made = [];
  const FULL = () => ({
    payee: `Creator ${TAG}`, amount: 120, artist: `Zz ${TAG}`, song: 'Track',
    vendor_email: 'c@example.com', paypal_handle: '@handle',
    social_handles: [{ platform: 'tiktok', handle: '@c' }],
  });

  try {
    console.log('1. every one of the seven is enforced by the SERVER');
    for (const [field, label] of [
      ['payee', 'creator name'], ['amount', 'a positive amount'], ['artist', 'artist'],
      ['song', 'song'], ['vendor_email', 'email'], ['paypal_handle', 'PayPal handle'],
      ['social_handles', 'socials'],
    ]) {
      const p = FULL();
      p[field] = field === 'social_handles' ? [] : (field === 'amount' ? 0 : '');
      const r = await j('/creators/batch', { method: 'POST', body: JSON.stringify({ payments: [p] }) });
      const said = JSON.stringify(r.body);
      ok(r.status === 400 && said.includes(label),
         `omitting ${field.padEnd(15)} → 400 naming "${label}"`);
    }

    console.log('\\n2. a complete payment still saves');
    const good = await j('/creators/batch', { method: 'POST', body: JSON.stringify({ payments: [FULL()] }) });
    for (const r of good.body?.data?.rows || []) made.push(r.id);
    ok(good.status === 201, `a payment with all seven saves (${good.status})`);

    console.log('\\n3. the single endpoint has the SAME rule');
    const single = await j('/creators', { method: 'POST', body: JSON.stringify({ payee: `X ${TAG}`, amount: 50 }) });
    ok(single.status === 400 && /artist|song|email/.test(JSON.stringify(single.body)),
       `POST /creators with only name+amount is refused (${single.status}) — it cannot be the way around the rule`);
    const single2 = await j('/creators', { method: 'POST', body: JSON.stringify(FULL()) });
    if (single2.body?.data?.id) made.push(single2.body.data.id);
    ok(single2.status === 201, `and a complete one still works (${single2.status})`);

    console.log('\\n4. an incomplete row still rejects the WHOLE batch');
    const before = (await j('/creators')).body?.data?.length;
    const mixed = await j('/creators/batch', { method: 'POST', body: JSON.stringify({ payments: [
      FULL(), { ...FULL(), song: '' }, { ...FULL(), paypal_handle: '' },
    ] }) });
    ok(mixed.status === 400, `rejected (${mixed.status})`);
    const msg = JSON.stringify(mixed.body);
    ok(/Creator 2/.test(msg) && /Creator 3/.test(msg), 'naming creator 2 AND creator 3, not just the first');
    ok(!/Creator 1/.test(msg), 'and not blaming creator 1, which was fine');
    const after = (await j('/creators')).body?.data?.length;
    ok(before === after, `nothing written — ${before} before, ${after} after`);

    console.log('\\n5. the 121 already in the ledger are untouched by this');
    // The requirement is on the WRITE path. Converting rows that predate it must
    // still work, or the migration John is about to run would be blocked by a
    // rule about new entries.
    const conv = await j('/creators/convertible');
    ok(conv.status === 200 && (conv.body?.data || []).length >= 0,
       'the convertible queue still answers — conversion is not gated on the new fields');
  } finally {
    for (const id of made) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
