/**
 * /api/full-export — Single-shot full-archive ZIP for John's "exit button".
 *
 * Streams a professionally organized ZIP containing every business-relevant
 * table as a branded .xlsx and every R2-backed file (invoices, proofs, W9s,
 * receipts, entity_files attachments) sorted into named folders. Includes a
 * top-level README.md and manifest.json so the recipient can navigate the
 * archive without the app.
 *
 * Superadmin-only. The route disables socket timeouts because the response
 * can easily run several minutes when fetching thousands of files from R2.
 */

const express   = require('express');
const archiver  = require('archiver');
const ExcelJS   = require('exceljs');
const pool      = require('../db');
const auth      = require('../middleware/auth');
const { loadFileBuffer } = require('../lib/r2');

const router = express.Router();
router.use(auth);

const isSuperadmin = (user) => user && user.role === 'Superadmin';

// Strip characters that confuse Windows/macOS/Linux file browsers and trim
// to a sensible length. Falls back to "Unknown" so we never emit an empty name.
function safeName(s, fallback = 'Unknown') {
  const cleaned = String(s ?? '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function extOf(filename, fallback = 'pdf') {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || fallback;
}

// ──────────────────────────────────────────────────────────────────────────
// Excel styling shared by every workbook in the archive. Mirrors the look
// of /bk/export-lookup so the whole archive feels like one report set.
// ──────────────────────────────────────────────────────────────────────────

const BRAND_RED   = 'FF334155';
const BRAND_DARK  = 'FFB91C1C';
const SUBTLE_GRAY = 'FF6B7280';
const ROW_BAND    = 'FFF9FAFB';
const BORDER_GRAY = 'FFE5E7EB';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_GRAY } };

const CURRENCY_FMT = {
  USD: '"$"#,##0.00', EUR: '"€"#,##0.00', GBP: '"£"#,##0.00',
  JPY: '"¥"#,##0',   CAD: '"CA$"#,##0.00', AUD: '"A$"#,##0.00',
  MXN: '"MX$"#,##0.00', BRL: '"R$"#,##0.00', CHF: '"CHF "#,##0.00',
  SEK: '"kr "#,##0.00', NOK: '"kr "#,##0.00', DKK: '"kr "#,##0.00',
};
const fmtForCurrency = (cur) => CURRENCY_FMT[cur] || `"${cur || 'USD'} "#,##0.00`;

