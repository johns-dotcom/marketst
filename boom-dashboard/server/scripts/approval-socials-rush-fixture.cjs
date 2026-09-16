/**
 * The write paths behind the Approvals deck's two new controls.
 *
 * The jsdom harness (client/scripts/approval-deck-dom-entry.jsx) proves the deck
 * SENDS the right thing. This proves the server ACCEPTS it — the distinction
 * that let a button POST into a 400 for a month once.
 *
 * Two claims the UI depends on and cannot check for itself:
 *   • PUT /bk/entries/:id RETURNS the normalized social_handles, because the
 *     card reads them back off the answer rather than trusting its draft
 *   • a social row's `artist` and `amount` survive a round trip through the
 *     deck's edit — the card never displays them, so nothing else would notice
 *     them being dropped
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const BASE = 'http://localhost:3011';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'AS' + (process.pid % 100000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  let id = null, token = null;
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
  const j = async (p, o) => {
    const r = await fetch(BASE + '/api' + p, { headers: H(), ...o });
    let b = null; try { b = await r.json() } catch {}
    return { code: r.status, body: b };
  };
  try {
    const L = await fetch(BASE + '/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) });
    token = (await L.json())?.data?.token;
    if (!token) { console.error('login failed'); process.exit(1); }

    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         payment_status, vendor_submitted, social_handles)
       VALUES ($1, 2000,'USD','Marketing', CURRENT_DATE, 'pending','Unpaid', true, $2)
       RETURNING id`,
      [`Whitaker ${TAG}`, JSON.stringify([
        { platform: 'Instagram', handle: '@whitaswhit' },
        { platform: 'YouTube', handle: '@whitaswhit', artist: 'nikko', amount: 500 },
      ])]);
    id = r.id;
    console.log(`entry #${id}\n`);

    console.log('1. editing a handle comes back NORMALIZED from the server');
    const p1 = await j(`/bk/entries/${id}`, { method: 'PUT', body: JSON.stringify({ social_handles: [
      { platform: 'Instagram', handle: '  @whitaswhit_real ' },
      { platform: 'YouTube', handle: '@whitaswhit', artist: 'nikko', amount: 500 },
    ] }) });
    ok(p1.code === 200, `PUT accepted (${p1.code}) ${p1.body?.error || ''}`);
    const back = p1.body?.data?.social_handles;
    ok(Array.isArray(back), `the response CARRIES social_handles as an array (${typeof back})`);
    ok(back?.[0]?.handle === '@whitaswhit_real', `trimmed on the way in (${JSON.stringify(back?.[0])})`);
    const yt = back?.find(x => x.platform === 'YouTube');
    ok(yt?.artist === 'nikko' && Number(yt?.amount) === 500,
      `artist + amount survived — the card never shows them (${JSON.stringify(yt)})`);

    console.log('\n2. adding one, and dropping an empty row');
    const p2 = await j(`/bk/entries/${id}`, { method: 'PUT', body: JSON.stringify({ social_handles: [
      ...back, { platform: 'TikTok', handle: '@added' }, { platform: 'X', handle: '   ' },
    ] }) });
    const b2 = p2.body?.data?.social_handles;
    ok(p2.code === 200 && b2?.length === 3,
      `3 rows stored — the blank one was dropped, not saved (${b2?.length})`);
    ok(b2?.some(x => x.handle === '@added'), 'the new handle is there');

    console.log('\n3. removing one is just a shorter list');
    const p3 = await j(`/bk/entries/${id}`, { method: 'PUT',
      body: JSON.stringify({ social_handles: b2.filter(x => x.platform !== 'Instagram') }) });
    ok(p3.code === 200 && p3.body?.data?.social_handles?.length === 2,
      `2 left (${p3.body?.data?.social_handles?.length})`);

    console.log('\n4. Rush, from the same deck');
    const rush = await j(`/bk/payments/${id}/rush`, { method: 'POST', body: JSON.stringify({ reason: 'needed friday' }) });
    ok(rush.code === 200, `rush set (${rush.code}) ${rush.body?.error || ''}`);
    ok(rush.body?.data?.rush_requested === true && rush.body?.data?.rush_reason === 'needed friday',
      `and it answers with the row the button renders (${JSON.stringify(rush.body?.data?.rush_reason)})`);
    const un = await j(`/bk/payments/${id}/rush`, { method: 'DELETE' });
    ok(un.code === 200 && un.body?.data?.rush_requested === false, `cleared (${un.code})`);

    console.log('\n5. approving still needs the checklist — Rush is not an answer');
    const ap = await j(`/bk/entries/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    ok(ap.code === 400, `refused without a checklist (${ap.code}) ${String(ap.body?.error || '').slice(0, 60)}`);
  } catch (err) {
    console.error('\nfixture blew up:', err.message);
    fail++;
  } finally {
    if (id) {
      await pool.query(`DELETE FROM bk_audit_log WHERE entry_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM expenses WHERE id = $1`, [id]).catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
