// One ticker for the integrations, separate from lib/notifier.js on purpose:
// that tick returns early when the Team mailbox is disconnected, and these
// jobs must run regardless.
//
//   every 10 min  QuickBooks queue (lib/qbo.processQueue) · DocuSign envelope poll
//   daily 06:00 LA  artist stats refresh (Spotify Web API + Chartmetric), claimed
//                   once per day in integration_jobs so two instances never both run it
const pool = require('../db');

async function claim(job, period) {
  const { rowCount } = await pool.query('INSERT INTO integration_jobs (job, period) VALUES ($1, $2) ON CONFLICT DO NOTHING', [job, period]).catch(() => ({ rowCount: 0 }));
  return rowCount === 1;
}
const laParts = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
};

async function tick(now = new Date()) {
  const out = {};
  try { out.qbo = await require('./qbo').processQueue(); } catch (e) { console.warn('[integrations] qbo:', e.message); }
  try { out.docusign = await require('./docusign').pollEnvelopes(); } catch (e) { console.warn('[integrations] docusign:', e.message); }
  const { date, hour } = laParts(now);
  if (hour >= 6 && await claim('artist_stats', date)) {
    try {
      out.stats = await require('./artist-stats').refreshAll();
      await pool.query('UPDATE integration_jobs SET result = $3::jsonb WHERE job = $1 AND period = $2', ['artist_stats', date, JSON.stringify(out.stats)]).catch(() => {});
    } catch (e) { console.warn('[integrations] artist stats:', e.message); }
  }
  return out;
}

function start() {
  setTimeout(() => tick().catch(() => {}), 3 * 60 * 1000);
  setInterval(() => tick().catch(() => {}), 10 * 60 * 1000);
}

module.exports = { tick, start, claim, laParts };
