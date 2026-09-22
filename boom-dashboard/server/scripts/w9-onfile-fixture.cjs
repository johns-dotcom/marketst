#!/usr/bin/env node
/**
 * The form's W9 badge and the submit gate must give the SAME answer.
 *
 *   cd server
 *   PORT=3011 node index.js &
 *   node scripts/w9-onfile-fixture.cjs
 *
 * Why this exists. `vendor-required-fixture.cjs` covers the required set and
 * makes real submissions to do it, which costs Anthropic calls — so it never
 * covered the W9 gate, and the gate drifted from the badge for as long as both
 * have existed. A vendor whose W9 was filed under an alias, submitting under the
 * primary name, was shown "W9 on file — no need to resubmit", advanced past the
 * W9 step on the strength of that badge, and was then refused with "Please
 * upload your W9 or W8 form" — on a page that renders no W9 upload field while
 * the badge is showing. Unfinishable, and the 400 is recorded nowhere, so nobody
 * at market.st learned the invoice had been attempted.
 *
 * This asserts the two endpoints AGREE rather than asserting either is true on
 * its own. That is the property that was broken: each was individually
 * defensible and they disagreed, so a test of one would have stayed green.
 *
 * No submissions, so no AI spend and no `vendorLimiter` — /lookup and /check-w9
 * are reads. Seeds its own vendor and deletes it on the way out, including on
 * failure.
 */

const pool = require('../db');

const BASE = process.env.BASE || 'http://localhost:3011';
const TAG = `ZZW9FX${process.pid}`;
const PRIMARY = `${TAG} Legal Name`;
const ALIAS   = `${TAG} Trading Name`;
const ORPHAN  = `${TAG} No Paperwork`;

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else      { fail++; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const onFile = async (route, name) => {
  const url = `${BASE}/api/vendor/${route}?name=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${route} returned ${r.status}`);
  return (await r.json()).on_file;
};

// Both endpoints, one question. Returns { lookup, checkW9, agree }.
const both = async (name) => {
  const [lookup, checkW9] = await Promise.all([onFile('lookup', name), onFile('check-w9', name)]);
  return { lookup, checkW9, agree: lookup === checkW9 };
};

async function seed() {
  await pool.query(
    `INSERT INTO vendor_aliases (primary_name, alias) VALUES ($1, $2)`, [PRIMARY, ALIAS]);
  // The W9 lives on the ALIAS spelling, which is the shape the bug needed. Also
  // note w9_filename is set and w9_data is NULL: the old gate required
  // w9_filename AND w9_data together, so an R2-era form (the only kind written
  // since the cutover) failed its test even on a direct name match.
  await pool.query(
    `INSERT INTO expenses (invoice_date, payee, vendor_name, amount, status,
                           w9_filename, w9_r2_key, created_at)
     VALUES (NOW(), $1, $1, 1, 'approved', 'w9.pdf', $2, NOW())`,
    [ALIAS, `vendors/${TAG}/w9/form.pdf`]);
  // A vendor with an invoice and no W9 at all — the refusal must survive.
  await pool.query(
    `INSERT INTO expenses (invoice_date, payee, vendor_name, amount, status, created_at)
     VALUES (NOW(), $1, $1, 1, 'approved', NOW())`, [ORPHAN]);
}

async function cleanup() {
  await pool.query(`DELETE FROM expenses WHERE payee LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.query(`DELETE FROM vendor_aliases WHERE primary_name LIKE $1`, [`${TAG}%`]).catch(() => {});
}

(async () => {
  try {
    await fetch(`${BASE}/api/vendor/roster`).catch(() => {
      throw new Error(`no server on ${BASE} — start one with: PORT=3011 node index.js`);
    });
    await cleanup();
    await seed();

    console.log('\n1. the alias direction that always worked');
    const alias = await both(ALIAS);
    ok(alias.lookup === true,  'the badge sees the W9 on the vendor\'s own name');
    ok(alias.checkW9 === true, 'and so does the gate');
    ok(alias.agree,            'they agree');

    console.log('\n2. the direction that did not — W9 under the alias, submitting as PRIMARY');
    const primary = await both(PRIMARY);
    ok(primary.lookup === true,  'the badge sees it through the alias');
    ok(primary.checkW9 === true, 'THE GATE SEES IT TOO (this is the fix)');
    ok(primary.agree,            'they agree — the vendor is not asked for a form we hold',
       `lookup=${primary.lookup} check-w9=${primary.checkW9}`);

    console.log('\n3. case and whitespace must not decide it');
    const messy = await both(`  ${PRIMARY.toLowerCase()}  `);
    ok(messy.lookup === true && messy.checkW9 === true, 'both still see it');
    ok(messy.agree, 'they agree');

    console.log('\n4. a vendor with genuinely no W9 is still refused');
    const none = await both(ORPHAN);
    ok(none.lookup === false,  'the badge does not show');
    ok(none.checkW9 === false, 'and the gate would ask for the form');
    ok(none.agree,             'they agree');

    console.log('\n5. a name nobody has heard of');
    const unknown = await both(`${TAG} Never Existed`);
    ok(unknown.lookup === false && unknown.checkW9 === false, 'both say no');
    ok(unknown.agree, 'they agree');

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\nfixture aborted:', err.message);
    fail++;
  } finally {
    await cleanup();
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
