#!/usr/bin/env node
/**
 * The label's own details: masked read for everyone, Admin edits, Superadmin
 * secrets, an audited decrypting read for bookkeeping roles. Server on :3011.
 * Restores the row it changes.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const pool = require('./../db');
const BASE = 'http://localhost:3011/api';
const TAG = `LblFx${Date.now()}`;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(ok ? 'PASS' : 'FAIL', n, d === undefined ? '' : `— ${d}`); };
const api = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  let snapshot = null; const made = { users: [] };
  try {
    const { rows: [snap] } = await pool.query('SELECT * FROM label_settings WHERE id = 1'); snapshot = snap;
    check('the label row exists (seeded on boot)', !!snap && snap.display_name === 'Market Street');
    const login = await api('POST', '/auth/login', null, { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const T = login.body?.data?.token; check('login', !!T);
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, 'User', 'x') RETURNING id, email, name, role`, [`${TAG} User`, `${TAG.toLowerCase()}@example.test`]); made.users.push(u.id);
    const { rows: [a] } = await pool.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, 'Admin', 'x') RETURNING id, email, name, role`, [`${TAG} Admin`, `${TAG.toLowerCase()}-admin@example.test`]); made.users.push(a.id);
    const tok = (x) => jwt.sign({ id: x.id, email: x.email, name: x.name, role: x.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const put = await api('PUT', '/label', T, { legal_name: `${TAG} Records LLC`, address_line1: '1 Main St', address_line2: 'Los Angeles, CA 90001', contact_email: 'ap@example.test', signatory_name: 'Sam Chen', signatory_title: 'Managing Member', bank_name: 'Chase', bank_routing_ach: '021000021', ein: '12-3456789', bank_account_number: '000123456789' });
    check('Superadmin saves plain fields and the two secrets', put.status === 200 && put.body.data.legal_name === `${TAG} Records LLC` && put.body.data.ein_set === true && put.body.data.bank_account_set === true, JSON.stringify(put.body).slice(0, 160));
    check('the masked payload carries last four only, never the numbers', put.body.data.ein_last4 === '6789' && put.body.data.bank_account_last4 === '6789' && !('ein' in put.body.data) && !('bank_account_number' in put.body.data) && !('ein_enc' in put.body.data));
    const asUser = await api('GET', '/label', tok(u));
    check('a User reads the label masked', asUser.status === 200 && asUser.body.data.legal_name === `${TAG} Records LLC` && !('ein_enc' in asUser.body.data));
    check('a User cannot edit it', (await api('PUT', '/label', tok(u), { legal_name: 'x' })).status === 403);
    const adminPlain = await api('PUT', '/label', tok(a), { contact_phone: '+1 555 0100' });
    check('an Admin edits plain fields', adminPlain.status === 200 && adminPlain.body.data.contact_phone === '+1 555 0100');
    check('…but not the EIN', (await api('PUT', '/label', tok(a), { ein: '99-9999999' })).status === 403);
    check('a bad contact email is refused', (await api('PUT', '/label', T, { contact_email: 'nope' })).status === 400);
    const { rows: [db] } = await pool.query('SELECT ein_enc, bank_account_enc FROM label_settings WHERE id = 1');
    check('the numbers are not stored in clear', db.ein_enc && !db.ein_enc.includes('3456789') && db.bank_account_enc && !db.bank_account_enc.includes('123456789'));
    const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM bk_audit_log WHERE action = 'label_remittance_read'`)).rows[0].n;
    const rem = await api('GET', '/label/remittance', T);
    check('the remittance read returns the decrypted EIN and account', rem.status === 200 && rem.body.data.ein === '12-3456789' && rem.body.data.bank_account_number === '000123456789');
    const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM bk_audit_log WHERE action = 'label_remittance_read'`)).rows[0].n;
    check('…and writes one audit row', after === before + 1, `${before} → ${after}`);
    check('a User cannot read the remittance block', (await api('GET', '/label/remittance', tok(u))).status === 403);
    const cleared = await api('PUT', '/label', T, { ein: '' });
    check("'' clears a secret", cleared.body.data.ein_set === false && cleared.body.data.ein_last4 === null);
  } catch (err) { console.error('FIXTURE ERROR', err); results.push({ n: 'no exception', ok: false }); }
  finally {
    if (snapshot) {
      const cols = Object.keys(snapshot).filter((k) => k !== 'id');
      await pool.query(`UPDATE label_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => snapshot[c])).catch((e) => console.error('restore failed', e.message));
    }
    await pool.query(`DELETE FROM bk_audit_log WHERE action = 'label_remittance_read' AND details LIKE '%invoice%' AND entry_payee LIKE $1`, [`${TAG}%`]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made.users]).catch(() => {});
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
