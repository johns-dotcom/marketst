const express = require('express')
const pool = require('../db')
const authMiddleware = require('../middleware/auth')

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

// GET /api/calendar — fetch all events from every data source
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Contracts events are admin-only — non-admin users get an empty contracts
    // bucket so the rest of the calendar still works.
    const userRole = (req.user?.role || '').toLowerCase();
    const canSeeContracts = userRole === 'admin' || userRole === 'superadmin' || userRole === 'approver';

    const [releases, contracts, dsps, tasks, manual] = await Promise.all([
      safeQuery(`
        SELECT r.id, r.project_name AS title, r.release_date AS date,
               a.name AS artist_name, r.release_type
        FROM releases r
        LEFT JOIN artists a ON r.artist_id = a.id
        WHERE r.release_date IS NOT NULL
        ORDER BY r.release_date
      `),
      canSeeContracts
        ? safeQuery(`
            SELECT c.id, a.name AS artist_name, c.type, c.expiration_date, c.date_signed
            FROM contracts c
            LEFT JOIN artists a ON c.artist_id = a.id
            WHERE c.expiration_date IS NOT NULL OR c.date_signed IS NOT NULL
            ORDER BY c.expiration_date
          `)
        : Promise.resolve({ rows: [] }),
      safeQuery(`
        SELECT ds.id, ds.dsp_name, ds.live_date, ds.submitted_date,
               r.id AS release_id, r.project_name,
               a.name AS artist_name
        FROM dsp_submissions ds
        JOIN releases r ON ds.release_id = r.id
        JOIN artists a ON r.artist_id = a.id
        WHERE ds.live_date IS NOT NULL
           OR ds.submitted_date IS NOT NULL
        ORDER BY ds.live_date
      `),
      safeQuery(`
        SELECT t.id, t.description, t.due_date, t.priority, t.status,
               u.name AS assignee_name
        FROM tasks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.due_date IS NOT NULL
          AND t.status != 'Done'
          AND t.user_id = $1
        ORDER BY t.due_date
      `, [req.user.id]),
      safeQuery(`
        SELECT id, title, event_date AS date, event_type, description, color
        FROM calendar_events
        ORDER BY event_date
      `),
    ])

    const events = []

    for (const r of releases.rows) {
      events.push({
        id: `release-${r.id}`, type: 'release', title: r.title,
        subtitle: r.artist_name, date: d(r.date), meta: r.release_type,
        status: r.status, sourceId: r.id,
      })
    }

    for (const c of contracts.rows) {
      if (c.expiration_date) {
        events.push({
          id: `contract-exp-${c.id}`, type: 'contract_expiry',
          title: `${c.artist_name} — contract expires`, subtitle: c.type,
          date: d(c.expiration_date), sourceId: c.id,
        })
      }
      if (c.date_signed) {
        events.push({
          id: `contract-sign-${c.id}`, type: 'contract_signed',
          title: `${c.artist_name} — contract signed`, subtitle: c.type,
          date: d(c.date_signed), sourceId: c.id,
        })
      }
    }

    for (const ds of dsps.rows) {
      if (ds.live_date) {
        events.push({
          id: `dsp-live-${ds.id}`, type: 'dsp_live',
          title: `${ds.project_name} — live on ${ds.dsp_name}`,
          subtitle: ds.artist_name, date: d(ds.live_date), sourceId: ds.release_id,
        })
      }
      if (ds.submitted_date) {
        events.push({
          id: `dsp-submit-${ds.id}`, type: 'dsp_submitted',
          title: `${ds.project_name} — submitted to ${ds.dsp_name}`,
          subtitle: ds.artist_name, date: d(ds.submitted_date), sourceId: ds.release_id,
        })
      }
    }

    for (const t of tasks.rows) {
      events.push({
        id: `task-${t.id}`, type: 'deadline', title: t.description,
        subtitle: t.assignee_name ? `Assigned to ${t.assignee_name}` : null,
        date: d(t.due_date), meta: t.priority, sourceId: t.id,
      })
    }

    for (const e of manual.rows) {
      events.push({
        id: `event-${e.id}`, type: e.event_type || 'manual', title: e.title,
        subtitle: e.description || null, date: d(e.date), color: e.color || null,
        sourceId: e.id, deletable: true,
      })
    }

    const filtered = events.filter(e => e.date)
    console.log(`Calendar: ${releases.rows.length} releases, ${contracts.rows.length} contracts, ${tasks.rows.length} tasks → ${filtered.length} total events`)
    res.json({ events: filtered })
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
