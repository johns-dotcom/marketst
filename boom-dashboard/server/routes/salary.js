const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Page-permission gate — Admin/Superadmin/Approver pass freely; Users
// pass only when admin has explicitly granted them /salary via the
// permissions matrix. Default-unrestricted Users still don't see
// payroll (the requirePagePermission helper treats /salary as
// sensitive — explicit grant required).
const { requirePagePermission } = require('../middleware/pagePermission');
router.use(requirePagePermission('/salary'));

// GET /api/salary?month=4&year=2026
router.get('/', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { rows } = await pool.query(`
      SELECT
        se.id, se.name, se.department, se.monthly_amount,
        sp.paid, sp.amount AS paid_amount, sp.paid_at, sp.paid_by, sp.notes
      FROM salary_employees se
      LEFT JOIN salary_payments sp
        ON sp.employee_id = se.id AND sp.month = $1 AND sp.year = $2
      WHERE se.active = true
      ORDER BY se.monthly_amount DESC NULLS LAST, se.name ASC
    `, [month, year]);

    res.json({ success: true, data: rows, month, year });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/salary/:employeeId — toggle paid for a month
router.put('/:employeeId', async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId);
    const { month, year, paid, notes } = req.body;

    if (!month || !year) return res.status(400).json({ success: false, error: 'month and year required' });

    // Get the employee's monthly amount
    const { rows: emp } = await pool.query('SELECT monthly_amount FROM salary_employees WHERE id = $1', [employeeId]);
    const amount = emp[0]?.monthly_amount || 0;

    const { rows } = await pool.query(`
      INSERT INTO salary_payments (employee_id, month, year, paid, amount, paid_at, paid_by, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (employee_id, month, year)
      DO UPDATE SET
        paid = EXCLUDED.paid,
        amount = EXCLUDED.amount,
        paid_at = CASE WHEN EXCLUDED.paid THEN NOW() ELSE NULL END,
        paid_by = CASE WHEN EXCLUDED.paid THEN $7 ELSE NULL END,
        notes = COALESCE(EXCLUDED.notes, salary_payments.notes)
      RETURNING *
    `, [employeeId, month, year, paid, amount, paid ? new Date() : null, req.user.name, notes || null]);

    // Log the toggle in history
    await pool.query(`
      INSERT INTO salary_payment_history (employee_id, month, year, action, performed_by, performed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [employeeId, month, year, paid ? 'marked_paid' : 'marked_unpaid', req.user.name]).catch(() => {});

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/salary/employees — add a new employee to payroll
router.post('/employees', async (req, res) => {
  try {
    const { name, department, monthly_amount } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    const { rows } = await pool.query(
      'INSERT INTO salary_employees (name, department, monthly_amount) VALUES ($1, $2, $3) RETURNING *',
      [name, department || null, monthly_amount || 0]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/salary/history?month=4&year=2026
router.get('/history', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT h.*, se.name AS employee_name
      FROM salary_payment_history h
      JOIN salary_employees se ON se.id = h.employee_id
      WHERE h.month = $1 AND h.year = $2
      ORDER BY h.performed_at DESC
      LIMIT 50
    `, [month, year]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/salary/employees/:id — edit employee name/department/amount.
// Each field is patched only when explicitly present in the body. We avoid
// `COALESCE($1, name)` with `name || null` because that pattern silently keeps
// the existing value when the client sends an empty string — making it look
// like edits "revert" to the user.
router.put('/employees/:id', async (req, res) => {
  try {
    const sets = [];
    const values = [];
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
      const trimmed = String(req.body.name || '').trim();
      if (!trimmed) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
      values.push(trimmed); sets.push(`name = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'department')) {
      values.push(String(req.body.department || '').trim() || null);
      sets.push(`department = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'monthly_amount')) {
      const n = Number(req.body.monthly_amount);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: 'monthly_amount must be a non-negative number' });
      values.push(n); sets.push(`monthly_amount = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update' });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE salary_employees SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Employee not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/salary/employees/:id — remove from payroll
router.delete('/employees/:id', async (req, res) => {
  try {
    await pool.query('UPDATE salary_employees SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
