#!/usr/bin/env node
// QuickBooks push sync, against the dry-run QuickBooks in lib/qbo.js.
//   cd server && QBO_DRY_RUN=1 PORT=3011 node index.js &   (wait for /health + ~10s for migrations)
//   node scripts/qbo-fixture.cjs
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('../db');
const paymentCrypto = require('../lib/payment-crypto');
const BASE = 'http://localhost:3011/api';
const TAG = `QboFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => { const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const made = { expenses: [] };
// every confirm key true, every answer key answered no
const CHECKLIST = { artist: true, song: true, amount: true, category: true, bulk_deal: false, cobrand: false, recoupable: false, campaign: false };
(async () => {
  const savedConn = (await pool.query('SELECT * FROM qbo_connection WHERE id = 1')).rows[0] || null;
  try {
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; if (!T) throw new Error('login failed');
    const user = jwt.sign({ id: 999999, email: 'fx-user@example.com', name: 'Fx User', role: 'User', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // 1. status, unconnected
    await pool.query('DELETE FROM qbo_connection WHERE id = 1');
    let st = await api('GET', '/quickbooks/status', T);
    check('status: admin sees an unconnected QuickBooks with dry_run on', st.status === 200 && st.body.data.connected === false && st.body.data.dry_run === true, JSON.stringify(st.body?.data?.queue));
    check('status: a User is refused', (await api('GET', '/quickbooks/status', user)).status === 403);

    // 2. connect through the callback with a signed state
    const state = jwt.sign({ uid: 1, t: 'qbo_connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const cb = await fetch(`${BASE}/quickbooks/oauth/callback?code=dry&realmId=123456789&state=${state}`, { redirect: 'manual' });
    const loc = cb.headers.get('location') || '';
    check('callback: connects and redirects to Settings with qb=connected and the company', cb.status === 302 && /qb=connected/.test(loc) && /company=Dry\+Run\+Records/.test(loc), loc);
    const bad = await fetch(`${BASE}/quickbooks/oauth/callback?code=dry&realmId=1&state=nope`, { redirect: 'manual' });
    check('callback: a forged state is refused (qb=badstate), nothing stored twice', /qb=badstate/.test(bad.headers.get('location') || ''));
    st = await api('GET', '/quickbooks/status', T);
    check('status: connected, tokens never returned', st.body.data.connected === true && st.body.data.company_name === 'Dry Run Records' && !JSON.stringify(st.body.data).includes('dry-refresh'));
    const conn = (await pool.query('SELECT refresh_token_enc FROM qbo_connection WHERE id = 1')).rows[0];
    check('the refresh token is stored encrypted', !!conn.refresh_token_enc && conn.refresh_token_enc.startsWith('v1:') && paymentCrypto.decrypt(conn.refresh_token_enc).startsWith('dry-refresh'));

    // 3. accounts + settings
    const acc = await api('GET', '/quickbooks/accounts', T);
    check('accounts: expense, bank and A/P lists come back', acc.status === 200 && acc.body.data.expense.length >= 2 && acc.body.data.bank.length >= 1 && acc.body.data.ap.length >= 1);
    const cats = await api('GET', '/quickbooks/categories', T);
    check('categories: the ledger categories list', cats.status === 200 && Array.isArray(cats.body.data));
    const marketing = acc.body.data.expense.find((a) => a.name === 'Marketing');
    const set = await api('PUT', '/quickbooks/settings', T, { default_expense_account: null, bank_account: acc.body.data.bank[0], category_map: { [`${TAG} Marketing`]: marketing } });
    check('settings: bank account and one category mapping saved', set.status === 200 && set.body.data.bank_account.id === acc.body.data.bank[0].id && set.body.data.category_map[`${TAG} Marketing`].id === marketing.id);

    // 4. an approved expense in a MAPPED category is pushed as a Bill; an unmapped one fails without retry
    const ins = async (cat, status = 'approved') => (await pool.query(`INSERT INTO expenses (invoice_date, payee, description, category, amount, status, approved_by, approved_at, payment_status, invoice_number, vendor_email)
      VALUES (CURRENT_DATE, $1, $2, $3, 1234.56, $4, 'Fixture', NOW(), 'Unpaid', $5, 'vendor@example.com') RETURNING id`, [`${TAG} Vendor`, `${TAG} desc`, cat, status, `${TAG}-INV`])).rows[0].id;
    const okId = await ins(`${TAG} Marketing`); made.expenses.push(okId);
    const badId = await ins(`${TAG} Unmapped`); made.expenses.push(badId);
    let push = await api('POST', `/quickbooks/expenses/${okId}/push?now=1`, T);
    check('push: an approved expense in a mapped category becomes a Bill (queue done)', push.status === 200 && push.body.data.result.done >= 1, JSON.stringify(push.body.data.result));
    const link = (await pool.query(`SELECT * FROM qbo_links WHERE entity_type = 'bill' AND entity_key = $1`, [String(okId)])).rows[0];
    check('…the Bill id is remembered in qbo_links, and the vendor was created once', !!link && link.qbo_type === 'Bill' && (await pool.query(`SELECT COUNT(*)::int AS n FROM qbo_links WHERE entity_type = 'vendor' AND entity_key = $1`, [`${TAG.toLowerCase()} vendor`])).rows[0].n === 1);
    const flag = (await pool.query('SELECT in_quickbooks, qb_entry_date FROM expenses WHERE id = $1', [okId])).rows[0];
    check('…and the ledger row is flagged in_quickbooks = Yes with a date', flag.in_quickbooks === 'Yes' && !!flag.qb_entry_date);
    push = await api('POST', `/quickbooks/expenses/${badId}/push?now=1`, T);
    const q = (await pool.query(`SELECT * FROM qbo_queue WHERE expense_id = $1 AND kind = 'bill'`, [badId])).rows[0];
    check('push: an unmapped category fails ONCE with a sentence naming the category, no retry', q && q.status === 'error' && /Unmapped/.test(q.last_error) && q.attempts === 1, q?.last_error);
    // fix the mapping, retry → done
    await api('PUT', '/quickbooks/settings', T, { default_expense_account: acc.body.data.expense[1] });
    const rt = await api('POST', `/quickbooks/queue/${q.id}/retry`, T); await api('POST', '/quickbooks/sync', T);
    check('retry after setting a default expense account: the row is pushed', rt.status === 200 && (await pool.query('SELECT status FROM qbo_queue WHERE id = $1', [q.id])).rows[0].status === 'done');
    // a second push UPDATES the same Bill
    await api('POST', `/quickbooks/expenses/${okId}/push?now=1`, T);
    const link2 = (await pool.query(`SELECT * FROM qbo_links WHERE entity_type = 'bill' AND entity_key = $1`, [String(okId)])).rows[0];
    check('pushing again updates the same Bill (same id, sync token moved)', link2.qbo_id === link.qbo_id && link2.sync_token !== link.sync_token);

    // 5. the real routes enqueue: approve and mark paid
    const pend = (await pool.query(`INSERT INTO expenses (invoice_date, payee, description, category, amount, status, payment_status) VALUES (CURRENT_DATE, $1, 'pending one', $2, 50, 'pending', 'Unpaid') RETURNING id`, [`${TAG} Vendor`, `${TAG} Marketing`])).rows[0].id; made.expenses.push(pend);
    const ap = await api('POST', `/bk/entries/${pend}/approve`, T, { checklist: CHECKLIST });
    await new Promise((r) => setTimeout(r, 400)); // enqueue is fire-and-forget after the response
    const queued = (await pool.query(`SELECT * FROM qbo_queue WHERE expense_id = $1 AND kind = 'bill'`, [pend])).rows[0];
    check('approving an expense enqueues its Bill', (ap.status === 200 || ap.status === 400) && !!queued, `approve HTTP ${ap.status}${ap.body?.error ? ` (${ap.body.error})` : ''}`);
    await api('POST', '/quickbooks/sync', T);
    const mp = await api('PUT', `/bk/payments/${okId}`, T, { payment_status: 'Paid', payment_method: 'ACH', payment_ref: 'FX-001' });
    await new Promise((r) => setTimeout(r, 400));
    const pq = (await pool.query(`SELECT * FROM qbo_queue WHERE expense_id = $1 AND kind = 'payment'`, [okId])).rows[0];
    check('marking Paid enqueues a BillPayment', mp.status === 200 && !!pq, `HTTP ${mp.status}`);
    const sync = await api('POST', '/quickbooks/sync', T);
    const pl = (await pool.query(`SELECT * FROM qbo_links WHERE entity_type = 'payment' AND entity_key = $1`, [String(okId)])).rows[0];
    check('…and the sync creates the BillPayment linked to the Bill', sync.status === 200 && !!pl && pl.qbo_type === 'BillPayment', JSON.stringify(sync.body.data));
    const queue = await api('GET', '/quickbooks/queue', T);
    check('queue: rows carry payee, amount and the QuickBooks id', queue.status === 200 && queue.body.data.some((r) => r.expense_id === okId && r.qbo_id));

    // 6. disconnect → enqueue becomes a no-op
    const dc = await api('DELETE', '/quickbooks/connection', T);
    const npend = (await pool.query(`INSERT INTO expenses (invoice_date, payee, description, category, amount, status, payment_status) VALUES (CURRENT_DATE, $1, 'after disconnect', $2, 5, 'pending', 'Unpaid') RETURNING id`, [`${TAG} Vendor`, `${TAG} Marketing`])).rows[0].id; made.expenses.push(npend);
    await api('POST', `/bk/entries/${npend}/approve`, T, { checklist: CHECKLIST });
    check('disconnected: nothing is queued and approving still works', dc.status === 200 && (await pool.query('SELECT COUNT(*)::int AS n FROM qbo_queue WHERE expense_id = $1', [npend])).rows[0].n === 0);
    const inte = await api('GET', '/settings/integrations', T);
    check('integrations list carries QuickBooks, DocuSign and Chartmetric rows', inte.status === 200 && ['quickbooks', 'docusign', 'chartmetric', 'spotify'].every((k) => inte.body.data.some((r) => r.key === k)));
  } catch (e) { console.error('FIXTURE THREW', e); results.push({ n: 'threw', ok: false }); }
  finally {
    for (const id of made.expenses) { await pool.query('DELETE FROM qbo_queue WHERE expense_id = $1', [id]).catch(() => {}); await pool.query('DELETE FROM expenses WHERE id = $1 OR parent_id = $1', [id]).catch(() => {}); }
    await pool.query(`DELETE FROM qbo_links WHERE entity_key ILIKE $1 OR entity_key = ANY($2::text[])`, [`%${TAG.toLowerCase()}%`, made.expenses.map(String)]).catch(() => {});
    await pool.query(`DELETE FROM bk_audit_log WHERE action LIKE 'qbo_%' AND entry_id IS NULL`).catch(() => {});
    if (savedConn) await pool.query(`INSERT INTO qbo_connection SELECT * FROM jsonb_populate_record(NULL::qbo_connection, $1::jsonb) ON CONFLICT (id) DO UPDATE SET realm_id = EXCLUDED.realm_id, refresh_token_enc = EXCLUDED.refresh_token_enc, settings = EXCLUDED.settings`, [JSON.stringify(savedConn)]).catch(() => {});
    else await pool.query('DELETE FROM qbo_connection WHERE id = 1').catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
