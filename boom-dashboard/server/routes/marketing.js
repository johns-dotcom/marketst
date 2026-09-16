const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const auth = require('../middleware/auth');
const { callClaude } = require('../services/claude');

// Store uploads in memory so we can pass the buffer directly to Claude
const { secureFileFilter } = require('../middleware/secureUpload');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureFileFilter,
});

// ─── POST /api/marketing/parse ────────────────────────────────────────────────
// Accepts a screenshot, runs it through Claude vision, returns extracted JSON.
// Does NOT save anything — frontend shows a preview/confirm step first.
router.post('/parse', auth, upload.single('screenshot'), async (req, res) => {
  if (!req.file) {
    return res.json({ success: false, error: 'No image uploaded' });
  }

  try {
    const prompt = `You are extracting structured data from a screenshot of an influencer/creator marketing campaign management interface (e.g. Cobrand).

Extract the following and return ONLY a valid JSON object with no markdown, no explanation, no code fences:

{
  "campaign_name": "the campaign title at the top",
  "label": "the record label or company name shown",
  "campaign_date": "date shown in MM/DD/YYYY format, or null",
  "total_budget": 0.00,
  "num_sounds": 0,
  "platform": "Cobrand",
  "creators": [
    {
      "name": "creator display name",
      "handle": "username handle (no @)",
      "tags": ["tag1", "tag2"],
      "stage": "campaign stage shown (e.g. Live Post, Hired, Negotiating)",
      "price": 0.00,
      "email": "contact email or null",
      "date_added": "MM/DD/YYYY or null",
      "tiktok_engagement_rate": "e.g. 7.58% or null",
      "tiktok_followers": "number as string or null",
      "instagram_engagement_rate": "e.g. 8.12% or null",
      "instagram_followers": "number as string or null"
    }
  ]
}

Rules:
- total_budget should be a number (no $ sign)
- creator price should be a number (no $ sign)
- If a creator appears twice (different platforms/rows), merge them into one entry with both platform stats filled in
- tags should be an array of strings (the colored tag pills)
- Use null for any field not visible in the screenshot
- Return ONLY the JSON object`;

    const result = await callClaude({
      prompt,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      model: 'claude-opus-4-6',
      maxTokens: 2048,
      parseJson: true,
    });
    if (!result.ok) {
      return res.json({ success: false, error: result.error || 'Failed to parse screenshot' });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('Marketing parse error:', err);
    res.json({ success: false, error: err.message || 'Failed to parse screenshot' });
  }
});

// ─── GET /api/marketing/campaigns ─────────────────────────────────────────────
router.get('/campaigns', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ic.*,
        a.name  AS artist_name,
        r.project_name AS release_title,
        u.name  AS created_by_name
      FROM influencer_campaigns ic
      LEFT JOIN artists  a ON a.id = ic.artist_id
      LEFT JOIN releases r ON r.id = ic.release_id
      LEFT JOIN users    u ON u.id = ic.created_by
      ORDER BY ic.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

// ─── GET /api/marketing/campaigns/:id ─────────────────────────────────────────
router.get('/campaigns/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const [camp, creators] = await Promise.all([
      pool.query(`
        SELECT ic.*, a.name AS artist_name, r.project_name AS release_title
        FROM influencer_campaigns ic
        LEFT JOIN artists  a ON a.id = ic.artist_id
        LEFT JOIN releases r ON r.id = ic.release_id
        WHERE ic.id = $1
      `, [id]),
      pool.query(
        `SELECT * FROM influencer_campaign_creators WHERE campaign_id = $1 ORDER BY price DESC NULLS LAST`,
        [id]
      ),
    ]);
    if (!camp.rows[0]) return res.json({ success: false, error: 'Not found' });
    res.json({ success: true, data: { ...camp.rows[0], creators: creators.rows } });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

// ─── POST /api/marketing/campaigns ────────────────────────────────────────────
// Saves confirmed extraction. Optionally creates a manual_expenses entry.
router.post('/campaigns', auth, async (req, res) => {
  const {
    name, platform, artist_id, release_id,
    total_budget, num_sounds, campaign_date,
    creators = [], create_expense,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert campaign
    const campRes = await client.query(
      `INSERT INTO influencer_campaigns
         (name, platform, artist_id, release_id, total_budget, num_sounds, campaign_date, num_creators, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        name,
        platform || 'Cobrand',
        artist_id || null,
        release_id || null,
        total_budget || null,
        num_sounds || null,
        campaign_date || null,
        creators.length,
        req.user.id,
      ]
    );
    const campaignId = campRes.rows[0].id;

    // 2. Insert creators
    for (const c of creators) {
      await client.query(
        `INSERT INTO influencer_campaign_creators
           (campaign_id, creator_name, handle, stage, price, contact_email, date_added,
            tiktok_engagement_rate, tiktok_followers, instagram_engagement_rate, instagram_followers, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          campaignId,
          c.name || null,
          c.handle || null,
          c.stage || null,
          c.price || null,
          c.email || null,
          c.date_added || null,
          c.tiktok_engagement_rate || null,
          c.tiktok_followers || null,
          c.instagram_engagement_rate || null,
          c.instagram_followers || null,
          c.tags || [],
        ]
      );
    }

    // 3. Optionally auto-create a manual expense entry on the Financials page
    let expenseId = null;
    if (create_expense && total_budget) {
      // Look up artist name for denormalized field
      let artistName = null;
      if (artist_id) {
        const aRes = await client.query('SELECT name FROM artists WHERE id=$1', [artist_id]);
        artistName = aRes.rows[0]?.name || null;
      }

      const expRes = await client.query(
        `INSERT INTO manual_expenses
           (artist_id, artist_name, description, amount, category, expense_date, release_id, created_by, recoupable)
         VALUES ($1,$2,$3,$4,'Marketing',$5,$6,$7,false)
         RETURNING id`,
        [
          artist_id || null,
          artistName,
          `Influencer Campaign: ${name}`,
          total_budget,
          campaign_date || new Date().toISOString().split('T')[0],
          release_id || null,
          req.user.id,
        ]
      );
      expenseId = expRes.rows[0].id;

      // Link expense back to campaign
      await client.query(
        `UPDATE influencer_campaigns SET expense_id=$1 WHERE id=$2`,
        [expenseId, campaignId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { id: campaignId, expense_id: expenseId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Marketing save error:', err);
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/marketing/campaigns/:id ──────────────────────────────────────
router.delete('/campaigns/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    // Also delete the linked expense if one exists
    const camp = await pool.query('SELECT expense_id FROM influencer_campaigns WHERE id=$1', [id]);
    if (camp.rows[0]?.expense_id) {
      await pool.query('DELETE FROM manual_expenses WHERE id=$1', [camp.rows[0].expense_id]);
    }
    await pool.query('DELETE FROM influencer_campaigns WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
