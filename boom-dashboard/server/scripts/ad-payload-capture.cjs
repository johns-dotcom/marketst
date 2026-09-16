// Seed a month in DEV, fetch the REAL /ad-charges + dry-run plan, write them to
// JSON for the render pass, then clean up. Plain node — no JSX here.
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const http = require('http');
const fs = require('fs');
const OUT = process.argv[2];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'RD' + (process.pid % 100000);
const MONTH = '2032-05';
const req = (m, p, b, t) => new Promise((res, rej) => {
  const d = b ? JSON.stringify(b) : null;
  const r = http.request('http://localhost:3011' + p, { method: m, headers: Object.assign(
    { 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {},
    d ? { 'Content-Length': Buffer.byteLength(d) } : {}) },
    (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => { try { res({ code: x.statusCode, j: JSON.parse(s) }) } catch { res({ code: x.statusCode, j: s.slice(0, 300) }) } }) });
  r.on('error', rej); if (d) r.write(d); r.end();
});
(async () => {
  const made = { exp: [], stmt: [], camp: [], rule: [], artist: [], rel: [] };
  try {
    const L = await req('POST', '/api/auth/login', { email: 'john@deanst.co', password: process.env.PW_JOHN });
    const token = L.j?.data?.token;
    if (!token) throw new Error('login failed');
    const PAYEE = `RENDER ADS ${TAG}`;
    const { rows: [rule] } = await pool.query(
      `INSERT INTO label_level_spend_rules (scope, rule_key, reason) VALUES ('vendor',$1,'render') RETURNING id`, [PAYEE]);
    made.rule.push(rule.id);
    const { rows: [st] } = await pool.query(
      `INSERT INTO bank_statements (filename, account, period_start, period_end, status, created_at)
       VALUES ($1,'bofa',$2,$3,'ready',NOW()) RETURNING id`, [`${TAG}.pdf`, `${MONTH}-01`, `${MONTH}-28`]);
    made.stmt.push(st.id);
    const { rows: [ar] } = await pool.query('INSERT INTO artists (name) VALUES ($1) RETURNING id', [`Render Artist ${TAG}`]);
    made.artist.push(ar.id);
    const { rows: [rel] } = await pool.query(
      'INSERT INTO releases (project_name, artist_id) VALUES ($1,$2) RETURNING id', [`Render Song ${TAG}`, ar.id]);
    made.rel.push(rel.id);
    const { rows: [camp] } = await pool.query(
      `INSERT INTO influencer_campaigns (name, platform, artist_id, release_id, total_budget, campaign_date, status)
       VALUES ($1,'Facebook',$2,$3,900,$4,'active') RETURNING id`, [`Render Camp ${TAG}`, ar.id, rel.id, `${MONTH}-15`]);
    made.camp.push(camp.id);
    const amts = [1313.17, 422.00];
    for (let i = 0; i < amts.length; i += 1) {
      const d = `${MONTH}-${String(4 + i * 6).padStart(2, '0')}`;
      const { rows: [e] } = await pool.query(`
        INSERT INTO expenses (payee, amount, currency, category, invoice_date, status, payment_status,
          payment_date, entry_source, recoupable)
        VALUES ($1,$2,'USD','Advertisements',$3,'approved','Paid',$3,'bank_statement',TRUE) RETURNING id`,
        [PAYEE, amts[i], d]);
      made.exp.push(e.id);
      await pool.query(`
        INSERT INTO bank_transactions (statement_id, txn_date, description, amount, direction, currency,
          payee_guess, matched_expense_id, match_method, dismissed)
        VALUES ($1,$2,$3,$4,'debit','USD',$5,$6,'created',FALSE)`,
        [st.id, d, `PURCHASE ${TAG} FACEBK *Z1`, amts[i], PAYEE, e.id]);
    }
    // Allocate part of it, so the "allocated to" chip branch has something to render.
    const first = await req('POST', '/api/reports/ad-allocate', { month: MONTH, campaign_id: camp.id, amount: 500 }, token);
    const R = await req('GET', `/api/reports/ad-charges?month=${MONTH}`, null, token);
    const P = await req('POST', '/api/reports/ad-allocate',
      { month: MONTH, campaign_id: camp.id, amount: 100, dry_run: true }, token);
    const M = await req('GET', '/api/reports/ad-months', null, token);
    fs.writeFileSync(OUT, JSON.stringify({
      allocate_code: first.code, charges_code: R.code, plan_code: P.code, months_code: M.code,
      data: R.j.data, plan: P.j.data, months: M.j.data,
    }, null, 2));
    console.log(`seeded ${MONTH}: allocate ${first.code}, charges ${R.code}, plan ${P.code}, months ${M.code}`);
  } finally {
    await pool.query('DELETE FROM expenses WHERE parent_id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM bank_transactions WHERE statement_id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [made.exp]).catch(() => {});
    await pool.query('DELETE FROM bank_statements WHERE id = ANY($1::int[])', [made.stmt]).catch(() => {});
    await pool.query('DELETE FROM influencer_campaigns WHERE id = ANY($1::int[])', [made.camp]).catch(() => {});
    await pool.query('DELETE FROM label_level_spend_rules WHERE id = ANY($1::int[])', [made.rule]).catch(() => {});
    await pool.query('DELETE FROM releases WHERE id = ANY($1::int[])', [made.rel]).catch(() => {});
    await pool.query('DELETE FROM artists WHERE id = ANY($1::int[])', [made.artist]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error('SEED ERROR:', e.message); process.exit(1) });
