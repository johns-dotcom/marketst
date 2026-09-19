const express = require('express')
const pool = require('../db')
const authMiddleware = require('../middleware/auth')
const { pagesReachable } = require('../middleware/pagePermission')

const router = express.Router()

const safeQuery = async (sql, params) => {
  try {
    return await pool.query(sql, params || [])
  } catch (err) {
    console.warn('Calendar query failed:', err.message)
    return { rows: [] }
  }
}

const d = (raw) => {
  if (!raw) return null
  if (raw instanceof Date) return raw.toISOString().split('T')[0]
  const str = String(raw)
  if (str.includes('T')) return str.split('T')[0]
  return str.slice(0, 10)
}

// GET /api/calendar — the team calendar: one feed of typed events, each with
// the page it came from (`to`), so a date on the calendar is one click from
// the thing it is about.
//
// Sources, and what admits each (2026-09-18, Phase D of the flow plan):
//   release        releases.release_date          reachable /releases
//   dsp_*          dsp_submissions dates           reachable /releases
//   contract_signed contracts.date_signed         reachable /contracts
//   contract_expiry contracts.expiration_date     reachable /renewals  (the Renewals page's own set)
//   deadline       tasks.due_date, open           own tasks always; EVERYONE's when /team is reachable
//   payment_due    expenses.scheduled_payment_date reachable /bk/payments — approved, unpaid family roots,
//                                                 the Payments queue's own predicate (on hold shown, marked)
//   manual         calendar_events                 always
//
// Gated by pagesReachable — the page-permission middleware's rules as a set,
// the same gate Home's loop uses — never by role name: a bookkeeper User with a
// Payments grant sees due dates, an A&R User without one gets no money at all.
// `sources` says which feeds this caller received, so the legend can name a
// source that is missing by permission instead of leaving a silent gap.
const CAL_PAGES = { releases: '/releases', contracts: '/contracts', renewals: '/renewals', payments: '/bk/payments', team: '/team' }

