// Personal recurring reminders — "upload the bank statement and match it
// every month". Due reminders surface in the notification bell (and email,
// once per due cycle, via the hourly sweep in index.js). "Done" advances
// next_due to the next occurrence; an overdue reminder stays due until then.
const express = require('express');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const CADENCES = ['monthly', 'weekly', 'once'];

// Next occurrence strictly after `from`. Monthly clamps the day to the
// target month's length (a day-31 reminder fires Feb 28).
function nextDue(cadence, dayOfMonth, from) {
  const base = from ? new Date(from) : new Date();
  if (cadence === 'weekly') {
    const d = new Date(base); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const day = Math.min(Math.max(parseInt(dayOfMonth, 10) || 1, 1), 31);
  let y = base.getFullYear(); let m = base.getMonth() + 1; // next month
  if (m > 11) { m = 0; y++; }
  const clamped = Math.min(day, new Date(y, m + 1, 0).getDate());
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

// First occurrence on or after today.
function firstDue(cadence, dayOfMonth) {
  const now = new Date();
  if (cadence === 'weekly') return now.toISOString().slice(0, 10);
  const day = Math.min(Math.max(parseInt(dayOfMonth, 10) || 1, 1), 31);
  const y = now.getFullYear(); const m = now.getMonth();
  const clamped = Math.min(day, new Date(y, m + 1, 0).getDate());
  const thisMonth = new Date(y, m, clamped);
  if (thisMonth >= new Date(y, m, now.getDate())) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
  }
  return nextDue(cadence, day, thisMonth);
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM reminders WHERE user_id = $1 ORDER BY next_due, id`, [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ success: false, error: 'title required' });
    const cadence = CADENCES.includes(req.body.cadence) ? req.body.cadence : 'monthly';
    const dayOfMonth = Math.min(Math.max(parseInt(req.body.day_of_month, 10) || 1, 1), 31);
    const link = String(req.body.link || '').trim().slice(0, 200) || null;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.next_due || ''))
      ? req.body.next_due
      : (cadence === 'once' ? new Date().toISOString().slice(0, 10) : firstDue(cadence, dayOfMonth));
    const { rows: [r] } = await pool.query(
      `INSERT INTO reminders (user_id, title, link, cadence, day_of_month, next_due, notify_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, title, link, cadence, dayOfMonth, due, req.body.notify_email !== false]);
    res.json({ success: true, data: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Done — advance to the next occurrence ('once' reminders deactivate).
router.post('/:id(\\d+)/done', async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT * FROM reminders WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    if (r.cadence === 'once') {
      await pool.query(`UPDATE reminders SET active = false WHERE id = $1`, [r.id]);
    } else {
      // Advance from today (not from a stale next_due) so an overdue
      // monthly reminder lands next month, not tomorrow.
      await pool.query(`UPDATE reminders SET next_due = $1 WHERE id = $2`,
        [nextDue(r.cadence, r.day_of_month, new Date()), r.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(
      `UPDATE reminders SET active = COALESCE($3, active), notify_email = COALESCE($4, notify_email)
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id,
       typeof req.body.active === 'boolean' ? req.body.active : null,
       typeof req.body.notify_email === 'boolean' ? req.body.notify_email : null]);
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    await pool.query(`DELETE FROM reminders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
