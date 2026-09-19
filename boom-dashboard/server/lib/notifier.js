// Notification preferences, made real (stage 4 of the mail plan).
//
// Runs once an hour. Each timed job has a PERIOD key (a date, or a date+week)
// and a row in mail_jobs when it has run, so a redeploy in the same hour never
// sends the digest twice. Everything goes through the Team purpose; when that
// is not connected the tick does nothing and says so once.
//
//   approvals_waiting   daily 09:00 LA, to people with the pref, when the queue is not empty
//   payments_due        Mondays 09:00 LA, what is due in the next 7 days
//   renewals_coming     daily 09:00 LA, contracts that ENTERED the 90-day window since yesterday
//   weekly_digest       Fridays 16:00 LA: the loop's counts
//   tasks_assigned      immediate, from routes/team.js (notifyAssigned below)
const pool = require('../db');
const mail = require('./mail');

const APP_URL = process.env.FRONTEND_URL || 'https://marketst-production.up.railway.app';
const laParts = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, weekday: g('weekday') };
};
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0);
const wrap = (title, body) => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;"><div style="background:#334155;padding:18px 26px;border-radius:12px 12px 0 0;"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,.7);text-transform:uppercase;">Market Street</p><h1 style="margin:6px 0 0;font-size:18px;color:#fff;">${title}</h1></div><div style="background:#f9f9f9;padding:24px 26px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;font-size:14px;color:#333;line-height:1.55;">${body}</div></div>`;

async function subscribers(pref) {
  const { rows } = await pool.query(`SELECT id, name, email FROM users WHERE email IS NOT NULL AND (notification_prefs->>$1)::boolean IS TRUE`, [pref]);
  return rows;
}
async function claim(job, period) {
  const { rowCount } = await pool.query('INSERT INTO mail_jobs (job, period) VALUES ($1, $2) ON CONFLICT DO NOTHING', [job, period]);
  return rowCount === 1;
}
async function sendTo(users, kind, subject, html) {
  let n = 0;
  for (const u of users) {
    try { await mail.sendMail({ kind, purpose: 'team', to: u.email, subject, html, entity: { type: 'notification', id: kind } }); n += 1; }
    catch (e) { console.warn(`[notify] ${kind} to ${u.email} failed:`, e.message); }
  }
  return n;
}

