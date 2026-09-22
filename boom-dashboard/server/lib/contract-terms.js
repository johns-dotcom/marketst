// What a contract PROMISES, computed (2026-09-22, the CEO's list): deliverables
// total · delivered · remaining, options included · current period · period end,
// label and artist split, marketing budget, advance, term in years, and a
// signature status that follows DocuSign unless set by hand.
//
// Columns added to `contracts`:
//   num_releases (existing)     = total deliverables
//   options_total, options_exercised, term_years, marketing_budget, deal_id,
//   signature_status ('draft'|'sent'|'signed'|'fully_executed'), signature_status_manual
// `royalty_split` (existing) is the ARTIST's %; the label's is 100 − that.
// Columns added to `releases`: counts_toward_deal (default TRUE), ingested.
// Column added to `deals`: marketing_budget.
//
// Option periods are CONSECUTIVE terms (John's call): period 1 runs from the
// signing date for `term_years`; each exercised option adds another. The
// current period ends at signed + term × (1 + exercised); with no term the
// stored expiration_date stands. A release counts as ONE deliverable when it
// is the artist's, ticked `counts_toward_deal`, and its date has passed.
const pool = require('../db');

const SIG = ['draft', 'sent', 'signed', 'fully_executed'];

async function ensureSchema() {
  const run = (sql) => pool.query(sql).catch((e) => console.error('[contract-terms] schema:', e.message));
  for (const col of ['options_total INTEGER', 'options_exercised INTEGER NOT NULL DEFAULT 0', 'term_years NUMERIC(5,2)', 'marketing_budget NUMERIC(14,2)', 'deal_id INTEGER', "signature_status TEXT", 'signature_status_manual BOOLEAN NOT NULL DEFAULT FALSE']) await run(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${col}`);
  for (const col of ['counts_toward_deal BOOLEAN NOT NULL DEFAULT TRUE', 'ingested BOOLEAN']) await run(`ALTER TABLE releases ADD COLUMN IF NOT EXISTS ${col}`);
  await run('ALTER TABLE deals ADD COLUMN IF NOT EXISTS marketing_budget NUMERIC(14,2)');
}

const addYears = (d, years) => { const t = new Date(d); const whole = Math.floor(years); const months = Math.round((years - whole) * 12); t.setUTCFullYear(t.getUTCFullYear() + whole); t.setUTCMonth(t.getUTCMonth() + months); return t; };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysUntil = (d) => (d ? Math.round((new Date(d).getTime() - Date.now()) / 86400000) : null);

// Signature status from the newest envelope on the contract, unless set by hand.
function signatureFrom(c, env) {
  if (c.signature_status_manual && SIG.includes(c.signature_status)) return { status: c.signature_status, source: 'manual' };
  if (!env) return { status: SIG.includes(c.signature_status) ? c.signature_status : (c.date_signed ? 'fully_executed' : 'draft'), source: c.signature_status ? 'stored' : (c.date_signed ? 'date_signed' : 'none') };
  if (env.status === 'completed') return { status: 'fully_executed', source: 'docusign' };
  if (env.status === 'voided' || env.status === 'declined') return { status: 'draft', source: 'docusign' };
  if (env.signer_status === 'completed' || env.countersigner_status === 'completed') return { status: 'signed', source: 'docusign' };
  return { status: 'sent', source: 'docusign' };
}

// Attach the computed block to each contract row. One query for envelopes,
// one for deliverables, however many contracts.
async function withTerms(contracts) {
  if (!contracts.length) return contracts;
  const ids = contracts.map((c) => c.id);
  const artistIds = [...new Set(contracts.map((c) => c.artist_id).filter(Boolean))];
  const [{ rows: envs }, { rows: rels }] = await Promise.all([
    pool.query(`SELECT DISTINCT ON (doc_id) doc_id, status, signer_status, countersigner_status, sent_at, completed_at FROM signature_envelopes WHERE doc_type = 'contract' AND doc_id = ANY($1) ORDER BY doc_id, sent_at DESC`, [ids]).catch(() => ({ rows: [] })),
    pool.query(`SELECT id, artist_id, project_name, release_date::text AS release_date, counts_toward_deal, ingested FROM releases WHERE artist_id = ANY($1) AND (archived = false OR archived IS NULL) ORDER BY release_date`, [artistIds.length ? artistIds : [0]]).catch(() => ({ rows: [] })),
  ]);
  const envBy = new Map(envs.map((e) => [e.doc_id, e]));
  const today = day(new Date());
  return contracts.map((c) => {
    const mine = rels.filter((r) => r.artist_id === c.artist_id && r.counts_toward_deal !== false && (!c.date_signed || !r.release_date || r.release_date >= day(c.date_signed)));
    const delivered = mine.filter((r) => r.release_date && r.release_date <= today);
    const scheduled = mine.filter((r) => !r.release_date || r.release_date > today);
    const total = c.num_releases === null || c.num_releases === undefined ? null : Number(c.num_releases);
    const exercised = Number(c.options_exercised) || 0;
    const optionsTotal = c.options_total === null || c.options_total === undefined ? null : Number(c.options_total);
    const termYears = c.term_years === null || c.term_years === undefined ? null : Number(c.term_years);
    const periodEnd = c.date_signed && termYears ? day(addYears(c.date_signed, termYears * (1 + exercised))) : day(c.expiration_date);
    const sig = signatureFrom(c, envBy.get(c.id));
    const artistSplit = c.royalty_split === null || c.royalty_split === undefined ? null : Number(c.royalty_split);
    return {
      ...c,
      terms: {
        deliverables_total: total, delivered: delivered.length, remaining: total === null ? null : Math.max(0, total - delivered.length), scheduled: scheduled.length,
        deliverables: mine.map((r) => ({ id: r.id, project_name: r.project_name, release_date: r.release_date, delivered: !!(r.release_date && r.release_date <= today), ingested: r.ingested })),
        options_total: optionsTotal, options_exercised: exercised, options_remaining: optionsTotal === null ? null : Math.max(0, optionsTotal - exercised),
        current_period: 1 + exercised, period_end: periodEnd, days_to_period_end: daysUntil(periodEnd),
        artist_split: artistSplit, label_split: artistSplit === null ? null : Math.round((100 - artistSplit) * 100) / 100,
        marketing_budget: c.marketing_budget === null || c.marketing_budget === undefined ? null : Number(c.marketing_budget),
        advance: c.advance === null || c.advance === undefined ? null : Number(c.advance),
        term_years: termYears,
        signature: sig.status, signature_source: sig.source,
      },
    };
  });
}

// Exercise the next option: one more period of the term.
async function exerciseOption(id, user) {
  const { rows: [c] } = await pool.query('SELECT * FROM contracts WHERE id = $1', [id]);
  if (!c) throw Object.assign(new Error('Contract not found'), { status: 404 });
  const total = c.options_total === null ? null : Number(c.options_total);
  if (total !== null && Number(c.options_exercised) >= total) throw Object.assign(new Error('Every option is already exercised'), { status: 400 });
  const { rows: [out] } = await pool.query(
    `UPDATE contracts SET options_exercised = COALESCE(options_exercised, 0) + 1,
            expiration_date = CASE WHEN date_signed IS NOT NULL AND term_years IS NOT NULL THEN (date_signed + (term_years * 12 * (COALESCE(options_exercised, 0) + 2))::int * INTERVAL '1 month')::date ELSE expiration_date END
      WHERE id = $1 RETURNING *`, [id]);
  await pool.query(`INSERT INTO activity_log (user_id, action, detail, created_at) VALUES ($1, 'Exercised option', $2, NOW())`, [user?.id || null, `contract ${id} → period ${Number(out.options_exercised) + 1}`]).catch(() => {});
  return (await withTerms([out]))[0];
}

module.exports = { ensureSchema, withTerms, exerciseOption, SIG };
