const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { pagesReachable } = require('../middleware/pagePermission');
const { openOnboardings } = require('../lib/onboarding');
const { usdOf } = require('../lib/usd');
const { expectedNext } = require('../lib/statement-integrity');

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { year, genre, format } = req.query;
    const selectedYear = year ? parseInt(year) : new Date().getFullYear();

    const artistsResult = await pool.query('SELECT COUNT(*) as count FROM artists');
    const releasesResult = await pool.query('SELECT COUNT(*) as count FROM releases');
    const teamResult = await pool.query('SELECT COUNT(*) as count FROM users');

    const upcomingResult = await pool.query(
      `SELECT COUNT(*) as count FROM releases
       WHERE release_date > CURRENT_DATE`
    );

    // Available years for the filter
    const yearsResult = await pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM release_date)::int as year
       FROM releases
       WHERE release_date IS NOT NULL
       ORDER BY year DESC`
    );

    // Available genres for the filter
    const genresResult = await pool.query(
      `SELECT DISTINCT genre FROM releases
       WHERE genre IS NOT NULL AND genre != ''
       ORDER BY genre`
    );

    // Available formats for the filter
    const formatsResult = await pool.query(
      `SELECT DISTINCT release_type FROM releases
       WHERE release_type IS NOT NULL AND release_type != ''
       ORDER BY release_type`
    );

    // Build WHERE clauses for filtered chart query
    const chartWhereParams = [];
    const chartWhereConditions = ['release_date IS NOT NULL', 'EXTRACT(YEAR FROM release_date) = $1'];
    chartWhereParams.push(selectedYear);

    if (genre) {
      chartWhereParams.push(genre);
      chartWhereConditions.push(`LOWER(TRIM(genre)) = LOWER(TRIM($${chartWhereParams.length}))`);
    }
    if (format) {
      chartWhereParams.push(format);
      chartWhereConditions.push(`LOWER(TRIM(release_type)) = LOWER(TRIM($${chartWhereParams.length}))`);
    }

    const chartWhere = chartWhereConditions.join(' AND ');

    // Releases per month for the selected year (filtered)
    const releasesByMonthResult = await pool.query(
      `SELECT
         TO_CHAR(release_date, 'Mon') as month,
         EXTRACT(MONTH FROM release_date)::int as month_num,
         COUNT(*) as releases
       FROM releases
       WHERE ${chartWhere}
       GROUP BY month, month_num
       ORDER BY month_num`,
      chartWhereParams
    );

    // Releases per month for the previous year (same filters)
    const prevYearParams = [...chartWhereParams];
    prevYearParams[0] = selectedYear - 1;
    const lastYearResult = await pool.query(
      `SELECT
         TO_CHAR(release_date, 'Mon') as month,
         EXTRACT(MONTH FROM release_date)::int as month_num,
         COUNT(*) as releases
       FROM releases
       WHERE ${chartWhere}
       GROUP BY month, month_num
       ORDER BY month_num`,
      prevYearParams
    );

    // Releases by genre (top genres — unfiltered, always shows full picture)
    const genreResult = await pool.query(
      `SELECT genre, COUNT(*) as count
       FROM releases
       WHERE genre IS NOT NULL AND genre != ''
       GROUP BY genre
       ORDER BY count DESC
       LIMIT 8`
    );

    // This week's releases
    const thisWeekResult = await pool.query(
      `SELECT r.project_name, a.name as artist_name, r.release_date
       FROM releases r
       JOIN artists a ON r.artist_id = a.id
       WHERE r.release_date >= date_trunc('week', CURRENT_DATE)
         AND r.release_date < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
       ORDER BY r.release_date`
    );

    // Next week's releases
    const nextWeekResult = await pool.query(
      `SELECT r.project_name, a.name as artist_name, r.release_date
       FROM releases r
       JOIN artists a ON r.artist_id = a.id
       WHERE r.release_date >= date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
         AND r.release_date < date_trunc('week', CURRENT_DATE) + INTERVAL '14 days'
       ORDER BY r.release_date`
    );

    const lastYearByMonth = {};
    lastYearResult.rows.forEach(r => { lastYearByMonth[r.month] = parseInt(r.releases); });

    // Build full 12-month array so chart always shows all months
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthDataMap = {};
    releasesByMonthResult.rows.forEach(r => { monthDataMap[r.month] = parseInt(r.releases); });

    const releasesByMonth = MONTHS.map(m => ({
      month: m,
      releases: monthDataMap[m] || 0,
      lastYear: lastYearByMonth[m] || 0,
    }));

    res.json({
      success: true,
      data: {
        totalArtists: parseInt(artistsResult.rows[0].count),
        totalReleases: parseInt(releasesResult.rows[0].count),
        upcomingReleases: parseInt(upcomingResult.rows[0].count),
        teamMembers: parseInt(teamResult.rows[0].count),
        selectedYear,
        availableYears: yearsResult.rows.map(r => r.year),
        availableGenres: genresResult.rows.map(r => r.genre),
        availableFormats: formatsResult.rows.map(r => r.release_type),
        releasesByMonth,
        releasesByGenre: genreResult.rows.map(r => ({ genre: r.genre, count: parseInt(r.count) })),
        thisWeek: thisWeekResult.rows,
        nextWeek: nextWeekResult.rows,
      },
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/dashboard/notifications
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = [];

    // Releases this week
    const thisWeekCount = await pool.query(
      `SELECT COUNT(*) as count FROM releases
       WHERE release_date >= date_trunc('week', CURRENT_DATE)
         AND release_date < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'`
    );
    const weekCount = parseInt(thisWeekCount.rows[0].count);
    if (weekCount > 0) {
      notifications.push({
        type: 'This Week',
        severity: 'info',
        message: `${weekCount} release${weekCount > 1 ? 's' : ''} dropping this week`,
      });
    }

    // Releases coming in the next 7 days with low checklist completion
    const lowCompletionResult = await pool.query(
      `SELECT r.id, r.project_name, a.name as artist_name, r.release_date,
        (r.yt_video::int + r.recoup_added::int + r.uploaded::int + r.stem_pitch::int +
         r.s4a_pitch::int + r.amazon_pitch::int + r.pandora::int + r.budget::int +
         r.marketing_plan::int + r.official_thread::int + r.marquee::int + r.content::int +
         r.dsp_email::int + r.musixmatch::int) as items_completed
       FROM releases r
       JOIN artists a ON r.artist_id = a.id
       WHERE r.release_date > CURRENT_DATE
         AND r.release_date <= CURRENT_DATE + INTERVAL '14 days'
       ORDER BY r.release_date`
    );

    lowCompletionResult.rows.forEach((release) => {
      const completion = Math.round((parseInt(release.items_completed) / 14) * 100);
      if (completion < 50) {
        notifications.push({
          type: 'Low Completion',
          severity: completion < 25 ? 'critical' : 'warning',
          message: `${release.artist_name} — "${release.project_name}" is ${completion}% complete (${release.release_date ? new Date(release.release_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'TBD'})`,
          releaseId: release.id,
        });
      }
    });

    // Upcoming releases missing key metadata (UPC, ISRC, Spotify URI)
    const missingMetaResult = await pool.query(
      `SELECT r.id, r.project_name, a.name as artist_name, r.release_date,
              r.upc, r.isrc, r.spotify_uri, r.presave_link
       FROM releases r
       JOIN artists a ON r.artist_id = a.id
       WHERE r.release_date > CURRENT_DATE
         AND r.release_date <= CURRENT_DATE + INTERVAL '30 days'
         AND (r.upc IS NULL OR r.isrc IS NULL OR r.spotify_uri IS NULL)
       ORDER BY r.release_date
       LIMIT 5`
    );

    missingMetaResult.rows.forEach((release) => {
      const missing = [];
      if (!release.upc) missing.push('UPC');
      if (!release.isrc) missing.push('ISRC');
      if (!release.spotify_uri) missing.push('Spotify URI');
      notifications.push({
        type: 'Missing Metadata',
        severity: 'warning',
        message: `${release.artist_name} — "${release.project_name}" missing ${missing.join(', ')}`,
        releaseId: release.id,
      });
    });

    // Expiring contracts (next 60 days). Admin-only; non-admins skip the
    // query entirely so contract metadata never reaches their dashboard.
    const userRole = (req.user?.role || '').toLowerCase();
    const canSeeContracts = userRole === 'admin' || userRole === 'superadmin' || userRole === 'approver';
    if (canSeeContracts) {
      const expiringResult = await pool.query(
        `SELECT c.id, a.name as artist_name, c.type,
                c.expiration_date,
                (c.expiration_date - CURRENT_DATE) as days_left
         FROM contracts c
         JOIN artists a ON c.artist_id = a.id
         WHERE c.expiration_date IS NOT NULL
           AND c.expiration_date > CURRENT_DATE
           AND c.expiration_date <= CURRENT_DATE + INTERVAL '60 days'
         ORDER BY c.expiration_date`
      );

      expiringResult.rows.forEach((contract) => {
        const days = parseInt(contract.days_left);
        notifications.push({
          type: 'Contract Expiring',
          severity: days <= 14 ? 'critical' : 'warning',
          message: `${contract.artist_name} ${contract.type} contract expires in ${days} day${days !== 1 ? 's' : ''}`,
          contractId: contract.id,
        });
      });
    }

    // Expiring admin docs (NDAs, compliance, etc.) — Admin/Superadmin only.
    // Restricted-confidentiality docs hidden from non-superadmins.
    const canSeeAdminDocs = userRole === 'admin' || userRole === 'superadmin';
    if (canSeeAdminDocs) {
      const adminDocExpiring = await pool.query(
        `SELECT id, title, category, expiration_date,
                (expiration_date - CURRENT_DATE) AS days_left
           FROM admin_documents
          WHERE expiration_date IS NOT NULL
            AND expiration_date > CURRENT_DATE
            AND expiration_date <= CURRENT_DATE + INTERVAL '60 days'
            AND (status IS NULL OR status NOT IN ('Archived', 'Expired'))
            ${userRole === 'superadmin' ? '' : "AND confidentiality <> 'Restricted'"}
          ORDER BY expiration_date ASC`
      );
      adminDocExpiring.rows.forEach((doc) => {
        const days = parseInt(doc.days_left);
        notifications.push({
          type: 'Admin Doc Expiring',
          severity: days <= 14 ? 'critical' : 'warning',
          message: `${doc.title} (${doc.category}) expires in ${days} day${days !== 1 ? 's' : ''}`,
          adminDocId: doc.id,
        });
      });
    }

    // Overdue tasks
    const overdueResult = await pool.query(
      `SELECT COUNT(*) as count FROM tasks
       WHERE status != 'Done'
         AND due_date < CURRENT_DATE`
    );

    const overdueCount = parseInt(overdueResult.rows[0].count);
    if (overdueCount > 0) {
      notifications.push({
        type: 'Overdue Tasks',
        severity: 'critical',
        message: `${overdueCount} overdue task${overdueCount > 1 ? 's' : ''} need attention`,
      });
    }

    // Pending distributor requests
    const pendingRequestsResult = await pool.query(
      `SELECT COUNT(*) as count FROM requests WHERE status = 'Pending'`
    );
    const pendingCount = parseInt(pendingRequestsResult.rows[0].count);
    if (pendingCount > 0) {
      notifications.push({
        type: 'Pending Requests',
        severity: 'info',
        message: `${pendingCount} distributor request${pendingCount > 1 ? 's' : ''} pending`,
      });
    }

    res.json({
      success: true,
      data: notifications,
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/dashboard/activity
router.get('/activity', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT al.*, u.name as user_name
       FROM activity_log al
       JOIN users u ON al.user_id = u.id
       ORDER BY al.created_at DESC
       LIMIT 50`
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// GET /api/dashboard/loop — the Home page's four tiles.
//
// The loop is: a vendor submits at /submit, somebody approves, somebody pays,
// the bank statement proves it, reports read from that. Each section below is
// one count and one dollar figure with one destination, and a section is
// NULL for anyone who could not open that destination — the tile then does
// not render. Gating is done HERE, with the same rules the page routes use
// (pagesReachable), so an A&R account never receives money figures it cannot
// click through to; the client's canView is a second gate, not the only one.
//
// One request instead of five. The Dashboard used to fan out to
// /dashboard/stats, /bk/pending-count, /team/my-work, /releases and a dead
// Flask summary endpoint on every load.
//
// Money is usdOf(amount, currency, locked rate) per row — the same helper
// every report uses — never a SUM over `amount` across currencies.
const LOOP_PAGES = {
  approvals: '/bk/approvals',
  payments:  '/bk/payments',
  bank:      '/bk/bank-matching',
  releases:  '/releases',
  onboarding: '/artists',
};
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const sumUsd = (rows) => round2(rows.reduce((t, r) => t + (usdOf(r.amount, r.currency, r.fx_rate_to_usd) || 0), 0));

router.get('/loop', authMiddleware, async (req, res) => {
  try {
    const reach = await pagesReachable(req.user, Object.values(LOOP_PAGES));
    const data = { approvals: null, payments: null, bank: null, releases: null, onboarding: null };
    const jobs = [];

    // Awaiting approval — the same predicate as /bk/pending-count and the
    // Approvals queue: pending, not deleted, not voided, family roots only.
    if (reach.has(LOOP_PAGES.approvals)) jobs.push((async () => {
      const { rows } = await pool.query(
        `SELECT amount, currency, fx_rate_to_usd, created_at FROM expenses
          WHERE status = 'pending'
            AND (deleted = false OR deleted IS NULL)
            AND (voided = false OR voided IS NULL)
            AND parent_id IS NULL`
      );
      const oldest = rows.reduce((d, r) => (r.created_at && (!d || r.created_at < d)) ? r.created_at : d, null);
      data.approvals = {
        count: rows.length,
        usd: sumUsd(rows),
        oldest_days: oldest ? Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000)) : null,
        to: LOOP_PAGES.approvals,
      };
    })());

    // Due this week — approved, unpaid, not on hold, family roots, due within
    // seven days or already overdue. scheduled_payment_date is TEXT, so only
    // rows that carry a real ISO day are compared; a free-text date is not a
    // deadline the queue can act on.
    if (reach.has(LOOP_PAGES.payments)) jobs.push((async () => {
      const { rows } = await pool.query(
        `SELECT amount, currency, fx_rate_to_usd,
                COALESCE(rush_requested, false) AS rush,
                (scheduled_payment_date::date < CURRENT_DATE) AS overdue
           FROM expenses
          WHERE status = 'approved'
            AND payment_status IS DISTINCT FROM 'Paid'
            AND (deleted = false OR deleted IS NULL)
            AND (voided = false OR voided IS NULL)
            AND (on_hold = false OR on_hold IS NULL)
            AND parent_id IS NULL
            AND scheduled_payment_date ~ '^\\d{4}-\\d{2}-\\d{2}'
            AND scheduled_payment_date::date <= CURRENT_DATE + INTERVAL '7 days'`
      );
      data.payments = {
        count: rows.length,
        usd: sumUsd(rows),
        rush: rows.filter((r) => r.rush).length,
        overdue: rows.filter((r) => r.overdue).length,
        to: LOOP_PAGES.payments,
      };
    })());

    // Bank — debit lines nobody has answered (no ledger entry, not dismissed),
    // and whether each account's next statement is late, by the cadence the
    // account itself has shown (lib/statement-integrity expectedNext: median
    // gap between period ends, plus five days' grace; one statement implies a
    // month).
    if (reach.has(LOOP_PAGES.bank)) jobs.push((async () => {
      const [{ rows: open }, { rows: ends }] = await Promise.all([
        pool.query(
          `SELECT t.amount, t.currency FROM bank_transactions t
            WHERE t.direction = 'debit'
              AND t.matched_expense_id IS NULL
              AND COALESCE(t.dismissed, false) = false`
        ),
        pool.query(
          `SELECT account, period_end FROM bank_statements
            WHERE period_end IS NOT NULL AND COALESCE(status, 'ready') <> 'error'
            ORDER BY period_end`
        ),
      ]);
      const byAccount = {};
      for (const r of ends) (byAccount[r.account] = byAccount[r.account] || []).push(r);
      const accounts = Object.entries(byAccount).map(([account, stmts]) => ({
        account, statements: stmts.length, ...expectedNext(stmts, new Date()),
      }));
      data.bank = {
        open: open.length,
        open_usd: round2(open.reduce((t, r) => t + (usdOf(r.amount, r.currency) || 0), 0)),
        accounts,
        overdue_accounts: accounts.filter((a) => a.overdue).map((a) => a.account),
        to: open.length ? LOOP_PAGES.bank : '/bk/statements',
      };
    })());

    // Releasing in 30 days — not archived. "Under half done" uses the same
    // fourteen checklist columns the notifications feed reads.
    if (reach.has(LOOP_PAGES.releases)) jobs.push((async () => {
      const { rows } = await pool.query(
        `SELECT r.id, r.project_name, a.name AS artist_name, r.release_date::text AS release_day,
                (COALESCE(r.yt_video,false)::int + COALESCE(r.recoup_added,false)::int + COALESCE(r.uploaded,false)::int
               + COALESCE(r.stem_pitch,false)::int + COALESCE(r.s4a_pitch,false)::int + COALESCE(r.amazon_pitch,false)::int
               + COALESCE(r.pandora,false)::int + COALESCE(r.budget,false)::int + COALESCE(r.marketing_plan,false)::int
               + COALESCE(r.official_thread,false)::int + COALESCE(r.marquee,false)::int + COALESCE(r.content,false)::int
               + COALESCE(r.dsp_email,false)::int + COALESCE(r.musixmatch,false)::int) AS items_completed
           FROM releases r LEFT JOIN artists a ON a.id = r.artist_id
          WHERE r.release_date >= CURRENT_DATE
            AND r.release_date <= CURRENT_DATE + INTERVAL '30 days'
            AND (r.archived = false OR r.archived IS NULL)
          ORDER BY r.release_date, r.id`
      );
      const next = rows[0] || null;
      data.releases = {
        count: rows.length,
        under_half: rows.filter((r) => Number(r.items_completed) / 14 < 0.5).length,
        next: next ? { id: next.id, project_name: next.project_name, artist_name: next.artist_name, release_date: next.release_day } : null,
        to: LOOP_PAGES.releases,
      };
    })());

    // Onboarding — artists signed and not yet complete, and how many steps
    // are open between them (lib/onboarding, the checklist's own answers).
    if (reach.has(LOOP_PAGES.onboarding)) jobs.push((async () => {
      const rows = await openOnboardings();
      data.onboarding = {
        count: rows.length,
        steps_open: rows.reduce((t, r) => t + r.open, 0),
        next: rows[0] ? { id: rows[0].artist_id, name: rows[0].name, open: rows[0].open } : null,
        to: `${LOOP_PAGES.onboarding}?onboarding=1`,
      };
    })());

    await Promise.all(jobs);
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/dashboard/loop:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
