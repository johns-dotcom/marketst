#!/usr/bin/env node

/**
 * Backup Master Ledger Script
 *
 * Pulls the full ledger Excel export from /api/bk/export and saves a
 * dated snapshot to ~/Desktop/Finance & Admin/Master Ledger/.
 *
 * Each run writes a NEW file (no skip-if-exists like the invoice/W9
 * backups) so you keep a historical snapshot for every backup date.
 * Scheduled by launchd biweekly (1st + 15th of each month).
 *
 * Output:
 *   ~/Desktop/Finance & Admin/Master Ledger/
 *     master-ledger-2026-06-18.xlsx
 *     master-ledger-2026-07-01.xlsx
 *     ...
 *
 * Usage:
 *   node scripts/backup-ledger.js
 *
 * Env vars (loaded from scripts/.env):
 *   BOOM_API_URL   - API base URL (default: https://marketst-production.up.railway.app/api)
 *   BOOM_EMAIL     - Login email
 *   BOOM_PASSWORD  - Login password
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); }
catch { require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '.env') }); }

const API_URL = process.env.BOOM_API_URL || 'https://marketst-production.up.railway.app/api';
const EMAIL = process.env.BOOM_EMAIL;
const PASSWORD = process.env.BOOM_PASSWORD;
const OUTPUT_DIR = path.join(require('os').homedir(), 'Desktop', 'Finance & Admin', 'Master Ledger');

if (!EMAIL || !PASSWORD) {
  console.error('Missing BOOM_EMAIL or BOOM_PASSWORD in scripts/.env');
  process.exit(1);
}

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

async function main() {
  console.log('Market Street Master Ledger Backup');
  console.log('==================================');
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
  console.log('Logged in successfully.\n');

  // 2. Pull the export. Server route is admin-only; the login above
  //    must be with an admin/superadmin account or it 403s.
  console.log('Requesting ledger export...');
  const exportRes = await request(`${API_URL}/bk/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (exportRes.status !== 200 || !Buffer.isBuffer(exportRes.data) || exportRes.data.length === 0) {
    const msg = (exportRes.data && exportRes.data.error) || `HTTP ${exportRes.status}`;
    console.error('Export failed:', msg);
    process.exit(1);
  }

  // 3. Write to dated file. No skip — every run produces a snapshot.
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `master-ledger-${today}.xlsx`;
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, exportRes.data);

  const mb = (exportRes.data.length / 1024 / 1024).toFixed(2);
  console.log(`\nBackup complete!`);
  console.log(`  Wrote: ${filename} (${mb} MB)`);
  console.log(`  Location: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