// Build a styled workbook buffer. Columns: { key, header, width, fmt?, align?, type? }
//   type: 'date' | 'currency' | 'bool' | 'datetime' — controls cell formatting.
//   fmt:  optional explicit ExcelJS numFmt that overrides type-based default.
// totalsFor: optional key to sum and emit a per-currency total band.
async function buildWorkbook({ sheetName, title, subtitle, columns, rows, totalsFor }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Market Street Dashboard';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName || 'Sheet1', {
    views: [{ showGridLines: false }],
    pageSetup: {
      orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
  });

  ws.columns = columns.map(c => ({ key: c.key, width: c.width || 14 }));
  const lastColLetter = ws.getColumn(columns.length).letter;

  const titleRow = ws.addRow([title]);
  titleRow.height = 26;
  titleRow.font = { bold: true, size: 16, color: { argb: 'FF111111' } };
  ws.mergeCells(`A1:${lastColLetter}1`);
  titleRow.alignment = { vertical: 'middle', horizontal: 'left' };

  const tsRow = ws.addRow([`Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })} · ${rows.length} record${rows.length === 1 ? '' : 's'}`]);
  tsRow.font = { italic: true, size: 10, color: { argb: SUBTLE_GRAY } };
  ws.mergeCells(`A2:${lastColLetter}2`);

  const subRow = ws.addRow([subtitle || '']);
  subRow.font = { size: 10, color: { argb: SUBTLE_GRAY } };
  ws.mergeCells(`A3:${lastColLetter}3`);

  const HEADER_ROW = 4;
  const header = ws.getRow(HEADER_ROW);
  header.values = columns.map(c => c.header);
  header.height = 22;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.eachCell((cell) => {
    cell.border = {
      top:    { style: 'thin', color: { argb: BRAND_DARK } },
      bottom: { style: 'thin', color: { argb: BRAND_DARK } },
      left:   { style: 'thin', color: { argb: BRAND_DARK } },
      right:  { style: 'thin', color: { argb: BRAND_DARK } },
    };
  });

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_ROW, topLeftCell: `A${HEADER_ROW + 1}`, activeCell: `A${HEADER_ROW + 1}`, showGridLines: false }];
  ws.autoFilter = `A${HEADER_ROW}:${lastColLetter}${HEADER_ROW}`;
  ws.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`;

  // Data rows
  rows.forEach((r, i) => {
    const out = {};
    for (const c of columns) {
      let v = r[c.key];
      if (c.type === 'date' && v) v = new Date(v);
      else if (c.type === 'datetime' && v) v = new Date(v);
      else if (c.type === 'bool') v = v ? 'Yes' : 'No';
      else if (c.type === 'currency') v = v == null ? null : parseFloat(v);
      else if (c.type === 'json' && v != null) {
        try { v = typeof v === 'string' ? v : JSON.stringify(v); } catch { v = String(v); }
      }
      out[c.key] = v;
    }
    const row = ws.addRow(out);
    const banded = i % 2 === 1;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const col = columns[colNumber - 1];
      if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_BAND } };
      cell.border = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
      if (col?.align) cell.alignment = col.align;
      else if (col?.type === 'currency') cell.alignment = { horizontal: 'right', vertical: 'middle' };
      else if (col?.type === 'date' || col?.type === 'datetime' || col?.type === 'bool') {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: !!col?.wrap };
    });
    for (const c of columns) {
      if (c.type === 'date')     row.getCell(c.key).numFmt = c.fmt || 'mm/dd/yyyy';
      if (c.type === 'datetime') row.getCell(c.key).numFmt = c.fmt || 'mm/dd/yyyy hh:mm';
      if (c.type === 'currency') {
        const cur = (r.currency || 'USD').toString().toUpperCase();
        row.getCell(c.key).numFmt = c.fmt || fmtForCurrency(cur);
      }
    }
  });

  // Per-currency totals band (optional)
  if (totalsFor && rows.length) {
    const buckets = {};
    for (const r of rows) {
      const cur = (r.currency || 'USD').toString().toUpperCase();
      const v = parseFloat(r[totalsFor] || 0);
      if (!Number.isFinite(v)) continue;
      buckets[cur] = (buckets[cur] || 0) + v;
    }
    const codes = Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a]);
    if (codes.length) {
      ws.addRow([]); // spacer
      const totalFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      const totalTop  = { style: 'medium', color: { argb: 'FF9CA3AF' } };
      for (const cur of codes) {
        const rowObj = {};
        rowObj[columns[0].key] = `TOTAL (${cur})`;
        rowObj[totalsFor] = buckets[cur];
        const row = ws.addRow(rowObj);
        row.font = { bold: true, color: { argb: 'FF111111' }, size: 11 };
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = totalFill;
          cell.border = { top: totalTop, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        row.getCell(totalsFor).numFmt = fmtForCurrency(cur);
        row.getCell(totalsFor).alignment = { horizontal: 'right', vertical: 'middle' };
      }
    }
  }

  return wb.xlsx.writeBuffer();
}

// Append a styled workbook to the archive at the given path.
async function appendWorkbook(archive, archivePath, opts) {
  const buf = await buildWorkbook(opts);
  archive.append(Buffer.from(buf), { name: archivePath });
  return opts.rows.length;
}

// Push a file buffer into the archive. `seen` is a single Map<string, Set<string>>
// shared across the whole export: keys are folder paths, values are the names
// already used inside that folder. This way duplicate filenames inside one
// folder get suffixed " (2)", " (3)", … while identical names in DIFFERENT
// folders coexist (artist A and artist B can both have a "headshot.png").
function appendFile(archive, seen, folder, baseName, ext, buffer) {
  if (!seen.has(folder)) seen.set(folder, new Set());
  const usedNames = seen.get(folder);
  let name = `${baseName}.${ext}`;
  let i = 2;
  while (usedNames.has(name)) {
    name = `${baseName} (${i}).${ext}`;
    i++;
  }
  usedNames.add(name);
  archive.append(buffer, { name: `${folder}/${name}` });
}

// ──────────────────────────────────────────────────────────────────────────
// The export route
// ──────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (!isSuperadmin(req.user)) {
    return res.status(403).json({ success: false, error: 'Superadmin required' });
  }

  // Long-running response — disable timeouts so R2 fetches have all the time
  // they need. The archive streams to the client as bytes are ready.
  req.setTimeout(0);
  res.setTimeout(0);

  const today = new Date().toISOString().slice(0, 10);
  const rootDir = `marketst-archive-${today}`;
  const filename = `${rootDir}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => console.warn('[full-export] warning:', err.message));
  archive.on('error', (err) => {
    console.error('[full-export] archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  const seen = new Map(); // folder path → Set of filenames already used inside it
  const counts = {}; // section → { records, files }
  const incRec = (section, n = 1) => {
    counts[section] = counts[section] || { records: 0, files: 0 };
    counts[section].records += n;
  };
  const incFile = (section, n = 1) => {
    counts[section] = counts[section] || { records: 0, files: 0 };
    counts[section].files += n;
  };

  try {
    // ════════════════════════════════════════════════════════════════════════
    // 01 — Bookkeeping (the heart of the archive)
    // ════════════════════════════════════════════════════════════════════════
    {
      const SECTION = '01 Bookkeeping';

      // Ledger (full expense table, minus the 4 base64 blob columns)
      const { rows: ledger } = await pool.query(`
        SELECT
          e.id, e.invoice_date, e.payee, e.artist, e.song, e.description, e.category,
          e.invoice_number, e.amount, e.currency, e.cobrand, e.is_reimbursement,
          e.payment_method, e.payment_date, e.payment_status, e.payment_terms,
          e.scheduled_payment_date, e.paid_by, e.payment_ref, e.paid_marked_at,
          e.in_quickbooks, e.qb_entry_date, e.uploaded_to_stem, e.stem_upload_date,
          e.invoice_filename, e.w9_filename, e.proof_filename, e.receipt_filename,
          e.vendor_submitted, e.vendor_name, e.vendor_email, e.vendor_address, e.vendor_bank,
          e.status, e.approved_by, e.approved_at,
          e.recoupable, e.ufr, e.recoupment_label,
          e.is_bulk_deal, e.bulk_deal_quantity, e.bulk_deal_unit, e.bulk_deal_completed,
          e.notes, e.boom_rep, e.parent_id, e.deleted, e.voided, e.voided_at, e.voided_by,
          e.rush_requested, e.rush_requested_at, e.rush_requested_by, e.rush_reason,
          e.created_at, e.created_by,
          r.project_name AS release_name
        FROM expenses e
        LEFT JOIN releases r ON r.id = e.release_id
        ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
      `);

      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Ledger.xlsx`, {
        sheetName: 'Ledger',
        title: 'Market Street — Ledger (Every Expense)',
        subtitle: 'Complete expense register including pending, approved, deleted, and voided entries',
        columns: [
          { key: 'id',                     header: 'ID',              width: 7  },
          { key: 'invoice_date',           header: 'Invoice Date',    width: 12, type: 'date' },
          { key: 'payee',                  header: 'Payee',           width: 28 },
          { key: 'artist',                 header: 'Artist',          width: 20 },
          { key: 'song',                   header: 'Song',            width: 22 },
          { key: 'release_name',           header: 'Linked Release',  width: 22 },
          { key: 'description',            header: 'Description',     width: 32, wrap: true },
          { key: 'category',               header: 'Category',        width: 20 },
          { key: 'invoice_number',         header: 'Invoice #',       width: 14 },
          { key: 'amount',                 header: 'Amount',          width: 14, type: 'currency' },
          { key: 'currency',               header: 'Currency',        width: 9  },
          { key: 'cobrand',                header: 'Cobrand',         width: 10, type: 'bool' },
          { key: 'is_reimbursement',       header: 'Reimburse?',      width: 12, type: 'bool' },
          { key: 'is_bulk_deal',           header: 'Bulk Deal?',      width: 11, type: 'bool' },
          { key: 'recoupable',             header: 'Recoupable?',     width: 12, type: 'bool' },
          { key: 'ufr',                    header: 'UFR',             width: 9  },
          { key: 'payment_method',         header: 'Payment Method',  width: 14 },
          { key: 'payment_date',           header: 'Payment Date',    width: 12, type: 'date' },
          { key: 'payment_status',         header: 'Payment Status',  width: 14 },
          { key: 'payment_terms',          header: 'Terms',           width: 11 },
          { key: 'scheduled_payment_date', header: 'Due Date',        width: 12 },
          { key: 'paid_by',                header: 'Paid By',         width: 14 },
          { key: 'payment_ref',            header: 'Payment Ref',     width: 14 },
          { key: 'paid_marked_at',         header: 'Paid Logged At',  width: 18, type: 'datetime' },
          { key: 'in_quickbooks',          header: 'In QuickBooks',   width: 13 },
          { key: 'qb_entry_date',          header: 'QB Entry Date',   width: 12, type: 'date' },
          { key: 'uploaded_to_stem',       header: 'Uploaded to Stem',width: 16 },
          { key: 'stem_upload_date',       header: 'Stem Upload Date',width: 14, type: 'date' },
          { key: 'invoice_filename',       header: 'Invoice File',    width: 24 },
          { key: 'w9_filename',            header: 'W9 File',         width: 24 },
          { key: 'proof_filename',         header: 'Proof File',      width: 24 },
          { key: 'receipt_filename',       header: 'Receipt File',    width: 24 },
          { key: 'vendor_submitted',       header: 'Vendor-Submitted',width: 15, type: 'bool' },
          { key: 'vendor_name',            header: 'Vendor Name',     width: 22 },
          { key: 'vendor_email',           header: 'Vendor Email',    width: 26 },
          { key: 'vendor_address',         header: 'Vendor Address',  width: 30 },
          { key: 'vendor_bank',            header: 'Vendor Bank',     width: 22 },
          { key: 'status',                 header: 'Approval Status', width: 12 },
          { key: 'approved_by',            header: 'Approved By',     width: 14 },
          { key: 'approved_at',            header: 'Approved At',     width: 18, type: 'datetime' },
          { key: 'boom_rep',               header: 'Market Street Rep',        width: 13 },
          { key: 'notes',                  header: 'Notes',           width: 30, wrap: true },
          { key: 'parent_id',              header: 'Parent ID',       width: 10 },
          { key: 'deleted',                header: 'Deleted?',        width: 10, type: 'bool' },
          { key: 'voided',                 header: 'Voided?',         width: 10, type: 'bool' },
          { key: 'voided_at',              header: 'Voided At',       width: 18, type: 'datetime' },
          { key: 'voided_by',              header: 'Voided By',       width: 14 },
          { key: 'rush_requested',         header: 'Rush?',           width: 9,  type: 'bool' },
          { key: 'rush_reason',            header: 'Rush Reason',     width: 22, wrap: true },
          { key: 'created_at',             header: 'Created At',      width: 18, type: 'datetime' },
          { key: 'created_by',             header: 'Created By',      width: 14 },
        ],
        rows: ledger,
        totalsFor: 'amount',
      }));

      // Vendors — distinct payees with aggregates
      const { rows: vendors } = await pool.query(`
        WITH v AS (
          SELECT TRIM(payee) AS payee, currency,
                 COUNT(*)            AS invoice_count,
                 SUM(amount)         AS total_spend,
                 MIN(invoice_date)   AS first_invoice,
                 MAX(invoice_date)   AS last_invoice,
                 BOOL_OR(((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)) AS has_w9,
                 MAX(vendor_email)   AS contact_email,
                 MAX(vendor_bank)    AS bank_on_file
            FROM expenses
           WHERE (deleted = false OR deleted IS NULL)
             AND status = 'approved'
             AND payee IS NOT NULL AND TRIM(payee) != ''
           GROUP BY TRIM(payee), currency
        )
        SELECT v.payee, v.currency, v.invoice_count, v.total_spend,
               v.first_invoice, v.last_invoice, v.has_w9, v.contact_email, v.bank_on_file,
               (
                 SELECT STRING_AGG(va.alias, ', ' ORDER BY va.alias)
                   FROM vendor_aliases va
                  WHERE LOWER(va.primary_name) = LOWER(v.payee)
               ) AS aliases
          FROM v
          ORDER BY LOWER(v.payee) ASC, v.currency ASC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Vendors.xlsx`, {
        sheetName: 'Vendors',
        title: 'Market Street — Vendor Directory',
        subtitle: 'Distinct vendors aggregated from approved expenses. Aliases captured separately.',
        columns: [
          { key: 'payee',         header: 'Vendor',         width: 32 },
          { key: 'aliases',       header: 'Also Known As',  width: 28 },
          { key: 'invoice_count', header: 'Invoices',       width: 11 },
          { key: 'total_spend',   header: 'Total Spend',    width: 16, type: 'currency' },
          { key: 'currency',      header: 'Currency',       width: 10 },
          { key: 'first_invoice', header: 'First Invoice',  width: 13, type: 'date' },
          { key: 'last_invoice',  header: 'Last Invoice',   width: 13, type: 'date' },
          { key: 'has_w9',        header: 'W9 on File?',    width: 12, type: 'bool' },
          { key: 'contact_email', header: 'Contact Email',  width: 26 },
          { key: 'bank_on_file',  header: 'Bank Info',      width: 28 },
        ],
        rows: vendors,
        totalsFor: 'total_spend',
      }));

      // Recoupments — recoupable expenses grouped by artist
      const { rows: recoupments } = await pool.query(`
        SELECT e.id, e.invoice_date, e.artist, e.song, e.payee, e.category,
               e.description, e.amount, e.currency, e.ufr, e.recoupment_label,
               e.payment_status, e.cobrand, e.is_reimbursement, r.project_name AS release_name
          FROM expenses e
          LEFT JOIN releases r ON r.id = e.release_id
         WHERE e.recoupable = TRUE
           AND e.status = 'approved'
           AND (e.deleted = false OR e.deleted IS NULL)
         ORDER BY LOWER(COALESCE(e.artist, 'ZZZ')) ASC,
                  LOWER(COALESCE(e.song, '')) ASC,
                  e.invoice_date DESC NULLS LAST
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Recoupments.xlsx`, {
        sheetName: 'Recoupments',
        title: 'Market Street — Recoupable Spend by Artist',
        subtitle: 'Every approved expense marked recoupable, grouped artist → song',
        columns: [
          { key: 'artist',           header: 'Artist',         width: 22 },
          { key: 'song',             header: 'Song',           width: 22 },
          { key: 'release_name',     header: 'Linked Release', width: 22 },
          { key: 'invoice_date',     header: 'Invoice Date',   width: 12, type: 'date' },
          { key: 'payee',            header: 'Payee',          width: 26 },
          { key: 'category',         header: 'Category',       width: 20 },
          { key: 'description',      header: 'Description',    width: 32, wrap: true },
          { key: 'amount',           header: 'Amount',         width: 14, type: 'currency' },
          { key: 'currency',         header: 'Currency',       width: 9  },
          { key: 'cobrand',          header: 'Cobrand',        width: 10, type: 'bool' },
          { key: 'is_reimbursement', header: 'Reimburse?',     width: 12, type: 'bool' },
          { key: 'ufr',              header: 'UFR',            width: 8  },
          { key: 'recoupment_label', header: 'Label',          width: 16 },
          { key: 'payment_status',   header: 'Status',         width: 12 },
        ],
        rows: recoupments,
        totalsFor: 'amount',
      }));

      // Bulk deals — parent rows + their deliverables
      const { rows: bulkDeals } = await pool.query(`
        SELECT e.id, e.invoice_date, e.payee, e.artist, e.amount, e.currency,
               e.bulk_deal_quantity, e.bulk_deal_unit, e.bulk_deal_completed,
               e.payment_status, e.notes,
               COALESCE(items.count, 0)     AS item_count,
               COALESCE(items.done, 0)      AS items_completed
          FROM expenses e
          LEFT JOIN (
            SELECT expense_id,
                   COUNT(*)::int AS count,
                   COUNT(*) FILTER (WHERE completed = TRUE)::int AS done
              FROM bulk_deal_items
             GROUP BY expense_id
          ) items ON items.expense_id = e.id
         WHERE e.is_bulk_deal = TRUE
           AND (e.deleted = false OR e.deleted IS NULL)
         ORDER BY e.invoice_date DESC NULLS LAST, e.id DESC
      `);
      const { rows: bulkItems } = await pool.query(`
        SELECT bdi.id, bdi.expense_id, e.payee, e.artist,
               bdi.title, bdi.video_url, bdi.completed, bdi.completed_at, bdi.position
          FROM bulk_deal_items bdi
          JOIN expenses e ON e.id = bdi.expense_id
         ORDER BY bdi.expense_id ASC, bdi.position ASC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Bulk Deals.xlsx`, {
        sheetName: 'Bulk Deals',
        title: 'Market Street — Bulk Deals',
        subtitle: `${bulkDeals.length} bulk deal${bulkDeals.length === 1 ? '' : 's'} with ${bulkItems.length} item${bulkItems.length === 1 ? '' : 's'} — items appended after the deal list below`,
        columns: [
          { key: 'id',                  header: 'ID',            width: 7  },
          { key: 'invoice_date',        header: 'Date',          width: 12, type: 'date' },
          { key: 'payee',               header: 'Payee',         width: 26 },
          { key: 'artist',              header: 'Artist',        width: 20 },
          { key: 'amount',              header: 'Amount',        width: 14, type: 'currency' },
          { key: 'currency',            header: 'Currency',      width: 9  },
          { key: 'bulk_deal_quantity',  header: 'Quantity',      width: 10 },
          { key: 'bulk_deal_unit',      header: 'Unit',          width: 14 },
          { key: 'item_count',          header: 'Items',         width: 9  },
          { key: 'items_completed',     header: 'Completed',     width: 11 },
          { key: 'bulk_deal_completed', header: 'Archived?',     width: 11, type: 'bool' },
          { key: 'payment_status',      header: 'Payment Status',width: 13 },
          { key: 'notes',               header: 'Notes',         width: 30, wrap: true },
        ],
        rows: bulkDeals,
        totalsFor: 'amount',
      }));
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Bulk Deal Items.xlsx`, {
        sheetName: 'Items',
        title: 'Market Street — Bulk Deal Items',
        subtitle: 'Individual deliverables tied to each bulk deal expense.',
        columns: [
          { key: 'expense_id',   header: 'Deal ID',      width: 9  },
          { key: 'payee',        header: 'Vendor',       width: 26 },
          { key: 'artist',       header: 'Artist',       width: 20 },
          { key: 'title',        header: 'Title',        width: 36, wrap: true },
          { key: 'video_url',    header: 'URL',          width: 38 },
          { key: 'completed',    header: 'Completed?',   width: 12, type: 'bool' },
          { key: 'completed_at', header: 'Completed At', width: 18, type: 'datetime' },
          { key: 'position',     header: 'Order',        width: 8  },
        ],
        rows: bulkItems,
      }));

      // Market Street Invoices (invoices Market Street sent to clients)
      const { rows: boomInvoices } = await pool.query(`
        SELECT id, invoice_number, bill_to, bill_to_address, description, amount,
               purchase_order, due_by, payment_status, line_items, created_by, created_at
          FROM boom_invoices
         ORDER BY invoice_number DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Market Street Invoices.xlsx`, {
        sheetName: 'Market Street Invoices',
        title: 'Market Street — Outgoing Invoices',
        subtitle: 'Invoices Market Street issued (the generator on /create-invoice).',
        columns: [
          { key: 'invoice_number',  header: 'Invoice #',     width: 12 },
          { key: 'bill_to',         header: 'Bill To',       width: 26 },
          { key: 'bill_to_address', header: 'Bill To Address', width: 32, wrap: true },
          { key: 'description',     header: 'Description',   width: 36, wrap: true },
          { key: 'amount',          header: 'Amount',        width: 14, type: 'currency' },
          { key: 'purchase_order',  header: 'PO',            width: 14 },
          { key: 'due_by',          header: 'Due By',        width: 18 },
          { key: 'payment_status',  header: 'Status',        width: 12 },
          { key: 'line_items',      header: 'Line Items',    width: 40, wrap: true, type: 'json' },
          { key: 'created_by',      header: 'Created By',    width: 14 },
          { key: 'created_at',      header: 'Created At',    width: 18, type: 'datetime' },
        ],
        rows: boomInvoices.map(r => ({ ...r, currency: 'USD' })),
        totalsFor: 'amount',
      }));

      // Bookkeeping audit log
      const { rows: bkAudit } = await pool.query(`
        SELECT id, ts, user_name, action, entry_id, entry_payee,
               field, old_value, new_value, details
          FROM bk_audit_log
         ORDER BY ts DESC, id DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Bookkeeping Audit Log.xlsx`, {
        sheetName: 'BK Audit',
        title: 'Market Street — Bookkeeping Audit Trail',
        subtitle: 'Field-level change history for the ledger.',
        columns: [
          { key: 'ts',          header: 'Timestamp',     width: 18, type: 'datetime' },
          { key: 'user_name',   header: 'User',          width: 18 },
          { key: 'action',      header: 'Action',        width: 22 },
          { key: 'entry_id',    header: 'Entry ID',      width: 9  },
          { key: 'entry_payee', header: 'Payee',         width: 24 },
          { key: 'field',       header: 'Field',         width: 18 },
          { key: 'old_value',   header: 'Old Value',     width: 26, wrap: true },
          { key: 'new_value',   header: 'New Value',     width: 26, wrap: true },
          { key: 'details',     header: 'Details',       width: 32, wrap: true },
        ],
        rows: bkAudit,
      }));

      // ───────── File extraction: invoices ─────────
      const { rows: invoiceFiles } = await pool.query(`
        SELECT id, payee, invoice_date, invoice_number,
               invoice_data, invoice_r2_key, invoice_filename
          FROM expenses
         WHERE (deleted = false OR deleted IS NULL)
           AND parent_id IS NULL
           AND ((invoice_data IS NOT NULL AND invoice_data != '') OR invoice_r2_key IS NOT NULL)
         ORDER BY LOWER(TRIM(COALESCE(payee, ''))) ASC, invoice_date ASC NULLS LAST, id ASC
      `);
      for (const r of invoiceFiles) {
        try {
          const buf = await loadFileBuffer(r.invoice_r2_key, r.invoice_data);
          if (!buf) continue;
          const date = r.invoice_date ? String(r.invoice_date).slice(0, 10) : '';
          const inv  = safeName(r.invoice_number || `id${r.id}`, `id${r.id}`);
          const base = `${safeName(r.payee, 'Unknown')}${date ? ` - ${date}` : ''} - ${inv}`;
          appendFile(archive, seen, `${rootDir}/${SECTION}/Invoices`, base, extOf(r.invoice_filename), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] invoice ${r.id} failed:`, err.message);
        }
      }

      // ───────── File extraction: proofs of payment ─────────
      const { rows: proofFiles } = await pool.query(`
        SELECT id, payee, payment_date, invoice_date, invoice_number,
               proof_data, proof_r2_key, proof_filename
          FROM expenses
         WHERE (deleted = false OR deleted IS NULL)
           AND ((proof_data IS NOT NULL AND proof_data != '') OR proof_r2_key IS NOT NULL)
         ORDER BY LOWER(TRIM(COALESCE(payee, ''))) ASC, payment_date ASC NULLS LAST, id ASC
      `);
      for (const r of proofFiles) {
        try {
          const buf = await loadFileBuffer(r.proof_r2_key, r.proof_data);
          if (!buf) continue;
          const date = (r.payment_date || r.invoice_date) ? String(r.payment_date || r.invoice_date).slice(0, 10) : '';
          const inv  = safeName(r.invoice_number || `id${r.id}`, `id${r.id}`);
          const base = `${safeName(r.payee, 'Unknown')}${date ? ` - ${date}` : ''} - ${inv}`;
          appendFile(archive, seen, `${rootDir}/${SECTION}/Proofs of Payment`, base, extOf(r.proof_filename), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] proof ${r.id} failed:`, err.message);
        }
      }

      // ───────── File extraction: W9 / W8 (one per vendor, latest) ─────────
      const { rows: w9Files } = await pool.query(`
        SELECT DISTINCT ON (LOWER(TRIM(payee)))
               id, payee, w9_data, w9_r2_key, w9_filename
          FROM expenses
         WHERE (deleted = false OR deleted IS NULL)
           AND ((w9_data IS NOT NULL AND w9_data != '') OR w9_r2_key IS NOT NULL)
         ORDER BY LOWER(TRIM(payee)) ASC, id DESC
      `);
      for (const r of w9Files) {
        try {
          const buf = await loadFileBuffer(r.w9_r2_key, r.w9_data);
          if (!buf) continue;
          appendFile(archive, seen, `${rootDir}/${SECTION}/W9s and W8s`, safeName(r.payee, `id${r.id}`), extOf(r.w9_filename), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] w9 ${r.id} failed:`, err.message);
        }
      }

      // ───────── File extraction: reimbursement receipts ─────────
      const { rows: receiptFiles } = await pool.query(`
        SELECT id, payee, artist, invoice_date, receipt_data, receipt_filename
          FROM expenses
         WHERE (deleted = false OR deleted IS NULL)
           AND receipt_data IS NOT NULL AND receipt_data != ''
         ORDER BY invoice_date DESC NULLS LAST, id DESC
      `);
      for (const r of receiptFiles) {
        try {
          const buf = Buffer.from(r.receipt_data, 'base64');
          const date = r.invoice_date ? String(r.invoice_date).slice(0, 10) : '';
          const base = `${safeName(r.payee, 'Unknown')}${date ? ` - ${date}` : ''} - id${r.id}`;
          appendFile(archive, seen, `${rootDir}/${SECTION}/Receipts`, base, extOf(r.receipt_filename), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] receipt ${r.id} failed:`, err.message);
        }
      }

      // Multi-file expense_receipts via entity_files
      const { rows: receiptMulti } = await pool.query(`
        SELECT ef.id, ef.entity_id, ef.r2_key, ef.file_data, ef.original_name, ef.label,
               e.payee, e.invoice_date
          FROM entity_files ef
          JOIN expenses e ON e.id = ef.entity_id
         WHERE ef.entity_type = 'expense_receipt'
         ORDER BY e.invoice_date DESC NULLS LAST, ef.id ASC
      `);
      for (const r of receiptMulti) {
        try {
          const buf = await loadFileBuffer(r.r2_key, r.file_data);
          if (!buf) continue;
          const date = r.invoice_date ? String(r.invoice_date).slice(0, 10) : '';
          const orig = r.original_name || `file-${r.id}`;
          const base = `${safeName(r.payee, 'Unknown')}${date ? ` - ${date}` : ''} - ${safeName(orig)}`;
          appendFile(archive, seen, `${rootDir}/${SECTION}/Receipts (Multi-File)`, base, extOf(orig), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] multi-receipt ${r.id} failed:`, err.message);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 02 — Roster
    // ════════════════════════════════════════════════════════════════════════
    {
      const SECTION = '02 Roster';
      const { rows: artists } = await pool.query(`
        SELECT a.id, a.name, a.genre, a.total_releases, a.created_at,
               (SELECT COUNT(*) FROM contracts c WHERE c.artist_id = a.id)::int AS contract_count,
               (SELECT COUNT(*) FROM releases  r WHERE r.artist_id = a.id)::int AS release_count
          FROM artists a
         ORDER BY LOWER(a.name) ASC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Artists.xlsx`, {
        sheetName: 'Artists',
        title: 'Market Street — Artist Roster',
        subtitle: 'Every artist with rollups for contracts and releases.',
        columns: [
          { key: 'id',              header: 'ID',          width: 7  },
          { key: 'name',            header: 'Artist',      width: 28 },
          { key: 'genre',           header: 'Genre',       width: 18 },
          { key: 'release_count',   header: 'Releases',    width: 11 },
          { key: 'contract_count',  header: 'Contracts',   width: 11 },
          { key: 'total_releases',  header: 'Total (legacy)', width: 14 },
          { key: 'created_at',      header: 'Created At',  width: 18, type: 'datetime' },
        ],
        rows: artists,
      }));

      // Artist files (entity_files where entity_type='artist')
      const { rows: artistFiles } = await pool.query(`
        SELECT ef.id, ef.r2_key, ef.file_data, ef.original_name, ef.label, ef.uploaded_at,
               a.name AS artist_name
          FROM entity_files ef
          JOIN artists a ON a.id = ef.entity_id
         WHERE ef.entity_type = 'artist'
         ORDER BY LOWER(a.name) ASC, ef.uploaded_at ASC
      `);
      {
        for (const r of artistFiles) {
          try {
            const buf = await loadFileBuffer(r.r2_key, r.file_data);
            if (!buf) continue;
            const folder = `${rootDir}/${SECTION}/Artist Files/${safeName(r.artist_name, 'Unknown')}`;
            const orig = r.original_name || `file-${r.id}`;
            appendFile(archive, seen, folder, `${r.label ? safeName(r.label) + ' - ' : ''}${safeName(orig.replace(/\.[^.]+$/, ''))}`, extOf(orig), buf);
            incFile(SECTION);
          } catch (err) {
            console.warn(`[full-export] artist file ${r.id} failed:`, err.message);
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 03 — Contracts and Deals
    // ════════════════════════════════════════════════════════════════════════
    {
      const SECTION = '03 Contracts and Deals';

      const { rows: contracts } = await pool.query(`
        SELECT c.id, a.name AS artist_name, c.type, c.date_signed, c.expiration_date,
               c.status, c.royalty_split, c.advance, c.territory, c.num_releases,
               c.notes, c.financial_terms, c.created_at
          FROM contracts c
          LEFT JOIN artists a ON a.id = c.artist_id
         ORDER BY c.date_signed DESC NULLS LAST, c.id DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Contracts.xlsx`, {
        sheetName: 'Contracts',
        title: 'Market Street — Active Contracts',
        subtitle: 'Signed agreements with their financial obligations.',
        columns: [
          { key: 'artist_name',     header: 'Artist',         width: 24 },
          { key: 'type',            header: 'Type',           width: 16 },
          { key: 'status',          header: 'Status',         width: 12 },
          { key: 'date_signed',     header: 'Signed',         width: 12, type: 'date' },
          { key: 'expiration_date', header: 'Expires',        width: 12, type: 'date' },
          { key: 'royalty_split',   header: 'Royalty Split',  width: 16 },
          { key: 'advance',         header: 'Advance',        width: 14 },
          { key: 'territory',       header: 'Territory',      width: 16 },
          { key: 'num_releases',    header: '# Releases',     width: 12 },
          { key: 'financial_terms', header: 'Financial Terms', width: 40, wrap: true, type: 'json' },
          { key: 'notes',           header: 'Notes',          width: 30, wrap: true },
          { key: 'created_at',      header: 'Created At',     width: 18, type: 'datetime' },
        ],
        rows: contracts,
      }));

      const { rows: pending } = await pool.query(`
        SELECT id, artist_name, legal_name, address, cash, split, years, options,
               back_signs, futures, status, email, notes, created_at, updated_at
          FROM pending_contracts
         ORDER BY status, LOWER(artist_name)
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Pending Contracts.xlsx`, {
        sheetName: 'Pending',
        title: 'Market Street — Pending Contracts',
        subtitle: 'Deal pipeline before contracts are signed.',
        columns: [
          { key: 'artist_name',header: 'Artist',     width: 24 },
          { key: 'status',     header: 'Status',     width: 12 },
          { key: 'legal_name', header: 'Legal Name', width: 24 },
          { key: 'address',    header: 'Address',    width: 32, wrap: true },
          { key: 'email',      header: 'Email',      width: 24 },
          { key: 'cash',       header: 'Cash',       width: 14 },
          { key: 'split',      header: 'Split',      width: 14 },
          { key: 'years',      header: 'Years',      width: 12 },
          { key: 'options',    header: 'Options',    width: 18 },
          { key: 'back_signs', header: 'Back Signs', width: 18 },
          { key: 'futures',    header: 'Futures',    width: 18 },
          { key: 'notes',      header: 'Notes',      width: 30, wrap: true },
          { key: 'created_at', header: 'Created',    width: 18, type: 'datetime' },
          { key: 'updated_at', header: 'Updated',    width: 18, type: 'datetime' },
        ],
        rows: pending,
      }));

      const { rows: deals } = await pool.query(`
        SELECT id, artist_name, genre, stage, ar_rep, source, notes,
               added_date, created_at, updated_at
          FROM deals
         ORDER BY added_date DESC NULLS LAST, id DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Deals.xlsx`, {
        sheetName: 'Deals',
        title: 'Market Street — Deal Pipeline',
        subtitle: 'A&R prospects at every stage.',
        columns: [
          { key: 'artist_name', header: 'Artist',  width: 24 },
          { key: 'stage',       header: 'Stage',   width: 18 },
          { key: 'ar_rep',      header: 'A&R Rep', width: 18 },
          { key: 'genre',       header: 'Genre',   width: 14 },
          { key: 'source',      header: 'Source',  width: 18 },
          { key: 'added_date',  header: 'Added',   width: 12, type: 'date' },
          { key: 'notes',       header: 'Notes',   width: 36, wrap: true },
          { key: 'updated_at',  header: 'Updated', width: 18, type: 'datetime' },
        ],
        rows: deals,
      }));

      const { rows: ndas } = await pool.query(`
        SELECT id, effective_date, owner_name, owner_address, recipient_name,
               recipient_address, disclosed_to, signatory_name, signatory_title,
               include_non_circumvention, include_non_solicitation,
               created_by, created_at
          FROM boom_ndas
         ORDER BY effective_date DESC NULLS LAST, id DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/NDAs.xlsx`, {
        sheetName: 'NDAs',
        title: 'Market Street — Generated NDAs',
        subtitle: 'NDAs issued via the Create NDA page. PDFs are rendered client-side; only form values persist.',
        columns: [
          { key: 'effective_date',           header: 'Effective Date', width: 14, type: 'date' },
          { key: 'owner_name',               header: 'Owner',          width: 24 },
          { key: 'recipient_name',           header: 'Recipient',      width: 24 },
          { key: 'recipient_address',        header: 'Recipient Addr', width: 32, wrap: true },
          { key: 'signatory_name',           header: 'Signatory',      width: 22 },
          { key: 'signatory_title',          header: 'Title',          width: 18 },
          { key: 'disclosed_to',             header: 'Disclosed To',   width: 28, wrap: true },
          { key: 'include_non_circumvention',header: 'Non-Circumvent?',width: 17, type: 'bool' },
          { key: 'include_non_solicitation', header: 'Non-Solicit?',   width: 14, type: 'bool' },
          { key: 'created_by',               header: 'Created By',     width: 16 },
          { key: 'created_at',               header: 'Created At',     width: 18, type: 'datetime' },
        ],
        rows: ndas,
      }));

      // Files: contracts / deals / pending_contracts (entity_files)
      for (const [entityType, label] of [
        ['contract',         'Contract Files'],
        ['deal',             'Deal Files'],
      ]) {
        const { rows: files } = await pool.query(`
          SELECT ef.id, ef.r2_key, ef.file_data, ef.original_name, ef.label,
                 ef.uploaded_at, ef.entity_id,
                 CASE
                   WHEN $1 = 'contract' THEN (SELECT a.name FROM contracts c LEFT JOIN artists a ON a.id = c.artist_id WHERE c.id = ef.entity_id)
                   WHEN $1 = 'deal'     THEN (SELECT artist_name FROM deals WHERE id = ef.entity_id)
                   ELSE NULL
                 END AS holder
            FROM entity_files ef
           WHERE ef.entity_type = $1
           ORDER BY holder ASC NULLS LAST, ef.uploaded_at ASC
        `, [entityType]);
        for (const r of files) {
          try {
            const buf = await loadFileBuffer(r.r2_key, r.file_data);
            if (!buf) continue;
            const folder = `${rootDir}/${SECTION}/${label}/${safeName(r.holder, 'Unassigned')}`;
            const orig = r.original_name || `file-${r.id}`;
            appendFile(archive, seen, folder, `${r.label ? safeName(r.label) + ' - ' : ''}${safeName(orig.replace(/\.[^.]+$/, ''))}`, extOf(orig), buf);
            incFile(SECTION);
          } catch (err) {
            console.warn(`[full-export] ${entityType} file ${r.id} failed:`, err.message);
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 04 — Admin Documents
    // ════════════════════════════════════════════════════════════════════════
    {
      const SECTION = '04 Admin Documents';
      const { rows: docs } = await pool.query(`
        SELECT d.id, d.title, d.category, d.counterparty, d.status, d.confidentiality,
               d.date_signed, d.expiration_date, d.tags, d.notes, d.is_template,
               u.name AS created_by_name, d.created_at, d.updated_at,
               (SELECT COUNT(*) FROM entity_files ef WHERE ef.entity_type = 'admin_document' AND ef.entity_id = d.id)::int AS file_count
          FROM admin_documents d
          LEFT JOIN users u ON u.id = d.created_by
         ORDER BY d.created_at DESC
      `);
      incRec(SECTION, await appendWorkbook(archive, `${rootDir}/${SECTION}/Admin Documents.xlsx`, {
        sheetName: 'Documents',
        title: 'Market Street — Admin Document Vault',
        subtitle: 'Legal, HR, IP, compliance, and policy documents.',
        columns: [
          { key: 'title',           header: 'Title',           width: 30 },
          { key: 'category',        header: 'Category',        width: 18 },
          { key: 'counterparty',    header: 'Counterparty',    width: 22 },
          { key: 'status',          header: 'Status',          width: 12 },
          { key: 'confidentiality', header: 'Confidentiality', width: 14 },
          { key: 'date_signed',     header: 'Signed',          width: 12, type: 'date' },
          { key: 'expiration_date', header: 'Expires',         width: 12, type: 'date' },
          { key: 'is_template',     header: 'Template?',       width: 11, type: 'bool' },
          { key: 'file_count',      header: 'Files',           width: 8  },
          { key: 'tags',            header: 'Tags',            width: 24, wrap: true, type: 'json' },
          { key: 'notes',           header: 'Notes',           width: 30, wrap: true },
          { key: 'created_by_name', header: 'Created By',      width: 16 },
          { key: 'created_at',      header: 'Created',         width: 18, type: 'datetime' },
        ],
        rows: docs,
      }));

      const { rows: adminFiles } = await pool.query(`
        SELECT ef.id, ef.r2_key, ef.file_data, ef.original_name, ef.label, ef.uploaded_at,
               d.title, d.category
          FROM entity_files ef
          JOIN admin_documents d ON d.id = ef.entity_id
         WHERE ef.entity_type = 'admin_document'
         ORDER BY LOWER(d.category) NULLS LAST, LOWER(d.title), ef.uploaded_at ASC
      `);
      for (const r of adminFiles) {
        try {
          const buf = await loadFileBuffer(r.r2_key, r.file_data);
          if (!buf) continue;
          const folder = `${rootDir}/${SECTION}/Files/${safeName(r.category, 'Uncategorized')}/${safeName(r.title, 'Untitled')}`;
          const orig = r.original_name || `file-${r.id}`;
          appendFile(archive, seen, folder, safeName(orig.replace(/\.[^.]+$/, '')), extOf(orig), buf);
          incFile(SECTION);
        } catch (err) {
          console.warn(`[full-export] admin doc file ${r.id} failed:`, err.message);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // README + manifest
    // ════════════════════════════════════════════════════════════════════════
    const tally = (s) => counts[s] || { records: 0, files: 0 };
    const totalRecords = Object.values(counts).reduce((a, c) => a + c.records, 0);
    const totalFiles   = Object.values(counts).reduce((a, c) => a + c.files,   0);

    const exporter = req.user.name || req.user.email || `user#${req.user.id}`;
    const generatedAt = new Date().toISOString();

    const readme = [
      '# Market Street — Full Archive',
      '',
      `**Generated:** ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}`,
      `**By:** ${exporter}`,
      `**Records exported:** ${totalRecords.toLocaleString()} across ${Object.keys(counts).length} sections`,
      `**Files exported:** ${totalFiles.toLocaleString()}`,
      '',
      'This archive is a complete snapshot of every business-relevant table and document attachment from the Market Street dashboard (marketst-dashboard.up.railway.app). Each section folder contains one or more `.xlsx` workbooks (styled, filterable, with totals) plus the original PDF / image attachments organized by section.',
      '',
      '## Contents',
      '',
      '### 01 Bookkeeping',
      '- `Ledger.xlsx` — every expense ever recorded, including pending, deleted, and voided rows, with payment, vendor, approval, and recoupment context.',
      '- `Vendors.xlsx` — distinct vendor directory with invoice counts, totals, W9 status, contact info, and aliases.',
      '- `Recoupments.xlsx` — every approved expense flagged recoupable, sorted artist → song.',
      '- `Bulk Deals.xlsx` / `Bulk Deal Items.xlsx` — bulk creator deals and their per-creator deliverables.',
      '- `Market Street Invoices.xlsx` — invoices Market Street sent out.',
      '- `Bookkeeping Audit Log.xlsx` — field-level change history.',
      '- `Invoices/`, `Proofs of Payment/`, `W9s and W8s/`, `Receipts/`, `Receipts (Multi-File)/` — original document files, filename-friendly.',
      '',
      '### 02 Roster',
      '- `Artists.xlsx` — every artist with rollup counts.',
      '- `Artist Files/` — uploaded artist documents.',
      '',
      '### 03 Contracts and Deals',
      '- `Contracts.xlsx`, `Pending Contracts.xlsx`, `Deals.xlsx`, `NDAs.xlsx`.',
      '- `Contract Files/`, `Deal Files/` — uploaded agreements organized by artist / deal.',
      '',
      '### 04 Admin Documents',
      '- `Admin Documents.xlsx` — legal, HR, IP, compliance, policy vault metadata.',
      '- `Files/` — the documents themselves, grouped by category and title.',
      '',
      '## Section tallies',
      '',
      '| Section | Records | Files |',
      '| --- | ---: | ---: |',
      ...Object.keys(counts).sort().map(k => `| ${k} | ${tally(k).records.toLocaleString()} | ${tally(k).files.toLocaleString()} |`),
      `| **TOTAL** | **${totalRecords.toLocaleString()}** | **${totalFiles.toLocaleString()}** |`,
      '',
      '## Notes',
      '',
      '- All workbooks are styled the same way: red branded header, frozen header row, auto-filter, alternating row tints, and per-currency totals where applicable.',
      '- File names use `<Vendor> - <Date> - <Invoice#>.<ext>` so the lists sort alphabetically when opened.',
      '- W9 / W8 files are deduplicated to one per vendor (the most recent on file).',
      '- See `manifest.json` for the same totals in machine-readable form.',
    ].join('\n');

    archive.append(readme, { name: `${rootDir}/README.md` });

    const manifest = {
      schemaVersion: 1,
      generatedAt,
      exportedBy: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
      app: 'Market Street Dashboard',
      host: req.get('host') || null,
      totals: { records: totalRecords, files: totalFiles, sections: Object.keys(counts).length },
      sections: counts,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: `${rootDir}/manifest.json` });

    await archive.finalize();
  } catch (err) {
    console.error('[full-export] fatal:', err);
    // Best-effort: try to finalize what we have so the user gets a partial archive
    try {
      archive.append(`Export failed partway through: ${err.message}\nGenerated: ${new Date().toISOString()}\n`, { name: `${rootDir}/ERROR.txt` });
      await archive.finalize();
    } catch {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
  }
});

module.exports = router;
