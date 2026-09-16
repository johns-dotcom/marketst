#!/usr/bin/env node

/**
 * Backup W9/W8 Script
 *
 * Downloads all W9/W8 files from the Market Street dashboard API
 * and saves them to ~/Desktop/Finance & Admin/W9∕W8 organized alphabetically by vendor.
 *
 * Structure:
 *   ~/Desktop/Finance & Admin/W9∕W8/
 *     A-D/
 *       Amir Schmuecker_W9.pdf
 *       Chrome Sparks LLC_W9.pdf
 *     E-H/
 *       ...
 *     I-L/
 *     M-P/
 *     Q-T/
 *     U-Z/
 *     Other/
 *
 * Usage:
 *   node scripts/backup-w9s.js
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
// macOS Finder shows "W9/W8" but the filesystem uses ":" for "/"
const OUTPUT_DIR = path.join(require('os').homedir(), 'Desktop', 'Finance & Admin', 'W9:W8');

if (!EMAIL || !PASSWORD) {
  console.error('Missing BOOM_EMAIL or BOOM_PASSWORD in scripts/.env');
  process.exit(1);
}

const ALPHA_GROUPS = [
  { name: 'A-D', test: c => c >= 'A' && c <= 'D' },
  { name: 'E-H', test: c => c >= 'E' && c <= 'H' },
  { name: 'I-L', test: c => c >= 'I' && c <= 'L' },
  { name: 'M-P', test: c => c >= 'M' && c <= 'P' },
  { name: 'Q-T', test: c => c >= 'Q' && c <= 'T' },
  { name: 'U-Z', test: c => c >= 'U' && c <= 'Z' },
];

function getAlphaFolder(name) {
  const first = (name || '?')[0].toUpperCase();
  for (const g of ALPHA_GROUPS) {
    if (g.test(first)) return g.name;
  }
  return 'Other';
}

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

function sanitize(str) {
  return (str || 'unknown').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Market Street W9/W8 Backup');
  console.log('=========================');
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

  // 2. Fetch all entries — we need to deduplicate W9s per vendor
  //    (many entries share the same vendor, we only want the most recent W9)
  console.log('Fetching entries...');
  const entriesRes = await request(`${API_URL}/bk/entries?status=all`, { headers: authHeaders });

  if (entriesRes.status !== 200 || !entriesRes.data?.data) {
    console.error('Failed to fetch entries:', entriesRes.data?.error || `HTTP ${entriesRes.status}`);
    process.exit(1);
  }

  // Deduplicate: keep the most recent entry with a W9 per vendor (case-insensitive)
  const vendorW9Map = {};
  for (const entry of entriesRes.data.data) {
    if (!entry.has_w9 && !entry.w9_entry_id) continue;
    const vendor = (entry.payee || '').trim().toLowerCase();
    if (!vendor) continue;
    // Use w9_entry_id if available (points to the actual entry with the W9)
    const w9Id = entry.w9_entry_id || entry.id;
    if (!vendorW9Map[vendor] || entry.id > vendorW9Map[vendor].id) {
      vendorW9Map[vendor] = {
        id: entry.id,
        w9Id,
        payee: entry.payee,
        w9_filename: entry.w9_filename,
      };
    }
  }

  const vendors = Object.values(vendorW9Map);
  console.log(`Found ${vendors.length} vendors with W9/W8 files.\n`);

  if (!vendors.length) {
    console.log('Nothing to backup.');
    return;
  }

  // 3. Ensure output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 4. Download each W9
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const vendor of vendors) {
    const folder = getAlphaFolder(vendor.payee);
    const groupDir = path.join(OUTPUT_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const vendorName = sanitize(vendor.payee);
    const ext = (vendor.w9_filename || '').match(/\.([a-z0-9]+)$/i)?.[1] || 'pdf';
    const filename = `${vendorName}_W9.${ext}`;
    const filePath = path.join(groupDir, filename);

    // Skip if already exists
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    try {
      const fileRes = await request(
        `${API_URL}/bk/entries/${vendor.w9Id}/file/w9?token=${token}`,
        { headers: authHeaders }
      );

      if (fileRes.status === 200 && Buffer.isBuffer(fileRes.data) && fileRes.data.length > 0) {
        fs.writeFileSync(filePath, fileRes.data);
        downloaded++;
        if (downloaded % 10 === 0) process.stdout.write(`  ${downloaded} downloaded...\r`);
      } else {
        failed++;
      }
    } catch {
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
