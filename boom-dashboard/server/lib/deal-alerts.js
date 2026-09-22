// The CEO's dashboard alerts (2026-09-22): four questions asked of every signed
// artist, answered from the contract terms (lib/contract-terms.js) and the
// releases. One computation, three readers:
//   · Flags detectors (hourly register rows, page /artists or /contracts)
//   · GET /dashboard/alerts (the Home "Alerts" panel)
//   · the notifier job `deal_alerts` (emails the A&R owner + the always-to
//     address; release gap every 60 days while it persists, option expiry at
//     90 · 60 · 30 days — each sent once per artist per threshold, mail_jobs
//     is the memory)
//
//   release_gap        signed artist, no release in RELEASE_GAP_DAYS (60)
//   option_expiring    current period ends within 90 days (options left or not)
//   deliverable_due    deliverables remaining and the period ends within 90 days
//   advance_triggered  the advance expense on a signing was created in the last 30 days, or is due
const pool = require('../db');
const { withTerms } = require('./contract-terms');

const RELEASE_GAP_DAYS = 60;
const OPTION_THRESHOLDS = [90, 60, 30];
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

// Every active contract with its terms, the artist, the deal's owner, and the artist's releases.
async function context() {
  const { rows: cs } = await pool.query(
    `SELECT c.*, a.name AS artist_name, a.signed_at, d.owner_id, u.name AS owner_name, u.email AS owner_email
       FROM contracts c JOIN artists a ON a.id = c.artist_id
       LEFT JOIN deals d ON d.id = COALESCE(c.deal_id, a.signed_deal_id)
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE c.status = 'Active' AND (a.archived = false OR a.archived IS NULL)`).catch(() => ({ rows: [] }));
  const contracts = await withTerms(cs);
  const artistIds = [...new Set(contracts.map((c) => c.artist_id))];
  const { rows: rels } = artistIds.length ? await pool.query(`SELECT artist_id, MAX(release_date) AS last_release, COUNT(*)::int AS n FROM releases WHERE artist_id = ANY($1) AND (archived = false OR archived IS NULL) AND release_date IS NOT NULL AND release_date <= CURRENT_DATE GROUP BY artist_id`, [artistIds]) : { rows: [] };
  const lastBy = new Map(rels.map((r) => [r.artist_id, r]));
  const { rows: advances } = artistIds.length ? await pool.query(
    `SELECT e.id, e.amount, e.currency, e.payment_status, e.scheduled_payment_date, e.created_at, d.signed_artist_id AS artist_id, d.artist_name
       FROM deals d JOIN expenses e ON e.id = d.advance_expense_id
      WHERE d.signed_artist_id = ANY($1) AND (e.deleted = false OR e.deleted IS NULL)`, [artistIds]).catch(() => ({ rows: [] })) : { rows: [] };
  return { contracts, lastBy, advances };
}