const JOBS = {
  approvals_waiting: {
    when: ({ hour }) => hour === 9, period: ({ date }) => date,
    run: async () => {
      const users = await subscribers('approvals_waiting'); if (!users.length) return 0;
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM expenses WHERE status = 'pending' AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL) AND parent_id IS NULL`);
      if (!rows[0].n) return 0;
      return sendTo(users, 'notification', `${rows[0].n} invoice${rows[0].n === 1 ? '' : 's'} waiting for approval`,
        wrap('Awaiting approval', `<p><strong>${rows[0].n}</strong> invoice${rows[0].n === 1 ? ' is' : 's are'} waiting, about ${usd(rows[0].total)} in total.</p><p><a href="${APP_URL}/bk/approvals">Open Approvals</a></p>`));
    },
  },
  payments_due: {
    when: ({ hour, weekday }) => hour === 9 && weekday === 'Mon', period: ({ date }) => date,
    run: async () => {
      const users = await subscribers('payments_due'); if (!users.length) return 0;
      const { rows } = await pool.query(`SELECT payee, amount, currency, scheduled_payment_date::date AS due FROM expenses WHERE status = 'approved' AND payment_status IS DISTINCT FROM 'Paid' AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL) AND parent_id IS NULL AND scheduled_payment_date ~ '^\\d{4}-\\d{2}-\\d{2}' AND scheduled_payment_date::date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY scheduled_payment_date`);
      if (!rows.length) return 0;
      const list = rows.slice(0, 25).map((r) => `<li>${String(r.due).slice(0, 10)} — ${r.payee} — ${usd(r.amount)}</li>`).join('');
      return sendTo(users, 'notification', `${rows.length} payment${rows.length === 1 ? '' : 's'} due this week`,
        wrap('Due this week', `<ul style="padding-left:18px;">${list}</ul>${rows.length > 25 ? `<p>…and ${rows.length - 25} more.</p>` : ''}<p><a href="${APP_URL}/bk/payments">Open Payments</a></p>`));
    },
  },
  renewals_coming: {
    when: ({ hour }) => hour === 9, period: ({ date }) => date,
    run: async () => {
      const users = await subscribers('renewals_coming'); if (!users.length) return 0;
      const { rows } = await pool.query(`SELECT c.type, c.expiration_date::text AS exp, a.name FROM contracts c JOIN artists a ON a.id = c.artist_id WHERE c.status = 'Active' AND c.expiration_date = CURRENT_DATE + INTERVAL '90 days'`);
      if (!rows.length) return 0;
      const list = rows.map((r) => `<li>${r.name} — ${r.type || 'contract'} — expires ${r.exp}</li>`).join('');
      return sendTo(users, 'notification', `${rows.length} contract${rows.length === 1 ? '' : 's'} expiring in 90 days`,
        wrap('Renewals coming', `<ul style="padding-left:18px;">${list}</ul><p><a href="${APP_URL}/renewals">Open Renewals</a></p>`));
    },
  },
  weekly_digest: {
    when: ({ hour, weekday }) => hour === 16 && weekday === 'Fri', period: ({ date }) => date,
    run: async () => {
      const users = await subscribers('weekly_digest'); if (!users.length) return 0;
      const q = async (sql) => (await pool.query(sql)).rows[0];
      const a = await q(`SELECT COUNT(*)::int AS n FROM expenses WHERE status = 'pending' AND (deleted = false OR deleted IS NULL) AND parent_id IS NULL`);
      const p = await q(`SELECT COUNT(*)::int AS n FROM expenses WHERE status = 'approved' AND payment_status IS DISTINCT FROM 'Paid' AND (deleted = false OR deleted IS NULL) AND parent_id IS NULL`);
      const paid = await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM expenses WHERE payment_status = 'Paid' AND payment_date >= CURRENT_DATE - 7 AND parent_id IS NULL`);
      const rel = await q(`SELECT COUNT(*)::int AS n FROM releases WHERE release_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 AND (archived = false OR archived IS NULL)`);
      const signed = await q(`SELECT COUNT(*)::int AS n FROM artists WHERE signed_at >= NOW() - INTERVAL '7 days'`);
      return sendTo(users, 'notification', 'Your week at Market Street',
        wrap('This week', `<ul style="padding-left:18px;"><li>${paid.n} payment${paid.n === 1 ? '' : 's'} made, ${usd(paid.total)}</li><li>${a.n} awaiting approval · ${p.n} approved and unpaid</li><li>${rel.n} release${rel.n === 1 ? '' : 's'} in the next 30 days</li><li>${signed.n} artist${signed.n === 1 ? '' : 's'} signed this week</li></ul><p><a href="${APP_URL}/">Open Home</a></p>`));
    },
  },
};

let warnedOnce = false;
async function tick(now = new Date()) {
  const parts = laParts(now);
  if (!(await mail.isConnected('team'))) { if (!warnedOnce) { console.log('[notify] Team mail not connected; notifications wait.'); warnedOnce = true; } return {}; }
  const out = {};
  for (const [job, def] of Object.entries(JOBS)) {
    if (!def.when(parts)) continue;
    const period = def.period(parts);
    if (!(await claim(job, period))) continue;
    try { out[job] = await def.run(); } catch (e) { console.warn(`[notify] ${job} failed:`, e.message); }
  }
  return out;
}

// Immediate: a task assigned to somebody who asked to hear about it.
async function notifyAssigned({ assignee, assigner, description, priority, due_date }) {
  if (!assignee?.email || !assignee?.notification_prefs?.tasks_assigned) return false;
  if (!(await mail.isConnected('team'))) return false;
  const due = due_date ? ` · due ${String(due_date).slice(0, 10)}` : '';
  await mail.sendMail({ kind: 'task_assigned', purpose: 'team', to: assignee.email, subject: `New task from ${assigner}: ${String(description).slice(0, 60)}`,
    html: wrap('A task for you', `<p><strong>${assigner}</strong> assigned you: ${description}</p><p style="color:#666;">${priority || 'Medium'} priority${due}</p><p><a href="${APP_URL}/my-work">Open My Work</a></p>`), entity: { type: 'task' } });
  return true;
}

function start() {
  setTimeout(() => tick().catch(() => {}), 2 * 60 * 1000);
  setInterval(() => tick().catch(() => {}), 60 * 60 * 1000);
}

module.exports = { tick, start, notifyAssigned, JOBS, laParts };
