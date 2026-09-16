#!/usr/bin/env node

/**
 * Backup Invoices Script
 *
 * Downloads all invoice files from the Market Street dashboard API
 * and saves them to ~/Desktop/Finance & Admin/2026 Invoices organized by month.
 *
 * Structure:
 *   ~/Desktop/Finance & Admin/2026 Invoices/
 *     2026-01 January/
 *       VendorName_INV-001_2026-01-15.pdf
 *     2026-02 February/
 *       ...
 *
 * Usage:
 *   node scripts/backup-invoices.js
 *
 * Set environment variables (or they'll use defaults):
 *   BOOM_API_URL   - API base URL (default: https://marketst-production.up.railway.app/api)
 *   BOOM_EMAIL     - Login email (default: john@deanst.co)
 *   BOOM_PASSWORD  - Login password
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env from scripts/ directory
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); }
catch { require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '.env') }); }

const API_URL = process.env.BOOM_API_URL || 'https://marketst-production.up.railway.app/api';
const EMAIL = process.env.BOOM_EMAIL;
const PASSWORD = process.env.BOOM_PASSWORD;
const OUTPUT_DIR = path.join(require('os').homedir(), 'Desktop', 'Finance & Admin', '2026 Invoices');

if (!EMAIL || !PASSWORD) {
  console.error('Missing BOOM_EMAIL or BOOM_PASSWORD in scripts/.env');
  console.error('Create scripts/.env with:\n  BOOM_EMAIL=john@deanst.co\n  BOOM_PASSWORD=yourpassword');
  process.exit(1);
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── HTTP helper ──────────────────────────────────────────────────────────────

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.headers['content-type']?.includes('json')) {
          try { resolve({ status: res.statusCode, data: JSON.parse(body.toString()) }); }
          catch { resolve({ status: res.statusCode, data: body }); }
        } else {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// ── Sanitize filename ────────────────────────────────────────────────────────

function sanitize(str) {
  return (str || 'unknown').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Market Street Invoice Backup');
  console.log('===========================');
  console.log(`API: ${API_URL}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // 1. Login
  console.log('Logging in...');
  const loginRes = await request(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const token = loginRes.data?.token || loginRes.data?.data?.token;
  if (loginRes.status !== 200 || !token) {
    console.error('Login failed:', loginRes.data?.error || `HTTP ${loginRes.status}`);
    process.exit(1);
  }
  const authHeaders = { Authorization: `Bearer ${token}` };
  console.log('Logged in successfully.\n');

  // 2. Fetch all entries
  console.log('Fetching entries...');
  const entriesRes = await request(`${API_URL}/bk/entries?status=all`, { headers: authHeaders });

  if (entriesRes.status !== 200 || !entriesRes.data?.data) {
    console.error('Failed to fetch entries:', entriesRes.data?.error || `HTTP ${entriesRes.status}`);
    process.exit(1);
  }

  const entries = entriesRes.data.data.filter(e => e.has_invoice);
  console.log(`Found ${entries.length} entries with invoice files.\n`);

  if (!entries.length) {
    console.log('Nothing to backup.');
    return;
  }

  // 3. Ensure output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 4. Download each invoice
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    // Determine month folder
    const dateStr = entry.invoice_date ? String(entry.invoice_date).slice(0, 10) : null;
    let folderName = 'No Date';
    if (dateStr) {
      const [year, month] = dateStr.split('-');
      const monthIdx = parseInt(month, 10) - 1;
      folderName = `${year}-${month} ${MONTHS[monthIdx] || 'Unknown'}`;
    }

    const monthDir = path.join(OUTPUT_DIR, folderName);
    fs.mkdirSync(monthDir, { recursive: true });

    // Build filename: VendorName_INV-001_2026-01-15.ext
    const vendor = sanitize(entry.payee);
    const invNum = entry.invoice_number ? `_${sanitize(entry.invoice_number)}` : '';
    const datePart = dateStr ? `_${dateStr}` : '';
    const ext = (entry.invoice_filename || '').match(/\.([a-z0-9]+)$/i)?.[1] || 'pdf';
    const filename = `${vendor}${invNum}${datePart}.${ext}`;
    const filePath = path.join(monthDir, filename);

    // Skip if already exists
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    // Download the file
    try {
      const fileRes = await request(
        `${API_URL}/bk/entries/${entry.id}/file/invoice?token=${token}`,
        { headers: authHeaders }
      );

      if (fileRes.status === 200 && Buffer.isBuffer(fileRes.data) && fileRes.data.length > 0) {
        fs.writeFileSync(filePath, fileRes.data);
        downloaded++;
        if (downloaded % 10 === 0) process.stdout.write(`  ${downloaded} downloaded...\r`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
    }
  }

  console.log(`\nBackup complete!`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped (already exists): ${skipped}`);
  if (failed) console.log(`  Failed: ${failed}`);
  console.log(`  Location: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