// The alerts, as flat rows: { kind, key, artist_id, artist, title, detail, severity, to, owner_id, owner_email, days, contract_id }
async function alerts() {
  const { contracts, lastBy, advances } = await context();
  const out = [];
  const seenArtist = new Set();
  for (const c of contracts) {
    const t = c.terms; const base = { artist_id: c.artist_id, artist: c.artist_name, owner_id: c.owner_id, owner_email: c.owner_email, owner_name: c.owner_name, contract_id: c.id };
    // release gap — once per artist
    if (!seenArtist.has(c.artist_id)) {
      seenArtist.add(c.artist_id);
      const last = lastBy.get(c.artist_id);
      const since = last?.last_release ? daysSince(last.last_release) : (c.date_signed ? daysSince(c.date_signed) : null);
      if (since !== null && since >= RELEASE_GAP_DAYS) {
        out.push({ ...base, kind: 'release_gap', key: String(c.artist_id), days: since, severity: since >= RELEASE_GAP_DAYS * 2 ? 'high' : 'medium', to: `/artists/${c.artist_id}`,
          title: `${c.artist_name}: no release in ${Math.floor(since / 30)} month${Math.floor(since / 30) === 1 ? '' : 's'}`,
          detail: last?.last_release ? `last release ${day(last.last_release)} · ${t.remaining ?? '?'} deliverable${t.remaining === 1 ? '' : 's'} remaining` : `nothing released since signing ${day(c.date_signed) || ''}` });
      }
    }
    // option / period expiry
    if (t.days_to_period_end !== null && t.days_to_period_end <= 90) {
      const past = t.days_to_period_end < 0;
      out.push({ ...base, kind: 'option_expiring', key: String(c.id), days: t.days_to_period_end, severity: past || t.days_to_period_end <= 30 ? 'high' : 'medium', to: `/contracts?focus=${c.id}`,
        title: past ? `${c.artist_name}: contract period ended ${-t.days_to_period_end}d ago` : `${c.artist_name}: ${t.options_remaining ? 'option' : 'contract'} period ends in ${t.days_to_period_end} days`,
        detail: `${c.type} · period ${t.current_period}${t.options_total !== null ? ` of ${1 + t.options_total}` : ''} ends ${t.period_end}${t.options_remaining ? ` · ${t.options_remaining} option${t.options_remaining === 1 ? '' : 's'} left to exercise` : ' · no options left'}` });
    }
    // deliverables due
    if (t.deliverables_total !== null && t.remaining > 0 && t.days_to_period_end !== null && t.days_to_period_end <= 90) {
      out.push({ ...base, kind: 'deliverable_due', key: String(c.id), days: t.days_to_period_end, severity: t.days_to_period_end <= 30 ? 'high' : 'medium', to: `/artists/${c.artist_id}`,
        title: `${c.artist_name}: ${t.remaining} of ${t.deliverables_total} deliverable${t.deliverables_total === 1 ? '' : 's'} still owed`,
        detail: `${t.delivered} delivered${t.scheduled ? `, ${t.scheduled} scheduled` : ''} · period ends ${t.period_end}` });
    }
  }
  // advance triggered — booked in the last 30 days, or due and unpaid
  for (const a of advances) {
    const age = daysSince(a.created_at);
    const due = a.scheduled_payment_date && day(a.scheduled_payment_date) <= day(new Date()) && a.payment_status !== 'Paid';
    if ((age !== null && age <= 30) || due) {
      const c = contracts.find((x) => x.artist_id === a.artist_id);
      out.push({ kind: 'advance_triggered', key: String(a.id), artist_id: a.artist_id, artist: a.artist_name, owner_id: c?.owner_id, owner_email: c?.owner_email, owner_name: c?.owner_name, contract_id: c?.id, days: age, severity: due ? 'high' : 'medium', to: '/bk/payments',
        title: `${a.artist_name}: advance ${a.payment_status === 'Paid' ? 'paid' : due ? 'DUE and unpaid' : 'booked, unpaid'} — $${Number(a.amount).toLocaleString('en-US')}`,
        detail: a.scheduled_payment_date ? `due ${day(a.scheduled_payment_date)}` : `booked ${day(a.created_at)}` });
    }
  }
  return out;
}

// Who hears about it: the deal's owner, plus the label's always-to address(es).
async function recipients(alert) {
  const { rows: [l] } = await pool.query('SELECT alerts_to FROM label_settings WHERE id = 1').catch(() => ({ rows: [] }));
  const always = String(l?.alerts_to || '').split(/[,\s]+/).filter((e) => /@/.test(e));
  const emails = new Set(always.map((e) => e.toLowerCase()));
  if (alert.owner_email) emails.add(alert.owner_email.toLowerCase());
  if (!emails.size) return [];
  const { rows } = await pool.query('SELECT id, name, email FROM users WHERE LOWER(email) = ANY($1)', [[...emails]]);
  // an always-to address that is not a user still gets the mail
  const known = new Set(rows.map((r) => r.email.toLowerCase()));
  for (const e of emails) if (!known.has(e)) rows.push({ id: null, name: e, email: e });
  return rows;
}

// The emails: each (artist · alert · threshold) once, remembered in mail_jobs.
// Release gap fires at 60, 120, 180… days; option expiry at 90/60/30 days out;
// deliverables due at 90/30; an advance once when booked.
async function dueEmails() {
  const list = await alerts();
  const jobs = [];
  for (const a of list) {
    if (a.kind === 'release_gap') { const bucket = Math.floor(a.days / RELEASE_GAP_DAYS); if (bucket >= 1) jobs.push({ alert: a, period: `${a.key}:${bucket}` }); }
    else if (a.kind === 'option_expiring') { const th = [...OPTION_THRESHOLDS].sort((x, y) => x - y).find((x) => a.days <= x); /* the TIGHTEST threshold passed: 25 days out is the 30-day mail, not the 90 */ if (th && a.days >= 0) jobs.push({ alert: a, period: `${a.key}:${th}` }); else if (a.days < 0) jobs.push({ alert: a, period: `${a.key}:ended` }); }
    else if (a.kind === 'deliverable_due') { const th = [30, 90].find((x) => a.days <= x); if (th) jobs.push({ alert: a, period: `${a.key}:${th}` }); }
    else if (a.kind === 'advance_triggered') jobs.push({ alert: a, period: `${a.key}:booked` });
  }
  return jobs;
}

module.exports = { alerts, recipients, dueEmails, RELEASE_GAP_DAYS, OPTION_THRESHOLDS };
