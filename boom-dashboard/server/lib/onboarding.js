// Is this artist onboarded? — five questions answered from the TABLES, never
// from a stored tick, so the checklist cannot disagree with the pages it links
// to (the same stance as the Home loop and the Payments queue).
//
//   contract   an Active contract for the artist WITH a file attached
//   payment    payment details on file for the artist's email AND a W-9 held
//              for the payee (HAS_W9_SQL — the rule Approvals uses)
//   advance    the signing's advance invoice is Paid — or the deal carried no
//              advance, which is also "done" (there is nothing to pay)
//   budget     Advance and Total marketing both typed on the simple sheet
//   release    a release with a target date in the pipeline
//
// `onboarded_at` is stamped the first time every step answers yes, and never
// cleared: onboarding is a moment, not a state that can be un-happened.
const pool = require('../db');
const { artistBucketKey } = require('./artist-key');
const { HAS_W9_SQL } = require('./w9-owner');

const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0);
const enc = encodeURIComponent;

async function onboardingFor(artistId, q = pool) {
  const { rows: [a] } = await q.query(
    `SELECT id, name, email, signed_at, onboarded_at, signed_deal_id FROM artists WHERE id = $1`, [artistId]);
  if (!a) return null;
  const key = artistBucketKey(a.name);

  const [{ rows: [deal] }, { rows: [contract] }, { rows: [pay] }, { rows: [w9] }, { rows: budgetRows }, { rows: [release] }] = await Promise.all([
    q.query(`SELECT id, advance, advance_expense_id, deal_type, term_months, royalty_split, signed_at
               FROM deals WHERE signed_artist_id = $1 ORDER BY signed_at DESC NULLS LAST, id DESC LIMIT 1`, [a.id]),
    q.query(`SELECT c.id, c.type, c.expiration_date::text AS expiration_date,
                    (c.file_path IS NOT NULL OR EXISTS (SELECT 1 FROM entity_files ef WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id)) AS has_file
               FROM contracts c WHERE c.artist_id = $1 AND c.status = 'Active'
              ORDER BY (c.file_path IS NOT NULL OR EXISTS (SELECT 1 FROM entity_files ef WHERE ef.entity_type = 'contract' AND ef.entity_id = c.id)) DESC, c.id DESC LIMIT 1`, [a.id]),
    a.email
      ? q.query(`SELECT method, account_last4, holder_name, updated_at FROM vendor_payment_details WHERE LOWER(vendor_email) = LOWER($1)`, [a.email])
      : Promise.resolve({ rows: [] }),
    q.query(`SELECT 1 AS held FROM expenses x
              WHERE (LOWER(TRIM(x.payee)) = LOWER(TRIM($1)) OR ($2::text IS NOT NULL AND LOWER(x.vendor_email) = LOWER($2)))
                AND x.status IS DISTINCT FROM 'rejected' AND ${HAS_W9_SQL('x')} LIMIT 1`, [a.name, a.email || null]),
    q.query(`SELECT section, amount FROM artist_budget_sections WHERE artist_key = $1 AND section IN ('advance','marketing')`, [key]),
    q.query(`SELECT id, project_name, release_date::text AS release_date FROM releases
              WHERE artist_id = $1 AND release_date IS NOT NULL AND (archived = false OR archived IS NULL)
              ORDER BY release_date LIMIT 1`, [a.id]),
  ]);

  let advanceRow = null;
  if (deal?.advance_expense_id) {
    const r = await q.query(`SELECT id, amount, currency, payment_status, payment_date::text AS payment_date, scheduled_payment_date
                               FROM expenses WHERE id = $1`, [deal.advance_expense_id]);
    advanceRow = r.rows[0] || null;
  }
  const budget = Object.fromEntries(budgetRows.map((r) => [r.section, Number(r.amount) || 0]));
  const hasAdvance = deal && Number(deal.advance) > 0;

  const steps = [
    {
      key: 'contract', label: 'Contract on file',
      done: !!(contract && contract.has_file),
      detail: contract
        ? (contract.has_file ? `${contract.type || 'Contract'}${contract.expiration_date ? ` · to ${contract.expiration_date.slice(0, 4)}` : ''}` : `${contract.type || 'Contract'} saved, no file attached`)
        : 'No contract yet',
      to: contract ? '/contracts' : `/contracts?new=1&artist=${enc(a.name)}${deal ? `&deal=${deal.id}` : ''}`,
      to_label: contract ? (contract.has_file ? 'Open' : 'Attach the file') : 'Create the contract',
    },
    {
      key: 'payment', label: 'Payment details and W-9',
      done: !!(pay && w9),
      detail: !a.email ? "Add the artist's email first"
        : [pay ? `${pay.method}${pay.account_last4 ? ` · ending ${pay.account_last4}` : ''}` : 'No payment details', w9 ? 'W-9 held' : 'No W-9'].join(' · '),
      to: `/artists/${a.id}?tab=onboarding`, to_label: 'Send link or type in',
      on_file: !!pay, w9: !!w9, email: a.email || null,
    },
    {
      key: 'advance', label: 'Advance paid',
      done: !deal ? true : !hasAdvance ? true : !!(advanceRow && advanceRow.payment_status === 'Paid'),
      detail: !deal ? 'No deal record — nothing to pay from here'
        : !hasAdvance ? 'No advance on this deal'
        : !advanceRow ? `${money(deal.advance)} — invoice not created`
        : advanceRow.payment_status === 'Paid' ? `${money(advanceRow.amount)} paid ${advanceRow.payment_date || ''}`.trim()
        : `${money(advanceRow.amount)} due ${advanceRow.scheduled_payment_date || ''}`.trim(),
      to: '/bk/payments', to_label: 'Payments',
    },
    {
      key: 'budget', label: 'Budget set',
      done: (budget.advance || 0) > 0 && (budget.marketing || 0) > 0,
      detail: (budget.advance || budget.marketing)
        ? `${budget.advance ? money(budget.advance) : 'advance untyped'} · ${budget.marketing ? money(budget.marketing) : 'marketing untyped'}`
        : 'Nothing typed yet',
      to: `/artist-budgets/${enc(key)}?name=${enc(a.name)}`, to_label: 'Open the sheet',
    },
    {
      key: 'release', label: 'First release in the pipeline',
      done: !!release,
      detail: release ? `${release.project_name} · ${release.release_date}` : 'No release yet',
      to: release ? '/releases' : `/releases?add=1&artist=${enc(a.name)}`, to_label: release ? 'Open' : 'Add release',
    },
  ];
  const open = steps.filter((s) => !s.done).length;
  const complete = open === 0;
  let onboardedAt = a.onboarded_at;
  if (complete && !onboardedAt && a.signed_at) {
    const r = await q.query(`UPDATE artists SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = $1 RETURNING onboarded_at`, [a.id]);
    onboardedAt = r.rows[0]?.onboarded_at || null;
  }
  return {
    artist_id: a.id, name: a.name, email: a.email || null,
    signed_at: a.signed_at, onboarded_at: onboardedAt,
    deal: deal ? { id: deal.id, advance: deal.advance, deal_type: deal.deal_type, term_months: deal.term_months, royalty_split: deal.royalty_split } : null,
    steps, open, total: steps.length, complete,
  };
}

// Every artist mid-onboarding: signed, not yet complete. Small by nature (a
// label signs a handful a year), so one onboardingFor per artist is fine.
async function openOnboardings(q = pool) {
  const { rows } = await q.query(
    `SELECT id FROM artists WHERE signed_at IS NOT NULL AND onboarded_at IS NULL AND (archived = false OR archived IS NULL) ORDER BY signed_at DESC`);
  const out = [];
  for (const r of rows) {
    const o = await onboardingFor(r.id, q);
    if (o && !o.complete) out.push(o);
  }
  return out;
}

module.exports = { onboardingFor, openOnboardings };
