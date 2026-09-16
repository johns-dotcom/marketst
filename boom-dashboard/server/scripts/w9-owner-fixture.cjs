/**
 * lib/w9-owner.js must give the SAME answer as GET /bk/vendor-w9-status.
 *
 * That endpoint is live and its logic is duplicated in the vendors CTE. A third
 * implementation that disagrees would mean the W9 review deck reviews one
 * document while the vendors page reports another — so agreement is asserted on
 * purpose-built edge cases rather than assumed from reading both.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const { w9OwnerFor, w9OwnersFor } = require('../lib/w9-owner');
const API = 'http://localhost:3011/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TAG = 'W9' + (process.pid % 10000);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

(async () => {
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'john@deanst.co', password: process.env.PW_JOHN }) })).json();
  const H = { authorization: 'Bearer ' + (l.data?.token || l.token), 'content-type': 'application/json' };
  const made = { exp: [], alias: [] };

  // Columns copied from index.js, not guessed.
  const mk = async (o) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO expenses (payee, amount, currency, category, invoice_date, status,
         w9_r2_key, w9_filename, w9_scan, deleted)
       VALUES ($1, 100, 'USD', 'Services', '2026-06-01', $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [o.payee, o.status || 'approved', o.w9 ? `w9/${TAG}-${o.payee}.pdf` : null,
        o.w9 ? `${o.payee} W9.pdf` : null,
        o.scan ? JSON.stringify(o.scan) : null, o.deleted === true]);
    made.exp.push(r.id);
    return r.id;
  };
  const alias = async (primary, a) => {
    await pool.query('INSERT INTO vendor_aliases (primary_name, alias) VALUES ($1,$2) ON CONFLICT DO NOTHING', [primary, a]);
    made.alias.push([primary, a]);
  };
  const endpointSays = async (payee) => {
    const r = await (await fetch(`${API}/bk/vendor-w9-status?payee=${encodeURIComponent(payee)}`, { headers: H })).json();
    return r?.data?.w9_entry_id ?? null;
  };

  try {
    // ── the cases ──
    const A = `Acme ${TAG}`;                       // plain: one W9
    const a1 = await mk({ payee: A, w9: true, scan: { w9_signed: true, w9_dated: true, form_type: 'W-9' } });
    const B = `Bolt ${TAG}`;                       // two W9s — most recent must win
    await mk({ payee: B, w9: true });
    const b2 = await mk({ payee: B, w9: true });
    const C = `Cove ${TAG}`;                       // no W9 at all
    await mk({ payee: C, w9: false });
    const D = `Delta ${TAG}`;                      // W9 under an ALIAS (primary → alias)
    const DL = `Delta Legal ${TAG}`;
    const d1 = await mk({ payee: DL, w9: true });
    await alias(D, DL);
    const E = `Echo ${TAG}`;                       // W9 under the PRIMARY, asked by alias
    const ET = `Echo Trading ${TAG}`;
    const e1 = await mk({ payee: E, w9: true });
    await alias(E, ET);
    const F = `Foxtrot ${TAG}`;                    // only W9 is on a REJECTED row
    await mk({ payee: F, w9: true, status: 'rejected' });
    const G = `Golf ${TAG}`;                       // only W9 is on a DELETED row
    await mk({ payee: G, w9: true, deleted: true });

    console.log('1. lib/w9-owner agrees with GET /bk/vendor-w9-status, case by case');
    const cases = [
      [A, a1, 'a single W9'],
      [B, b2, 'two W9s — the most recent wins'],
      [C, null, 'no W9 anywhere'],
      [D, d1, "W9 filed under the vendor's alias"],
      [ET, e1, 'asked by the alias, W9 under the primary'],
      [F, null, 'a rejected row does not count'],
      [G, null, 'a deleted row does not count'],
    ];
    for (const [payee, want, why] of cases) {
      const mine = await w9OwnerFor(payee, pool);
      const theirs = await endpointSays(payee);
      const mineId = mine?.id ?? null;
      ok(mineId === theirs && mineId === want,
         `${why.padEnd(38)} lib=${String(mineId).padEnd(7)} endpoint=${String(theirs).padEnd(7)} want=${want}`);
    }

    console.log('\n2. the batch resolver matches the single one');
    const names = cases.map(([p]) => p);
    const batch = await w9OwnersFor(names, pool);
    let same = 0;
    for (const [payee, want] of cases) {
      const got = batch.get(payee.trim().toLowerCase())?.id ?? null;
      if (got === want) same++;
      else console.log(`        MISMATCH ${payee}: batch=${got} want=${want}`);
    }
    ok(same === cases.length, `w9OwnersFor agrees on ${same}/${cases.length} — one query, same answers`);
    ok(!batch.has(C.trim().toLowerCase()), 'a vendor with no W9 is ABSENT from the map, not a null entry');

    console.log('\n3. the scan rides along, so the deck needs no second query');
    const owner = await w9OwnerFor(A, pool);
    ok(owner?.w9_scan?.form_type === 'W-9' && owner?.w9_scan?.w9_signed === true,
       `w9OwnerFor returns the stored scan (${JSON.stringify(owner?.w9_scan)})`);
    ok(owner?.w9_review === null, 'and w9_review starts null — nothing has been attested yet');
  } finally {
    for (const [p, a] of made.alias) await pool.query('DELETE FROM vendor_aliases WHERE primary_name=$1 AND alias=$2', [p, a]).catch(() => {});
    for (const id of made.exp) await pool.query('DELETE FROM expenses WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