const fmtMoney = (amount, currency) => {
  const n = Number(amount) || 0
  const cur = (currency || 'USD').toUpperCase()
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n) }
  catch { return `${cur} ${n.toLocaleString('en-US')}` }
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const reach = await pagesReachable(req.user, Object.values(CAL_PAGES))
    const can = (k) => reach.has(CAL_PAGES[k])
    const teamTasks = can('team')
    const none = Promise.resolve({ rows: [] })

    const [releases, contracts, dsps, tasks, payments, manual] = await Promise.all([
      can('releases') ? safeQuery(`
        SELECT r.id, r.project_name AS title, r.release_date AS date,
               a.name AS artist_name, r.release_type
        FROM releases r
        LEFT JOIN artists a ON r.artist_id = a.id
        WHERE r.release_date IS NOT NULL
        ORDER BY r.release_date
      `) : none,
      (can('contracts') || can('renewals')) ? safeQuery(`
        SELECT c.id, a.name AS artist_name, c.type, c.expiration_date, c.date_signed, c.status
        FROM contracts c
        LEFT JOIN artists a ON c.artist_id = a.id
        WHERE c.expiration_date IS NOT NULL OR c.date_signed IS NOT NULL
        ORDER BY c.expiration_date
      `) : none,
      can('releases') ? safeQuery(`
        SELECT ds.id, ds.dsp_name, ds.live_date, ds.submitted_date,
               r.id AS release_id, r.project_name,
               a.name AS artist_name
        FROM dsp_submissions ds
        JOIN releases r ON ds.release_id = r.id
        JOIN artists a ON r.artist_id = a.id
        WHERE ds.live_date IS NOT NULL
           OR ds.submitted_date IS NOT NULL
        ORDER BY ds.live_date
      `) : none,
      safeQuery(`
        SELECT t.id, t.description, t.due_date, t.priority, t.status, t.user_id,
               u.name AS assignee_name
        FROM tasks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.due_date IS NOT NULL
          AND t.status != 'Done'
          ${teamTasks ? '' : 'AND t.user_id = $1'}
        ORDER BY t.due_date
      `, teamTasks ? [] : [req.user.id]),
      can('payments') ? safeQuery(`
        SELECT e.id, e.payee, e.amount, e.currency, e.artist, e.song,
               e.scheduled_payment_date::date AS due,
               COALESCE(e.rush_requested, false) AS rush,
               COALESCE(e.on_hold, false) AS on_hold
          FROM expenses e
         WHERE e.status = 'approved'
           AND e.payment_status IS DISTINCT FROM 'Paid'
           AND (e.deleted = false OR e.deleted IS NULL)
           AND (e.voided = false OR e.voided IS NULL)
           AND e.parent_id IS NULL
           AND e.scheduled_payment_date ~ '^\\d{4}-\\d{2}-\\d{2}'
         ORDER BY e.scheduled_payment_date
      `) : none,
      safeQuery(`
        SELECT id, title, event_date AS date, event_type, description, color, link
        FROM calendar_events
        ORDER BY event_date
      `),
    ])

    const events = []

    for (const r of releases.rows) {
      events.push({
        id: `release-${r.id}`, type: 'release', title: r.title,
        subtitle: r.artist_name, date: d(r.date), meta: r.release_type,
        sourceId: r.id, to: CAL_PAGES.releases,
      })
    }

    for (const c of contracts.rows) {
      if (c.expiration_date && can('renewals')) {
        events.push({
          id: `contract-exp-${c.id}`, type: 'contract_expiry',
          title: `${c.artist_name || 'Contract'} — ${c.type || 'contract'} expires`,
          subtitle: c.status && c.status !== 'Active' ? c.status : null,
          date: d(c.expiration_date), sourceId: c.id, to: CAL_PAGES.renewals,
        })
      }
      if (c.date_signed && can('contracts')) {
        events.push({
          id: `contract-sign-${c.id}`, type: 'contract_signed',
          title: `${c.artist_name || 'Contract'} — ${c.type || 'contract'} signed`,
          subtitle: null, date: d(c.date_signed), sourceId: c.id, to: CAL_PAGES.contracts,
        })
      }
    }

    for (const ds of dsps.rows) {
      if (ds.live_date) {
        events.push({
          id: `dsp-live-${ds.id}`, type: 'dsp_live',
          title: `${ds.project_name} — live on ${ds.dsp_name}`,
          subtitle: ds.artist_name, date: d(ds.live_date), sourceId: ds.release_id, to: CAL_PAGES.releases,
        })
      }
      if (ds.submitted_date) {
        events.push({
          id: `dsp-submit-${ds.id}`, type: 'dsp_submitted',
          title: `${ds.project_name} — submitted to ${ds.dsp_name}`,
          subtitle: ds.artist_name, date: d(ds.submitted_date), sourceId: ds.release_id, to: CAL_PAGES.releases,
        })
      }
    }

    for (const t of tasks.rows) {
      const mine = Number(t.user_id) === Number(req.user.id)
      events.push({
        id: `task-${t.id}`, type: 'deadline', title: t.description,
        subtitle: mine ? null : (t.assignee_name ? `Assigned to ${t.assignee_name}` : null),
        date: d(t.due_date), meta: t.priority, sourceId: t.id,
        to: mine ? '/my-work' : `/team/${t.user_id}`,
      })
    }

    for (const e of payments.rows) {
      const flags = [e.rush ? 'Rush' : null, e.on_hold ? 'On hold' : null].filter(Boolean)
      events.push({
        id: `payment-${e.id}`, type: 'payment_due',
        title: `${e.payee || 'Payment'} — ${fmtMoney(e.amount, e.currency)} due`,
        subtitle: [e.artist, e.song].filter(Boolean).join(' · ') || null,
        date: d(e.due), meta: flags.length ? flags.join(' · ') : null,
        sourceId: e.id, to: CAL_PAGES.payments,
      })
    }

    for (const e of manual.rows) {
      events.push({
        id: `event-${e.id}`, type: e.event_type || 'manual', title: e.title,
        // a signing marker's description is a machine tag (deal:12), not a caption
        subtitle: e.event_type === 'signed' ? null : (e.description || null), date: d(e.date), color: e.color || null,
        sourceId: e.id, deletable: e.event_type !== 'signed', to: e.link || null,
      })
    }

    const filtered = events.filter(e => e.date)
    res.json({
      events: filtered,
      // What this caller was given. false = withheld by page permission.
      sources: {
        releases: can('releases'),
        contracts: can('contracts'),
        renewals: can('renewals'),
        payments: can('payments'),
        tasks: teamTasks ? 'team' : 'own',
      },
    })
  } catch (err) {
    console.error('Calendar GET error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar — create manual event
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, event_date, event_type, description, color } = req.body
    if (!title || !event_date) return res.status(400).json({ error: 'title and event_date required' })

    const result = await pool.query(
      `INSERT INTO calendar_events (title, event_date, event_type, description, color, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, event_date, event_type || 'manual', description || null, color || null, req.user.id]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Calendar POST error:', err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/calendar/:id — remove manual event
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
