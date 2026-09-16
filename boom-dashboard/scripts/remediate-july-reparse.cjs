/**
 * One-off remediation: remove the phantom rows a re-parse added to the July 2026
 * BofA statement (id 25) on 2026-08-06, restoring it to its original 465 rows.
 *
 * Background: applyReparse used to test row identity with date + amount +
 * direction + DESCRIPTION. Description is parser output, so when the parser
 * changed, a re-parse judged all 498 rows new and inserted every one — 465 to
 * 963. The bug is fixed (lib/reparse-diff.js) and production has already proved
 * it: the re-parse at 17:26:45 reported added=0, parsed=436.
 *
 * The original 2026-08-04 batch is complete and correct — a reconciling
 * deterministic parse finds NOTHING it is missing — and it carries all 435
 * matches, 35 dismissals and 28 flags. So the original batch is kept untouched
 * and only the 2026-08-06 rows are removed.
 *
 * Three steps, each through an existing audited endpoint:
 *   1. undo-reparse protect=matched-only  → removes everything not holding a match
 *   2. unmatch the phantom rows that DO hold a match (they are duplicates; the
 *      real row for each is in the 08-04 batch, and the matcher will re-link it)
 *   3. undo-reparse again                 → removes those now-clean rows
 *
 * Safety:
 *   • Hard-coded to statement 25 and an explicit cutoff of 2026-08-05, which sits
 *     between the original upload (08-04) and the bad re-parse (08-06). The
 *     recorded reparse.at is NOT used — a later harmless re-parse overwrote it.
 *   • Aborts unless the dry run matches the diagnosis.
 *   • Never touches a row created before the cutoff.
 *   • Pass --dry to do nothing but report.
 *
 * Run:  node scripts/remediate-july-reparse.cjs scripts/.env [--dry]
 */
const fs = require('fs');

const ID = 25;
const SINCE = '2026-08-05T00:00:00.000Z';
const EXPECT_ORIGINAL = 465;
const DRY = process.argv.includes('--dry');

const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-production.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');

const die = (msg, code = 1) => { console.error(`\nABORTED: ${msg}\nNothing further was changed.`); process.exit(code); };

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('deployed commit:', health.commit, '| fast parse:', health.statement_fast_parse);

  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) die('login failed');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const rowsOf = async () => {
    const a = await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json();
    return (a.data?.transactions || []).filter((t) => t.statement_id === ID);
  };
  const undo = async (mode, dry) => {
    const r = await fetch(`${BASE}/api/statements/${ID}/undo-reparse?protect=${mode}&since=${SINCE}${dry ? '&dry=1' : ''}`,
      { method: 'POST', headers: H });
    const j = await r.json();
    if (!j.success) die(`undo-reparse(${mode}${dry ? ',dry' : ''}) failed: ${j.error}`);
    return j.data;
  };
  const report = (label, rows) => {
    const before = rows.filter((t) => t.created_at < SINCE);
    const after = rows.filter((t) => t.created_at >= SINCE);
    console.log(`${label}: ${rows.length} rows — original ${before.length}, phantom ${after.length}`);
    return { before, after };
  };

  // ---- Baseline -----------------------------------------------------------
  let rows = await rowsOf();
  const base = report('\nbefore', rows);
  if (base.before.length !== EXPECT_ORIGINAL) {
    die(`expected ${EXPECT_ORIGINAL} rows predating ${SINCE}, found ${base.before.length}`);
  }

  // ---- Dry run -----------------------------------------------------------
  const dry = await undo('matched-only', true);
  console.log('dry run:', JSON.stringify(dry));
  if (dry.removable + dry.protected !== base.after.length) {
    die(`dry run covers ${dry.removable + dry.protected} rows but ${base.after.length} postdate the cutoff`);
  }
  if (DRY) {
    console.log(`\n--dry: would remove ${dry.removable}, then unmatch and remove ${dry.protected} more, leaving ${EXPECT_ORIGINAL}.`);
    return;
  }

  // ---- Step 1 ------------------------------------------------------------
  const p1 = await undo('matched-only', false);
  console.log('\nstep 1 (remove unmatched phantoms):', JSON.stringify(p1));

  // ---- Step 2 ------------------------------------------------------------
  rows = await rowsOf();
  const stuck = rows.filter((t) => t.created_at >= SINCE && (t.matched_expense_id || t.matched_income_id));
  console.log(`step 2: unmatching ${stuck.length} phantom rows still holding a match`);
  for (const t of stuck) {
    const r = await fetch(`${BASE}/api/statements/tx/${t.id}/match`, { method: 'DELETE', headers: H });
    if (!r.ok) console.warn(`  WARN could not unmatch tx ${t.id} (HTTP ${r.status}) — it will be left in place`);
  }

  // ---- Step 3 ------------------------------------------------------------
  const p3 = await undo('matched-only', false);
  console.log('step 3 (remove the rest):', JSON.stringify(p3));

  // ---- Verify ------------------------------------------------------------
  rows = await rowsOf();
  const end = report('\nafter', rows);
  const st = (r) => JSON.stringify({
    matched: r.filter((t) => t.matched_expense_id || t.matched_income_id).length,
    dismissed: r.filter((t) => t.dismissed).length,
    flagged: r.filter((t) => t.flagged).length,
  });
  console.log('original batch state:', st(end.before), '(expected matched 435, dismissed 35, flagged 28)');
  if (end.before.length !== EXPECT_ORIGINAL) console.error(`!! original batch changed size: ${end.before.length}`);
  if (end.after.length) console.error(`!! ${end.after.length} phantom rows remain: ${end.after.map((t) => t.id).join(', ')}`);
  else console.log('\nDONE — statement 25 is back to its original rows.');
})().catch((e) => die(e.message));
