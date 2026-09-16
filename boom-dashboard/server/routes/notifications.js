const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications
router.get('/', authMiddleware, async (req, res) => {
  try {
    const CHECKLIST_KEYS = [
      'yt_video','content','marketing_plan','official_thread',
      'uploaded','recoup_added','budget',
      'stem_pitch','s4a_pitch','amazon_pitch','pandora','marquee','dsp_email',
      'musixmatch'
    ];
    const total = CHECKLIST_KEYS.length;

    // Upcoming releases in the next 14 days with at least one checklist item incomplete
    const releasesResult = await pool.query(`
      SELECT r.id, r.project_name, r.release_date, r.priority,
             a.name as artist_name,
             (CURRENT_DATE - r.release_date::date) * -1 AS days_until,
             ${CHECKLIST_KEYS.map(k => `COALESCE(r.${k}, false) as ${k}`).join(', ')}
      FROM releases r
      JOIN artists a ON r.artist_id = a.id
      WHERE (r.archived = false OR r.archived IS NULL)
        AND r.release_date >= CURRENT_DATE
        AND r.release_date <= CURRENT_DATE + INTERVAL '14 days'
      ORDER BY r.release_date ASC
    `);

    const upcomingReleases = releasesResult.rows
      .map(r => {
        const done = CHECKLIST_KEYS.filter(k => r[k]).length;
        const pct = Math.round((done / total) * 100);
        return { ...r, completion: pct, done, total }
      })
      .filter(r => r.completion < 100);

    // Contracts expiring within 90 days. Hide from non-admin users since
    // contract data is admin-only across the app.
    const userRole = (req.user?.role || '').toLowerCase();
    const canSeeContracts = userRole === 'admin' || userRole === 'superadmin' || userRole === 'approver';
    const contractsResult = canSeeContracts
      ? await pool.query(`
          SELECT c.id, c.type, c.expiration_date,
                 a.name as artist_name, a.id as artist_id,
                 (c.expiration_date - CURRENT_DATE) AS days_until_expiry
          FROM contracts c
          JOIN artists a ON c.artist_id = a.id
          WHERE c.expiration_date IS NOT NULL
            AND c.expiration_date >= CURRENT_DATE
            AND c.expiration_date <= CURRENT_DATE + INTERVAL '90 days'
            AND c.status = 'Active'
          ORDER BY c.expiration_date ASC
        `)
      : { rows: [] };

    // Budget alerts: artists at >= 80% of their budget
    const budgetAlertsResult = await pool.query(`
      SELECT a.id, a.name as artist_name, ab.amount as budget,
             COALESCE(
               (SELECT SUM(me.amount) FROM manual_expenses me WHERE me.artist_id = a.id), 0
             ) as manual_total
      FROM artists a
      JOIN artist_budgets ab ON ab.artist_id = a.id
      WHERE ab.amount > 0
      ORDER BY a.name ASC
    `);

    const budgetAlerts = budgetAlertsResult.rows
      .map(r => ({
        ...r,
        budget: parseFloat(r.budget),
        manual_total: parseFloat(r.manual_total),
        pct_used: Math.round((parseFloat(r.manual_total) / parseFloat(r.budget)) * 100),
      }))
      .filter(r => r.pct_used >= 80);

    // ── SMART ALERTS ──────────────────────────────────────────────────────
    const smartAlerts = [];

    // 1. Contract expiring + unreleased tracks → consider renewal
    for (const c of contractsResult.rows) {
      try {
        const unreleased = await pool.query(`
          SELECT COUNT(*) as count FROM releases
          WHERE artist_id = $1
            AND (archived = false OR archived IS NULL)
            AND (release_date IS NULL OR release_date > CURRENT_DATE)
        `, [c.artist_id]);
        const unreleasedCount = parseInt(unreleased.rows[0].count);
        if (unreleasedCount > 0) {
          smartAlerts.push({
            id: `smart-contract-${c.id}`,
            type: 'contract_renewal',
            severity: parseInt(c.days_until_expiry) <= 30 ? 'high' : 'medium',
            title: `${c.artist_name}'s contract expires in ${c.days_until_expiry} days and they have ${unreleasedCount} unreleased track${unreleasedCount !== 1 ? 's' : ''} — consider renewal`,
            artist_name: c.artist_name,
            artist_id: c.artist_id,
            days: parseInt(c.days_until_expiry),
          });
        }
      } catch { /* skip */ }
    }

    // 2. Release very close with low checklist → flag to team
    for (const r of releasesResult.rows) {
      const done = CHECKLIST_KEYS.filter(k => r[k]).length;
      const pct = Math.round((done / total) * 100);
      const daysUntil = parseInt(r.days_until);
      if (daysUntil <= 7 && pct < 50) {
        smartAlerts.push({
          id: `smart-release-${r.id}`,
          type: 'release_behind',
          severity: daysUntil <= 3 ? 'critical' : 'high',
          title: `${r.project_name} is ${daysUntil} day${daysUntil !== 1 ? 's' : ''} out with only ${pct}% checklist complete — flag to team`,
          artist_name: r.artist_name,
          release_id: r.id,
          days: daysUntil,
          completion: pct,
        });
      }
    }

    // 3. Budget nearly spent with significant contract time remaining
    for (const b of budgetAlerts) {
      try {
        const contractTime = await pool.query(`
          SELECT c.expiration_date,
                 (c.expiration_date - CURRENT_DATE) AS days_remaining
          FROM contracts c
          JOIN artists a ON c.artist_id = a.id
          WHERE a.id = $1 AND c.status = 'Active'
            AND c.expiration_date > CURRENT_DATE
          ORDER BY c.expiration_date DESC LIMIT 1
        `, [b.id]);
        if (contractTime.rows.length > 0) {
          const daysRemaining = parseInt(contractTime.rows[0].days_remaining);
          const monthsRemaining = Math.round(daysRemaining / 30);
          if (monthsRemaining >= 2) {
            smartAlerts.push({
              id: `smart-budget-${b.id}`,
              type: 'budget_burn',
              severity: b.pct_used >= 95 ? 'critical' : 'high',
              title: `${b.artist_name}'s budget is ${b.pct_used}% spent with ${monthsRemaining} month${monthsRemaining !== 1 ? 's' : ''} left on contract — review spending`,
              artist_name: b.artist_name,
              artist_id: b.id,
              pct_used: b.pct_used,
              months_remaining: monthsRemaining,
            });
          }
        }
      } catch { /* skip */ }
    }

    // 4. Overdue tasks
    try {
      const overdue = await pool.query(`
        SELECT t.id, t.description, t.due_date, t.priority,
               u.name as assignee_name,
               (CURRENT_DATE - t.due_date) AS days_overdue
        FROM tasks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.due_date < CURRENT_DATE
          AND t.status != 'Done'
        ORDER BY t.due_date ASC
        LIMIT 5
      `);
      for (const t of overdue.rows) {
        const daysOver = parseInt(t.days_overdue);
        smartAlerts.push({
          id: `smart-overdue-${t.id}`,
          type: 'task_overdue',
          severity: daysOver >= 7 ? 'high' : 'medium',
          title: `"${t.description}" is ${daysOver} day${daysOver !== 1 ? 's' : ''} overdue${t.assignee_name ? ` — assigned to ${t.assignee_name}` : ''}`,
          task_id: t.id,
          days: daysOver,
          priority: t.priority,
        });
      }
    } catch { /* skip */ }

    // 5. Releases with no assigned team member
    try {
      const unassigned = await pool.query(`
        SELECT r.id, r.project_name, r.release_date, a.name as artist_name,
               (r.release_date - CURRENT_DATE) AS days_until
        FROM releases r
        JOIN artists a ON r.artist_id = a.id
        WHERE r.assigned_to IS NULL
          AND (r.archived = false OR r.archived IS NULL)
          AND r.release_date >= CURRENT_DATE
          AND r.release_date <= CURRENT_DATE + INTERVAL '30 days'
        ORDER BY r.release_date ASC
        LIMIT 5
      `);
      for (const r of unassigned.rows) {
        smartAlerts.push({
          id: `smart-unassigned-${r.id}`,
          type: 'release_unassigned',
          severity: parseInt(r.days_until) <= 7 ? 'high' : 'medium',
          title: `${r.project_name} drops in ${r.days_until} days with no team member assigned`,
          artist_name: r.artist_name,
          release_id: r.id,
          days: parseInt(r.days_until),
        });
      }
    } catch { /* skip */ }

    // 6. Rush-payment requests — surfaced for everyone (so the team sees
    //    what's been flagged), with critical severity so it sorts to the top.
    try {
      const rushRes = await pool.query(`
        SELECT id, payee, vendor_name, amount, currency, invoice_number, artist,
               rush_requested_at, rush_requested_by, rush_reason
          FROM expenses
         WHERE rush_requested = TRUE
           AND payment_status IS DISTINCT FROM 'Paid'
           AND (deleted = false OR deleted IS NULL)
         ORDER BY rush_requested_at DESC
         LIMIT 20
      `);
      for (const r of rushRes.rows) {
        const amt = `${r.currency || 'USD'} ${Number(r.amount || 0).toFixed(2)}`;
        const who = r.rush_requested_by || 'A user';
        const why = r.rush_reason ? ` — "${r.rush_reason}"` : '';
        smartAlerts.push({
          id: `smart-rush-${r.id}`,
          type: 'payment_rush',
          severity: 'critical',
          title: `${who} requested a rush payment for ${r.payee || r.vendor_name || 'a vendor'} (${amt})${why}`,
          payee: r.payee || r.vendor_name,
          amount: r.amount,
          currency: r.currency,
          invoice_number: r.invoice_number,
          artist: r.artist,
          requested_by: r.rush_requested_by,
          requested_at: r.rush_requested_at,
          reason: r.rush_reason,
          entry_id: r.id,
        });
      }
    } catch { /* skip */ }

    // 7. Pending vendor submissions (admin-only notification)
    let vendorSubmissions = [];
    if (req.user.role === 'Admin' || req.user.role === 'Superadmin') {
      try {
        const vendorResult = await pool.query(`
          SELECT id, payee, vendor_name, vendor_email, amount, currency,
                 invoice_number, artist, created_at
          FROM expenses
          WHERE vendor_submitted = true
            AND status = 'pending'
            AND (deleted = false OR deleted IS NULL)
          ORDER BY created_at DESC
          LIMIT 20
        `);
        vendorSubmissions = vendorResult.rows;
      } catch { /* skip */ }
    }

    // 8. Stalled bulk deals — money has gone out, the deal is still
    // under-delivered, and nothing has been delivered in 30+ days.
    // Deals with no completions yet get a 30-day grace window from
    // invoice_date so fresh signings don't false-alarm.
    try {
      const STALL_DAYS = 30;
      const { rows: bulkRows } = await pool.query(`
        SELECT e.id, e.payee, e.invoice_date, e.bulk_deal_quantity, e.bulk_deal_unit,
               (e.amount + COALESCE(ch.child_total, 0))::float AS total,
               COALESCE(bd.delivered, 0)::int AS delivered,
               COALESCE(bd.items_total, 0)::int AS items_total,
               bd.last_delivery_at,
               COALESCE(ip.paid, 0)::float AS installments_paid,
               COALESCE(ip.n, 0)::int AS installment_count,
               (CASE WHEN e.payment_status = 'Paid' THEN e.amount ELSE 0 END
                 + COALESCE(ch.paid_child_total, 0))::float AS status_paid_total
        FROM expenses e
        LEFT JOIN (
          SELECT expense_id, COUNT(*) AS items_total,
                 COUNT(*) FILTER (WHERE completed) AS delivered,
                 MAX(completed_at) AS last_delivery_at
          FROM bulk_deal_items GROUP BY expense_id
        ) bd ON bd.expense_id = e.id
        LEFT JOIN (
          SELECT parent_id, SUM(amount) AS child_total,
                 SUM(amount) FILTER (WHERE payment_status = 'Paid') AS paid_child_total
          FROM expenses WHERE parent_id IS NOT NULL
            AND (deleted = false OR deleted IS NULL) AND (voided = false OR voided IS NULL)
          GROUP BY parent_id
        ) ch ON ch.parent_id = e.id
        LEFT JOIN (
          SELECT expense_id, SUM(amount) AS paid, COUNT(*) AS n
          FROM expense_payments GROUP BY expense_id
        ) ip ON ip.expense_id = e.id
        WHERE e.is_bulk_deal = true
          AND (e.bulk_deal_completed = false OR e.bulk_deal_completed IS NULL)
          AND (e.deleted = false OR e.deleted IS NULL)
          AND (e.voided = false OR e.voided IS NULL)
          AND e.status = 'approved' AND e.parent_id IS NULL
      `);
      for (const r of bulkRows) {
        const total = Number(r.total) || 0;
        const paid = Number(r.installment_count) > 0 ? Number(r.installments_paid) : Number(r.status_paid_total);
        if (!(paid > 0)) continue;
        const contracted = Math.max(Number(r.bulk_deal_quantity) || 0, Number(r.items_total) || 0);
        if (contracted > 0 && Number(r.delivered) >= contracted) continue;
        const anchor = r.last_delivery_at || r.invoice_date;
        if (!anchor) continue;
        const days = Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000);
        if (days < STALL_DAYS) continue;
        const paidPct = total > 0 ? Math.round((Math.min(paid, total) / total) * 100) : 0;
        smartAlerts.push({
          type: 'bulk_deal_stalled',
          severity: 'high',
          title: `Bulk deal with ${r.payee || 'a vendor'} looks stalled — ${paidPct}% paid, ${r.delivered}/${contracted || '?'} ${r.bulk_deal_unit || 'deliverables'} received, nothing new in ${days} days`,
          payee: r.payee,
          entry_id: r.id,
          days_stalled: days,
          paid_pct: paidPct,
          delivered: Number(r.delivered) || 0,
          contracted,
        });
      }
    } catch { /* skip */ }

    // Sort smart alerts by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    smartAlerts.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

    // Unread @mentions (campaign chat). Persisted rows, unlike the
    // computed alerts above — a mention survives until seen.
    let mentions = [];
    try {
      const { rows } = await pool.query(`
        SELECT id, actor_name, room, room_title, room_path, snippet, created_at
        FROM user_mentions
        WHERE user_id = $1 AND read = FALSE
        ORDER BY id DESC
        LIMIT 30
      `, [req.user.id]);
      mentions = rows;
    } catch { /* table may not exist yet on first boot */ }

    // Due personal reminders — persisted, cleared per-item via Done (which
    // advances next_due), so like mentions they survive clear-all.
    let reminders = [];
    try {
      const { rows } = await pool.query(`
        SELECT id, title, link, next_due, cadence
        FROM reminders
        WHERE user_id = $1 AND active = true AND next_due <= CURRENT_DATE
        ORDER BY next_due, id LIMIT 20
      `, [req.user.id]);
      reminders = rows;
    } catch { /* table may not exist yet on first boot */ }

    const total_count = upcomingReleases.length + contractsResult.rows.length + budgetAlerts.length + smartAlerts.length + vendorSubmissions.length + mentions.length + reminders.length;

    res.json({
      success: true,
      data: {
        total_count,
        releases: upcomingReleases,
        contracts: contractsResult.rows,
        budget_alerts: budgetAlerts,
        smart_alerts: smartAlerts,
        vendor_submissions: vendorSubmissions,
        mentions,
        reminders,
      }
    });
  } catch (error) {
    console.error('Notifications error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/notifications/mentions/read — mark mentions read. Body
// { ids: [] } marks specific rows; omitted/empty marks ALL of mine.
router.post('/mentions/read', authMiddleware, async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    if (ids.length) {
      await pool.query(`UPDATE user_mentions SET read = TRUE WHERE user_id = $1 AND id = ANY($2::int[])`, [req.user.id, ids]);
    } else {
      await pool.query(`UPDATE user_mentions SET read = TRUE WHERE user_id = $1`, [req.user.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/notifications/mentions/read:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
