/**
 * Google Sheets export — one living spreadsheet, refreshed in place.
 *
 * Raw HTTPS, no SDK, mirroring services/email.js. That is a deliberate choice
 * rather than laziness: adding `googleapis` (a very large transitive tree) to
 * server/package.json is exactly the change shape that fails a Railway build
 * while /health keeps answering 200 on the previous version, so a dependency is
 * a cost worth avoiding for four REST calls we can write by hand.
 *
 * ── The refresh-in-place contract ────────────────────────────────────────────
 *
 * The spreadsheet id is persisted in `_meta`, so every export targets the same
 * file and the URL you bookmark stays valid. Two consequences fall out of that
 * and both are handled below:
 *
 *   1. VALUES MUST BE CLEARED FIRST. A twelve-month P&L refreshed as a one-month
 *      P&L would otherwise leave the old rows sitting underneath the new ones,
 *      reading as real data with no indication they are eleven months stale.
 *   2. FORMATTING MUST BE RESET TOO. Clearing values leaves bold and number
 *      formats behind, so a row that used to be "Total Expenses" and is now
 *      blank keeps its emphasis. The style batch resets the grid before it
 *      styles it.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * Needs `https://www.googleapis.com/auth/drive.file` on GMAIL_REFRESH_TOKEN.
 * That scope is least privilege on purpose: it lets the app create files and
 * manage ONLY the files it created, and gives it no ability to read anything
 * else in that Drive. Do not widen it to `drive` or `spreadsheets` — neither is
 * needed, and both hand a bookkeeping app the keys to an entire Drive.
 *
 * A token minted with Gmail scopes alone gets a 403 from Google with an opaque
 * message; `describeGoogleError` translates it into the actual instruction.
 */
const https = require('https');
const { getAccessTokenInfo, credentialsPresent } = require('../lib/google-oauth');
const { KIND } = require('../lib/report-rows');

const META_KEY = 'reports_spreadsheet_id';
const SPREADSHEET_TITLE = 'Market Street — Reports';

const MONEY_FORMAT = '"$"#,##0.00;[Red]("$"#,##0.00)';
const HEADER_RGB = { red: 0x7F / 255, green: 0x1D / 255, blue: 0x1D / 255 };
const GREY_RGB   = { red: 0x9C / 255, green: 0xA3 / 255, blue: 0xAF / 255 };
const WHITE_RGB  = { red: 1, green: 1, blue: 1 };

class SheetsError extends Error {
  constructor(message, { configured = true } = {}) {
    super(message);
    this.name = 'SheetsError';
    this.sheetsConfigured = configured;
  }
}

// ── transport ────────────────────────────────────────────────────────────────

function request(token, { host, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: host,
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error(describeGoogleError(res.statusCode, json));
        err.status = res.statusCode;
        err.google = json;
        reject(err);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function describeGoogleError(status, json) {
  const msg = json?.error?.message || json?.error_description || json?.raw || `HTTP ${status}`;
  if (status === 403 && /scope/i.test(String(msg))) {
    return 'Google rejected the request for insufficient scope. The refresh token was minted for '
      + 'Gmail only — re-mint it with https://www.googleapis.com/auth/drive.file added and update '
      + 'GMAIL_REFRESH_TOKEN on Railway.';
  }
  // The OAuth project was set up for Gmail, so the Sheets and Drive APIs are
  // very likely switched off on it. Google's own message carries the activation
  // link, which is more useful than anything paraphrased — pass it through and
  // say which console page it means.
  if (status === 403 && /has not been used in project|is disabled/i.test(String(msg))) {
    return `${msg} (Enable the Google Sheets API and the Google Drive API on the same Cloud project as the Gmail OAuth client.)`;
  }
  if (status === 401) {
    return `Google rejected the credentials (${msg}). GMAIL_REFRESH_TOKEN may have been revoked.`;
  }
  return `Google Sheets API: ${msg}`;
}

const sheets = (token, method, path, body) => request(token, { host: 'sheets.googleapis.com', method, path, body });
const drive  = (token, method, path, body) => request(token, { host: 'www.googleapis.com', method, path, body });

// ── the spreadsheet itself ───────────────────────────────────────────────────

async function readStoredId(pool) {
  const r = await pool.query('SELECT value FROM _meta WHERE key = $1', [META_KEY]);
  return r.rows[0]?.value || null;
}

async function storeId(pool, id) {
  await pool.query(
    `INSERT INTO _meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, id],
  );
}

/**
 * The spreadsheet to write into, creating it on first use.
 *
 * A stored id that Google no longer serves (file trashed, or _meta restored from
 * a different environment) is treated as absent rather than fatal — the export
 * makes a new sheet and re-points _meta. The old URL goes stale in that case,
 * which is the correct trade against refusing to export at all.
 */
async function ensureSpreadsheet(pool, token, tabTitles) {
  const storedId = await readStoredId(pool);
  if (storedId) {
    try {
      const meta = await sheets(token, 'GET',
        `/v4/spreadsheets/${encodeURIComponent(storedId)}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`);
      return { meta, created: false };
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      console.warn(`[sheets] stored spreadsheet ${storedId} unreachable (${err.status}) — creating a new one`);
    }
  }

  const created = await sheets(token, 'POST', '/v4/spreadsheets', {
    properties: { title: SPREADSHEET_TITLE },
    // Named explicitly so the file never carries an empty default "Sheet1".
    sheets: tabTitles.map((title, index) => ({ properties: { title, index } })),
  });
  await storeId(pool, created.spreadsheetId);
  return { meta: created, created: true };
}

/**
 * Give the person who ran the export access to the file.
 *
 * The file is owned by the GMAIL_USER account, so anyone else — including John,
 * if the app's Google account is not his own login — cannot open it by default.
 * Permitted under drive.file because the app created the file.
 *
 * Never fatal: a sharing failure must not lose an export that already succeeded.
 * The caller reports it as a warning instead.
 */
async function shareWith(token, spreadsheetId, email) {
  if (!email) return null;
  // The file is already owned by GMAIL_USER — asking Drive to grant that
  // account access to its own file errors, and surfacing that as a warning on
  // every single export would train people to ignore the warning line.
  if (email.toLowerCase() === String(process.env.GMAIL_USER || '').toLowerCase()) return null;
  try {
    await drive(token, 'POST',
      `/drive/v3/files/${encodeURIComponent(spreadsheetId)}/permissions?sendNotificationEmail=false`,
      { role: 'writer', type: 'user', emailAddress: email });
    return null;
  } catch (err) {
    console.warn(`[sheets] could not share with ${email}: ${err.message}`);
    return err.message;
  }
}

// ── rendering the row model ──────────────────────────────────────────────────

/**
 * Model rows → the 2D value grid Sheets writes.
 *
 * A blank row is [''] and not []. Both are accepted, and the API maps inner
 * arrays to rows positionally either way — but if that were ever not true, an
 * elided empty row would shift every figure below it up by one and the report
 * would still look perfectly well-formed. [''] cannot do that. The cost is an
 * empty string in a cell nobody reads.
 */
function toGrid(model) {
  return model.rows.map((row) => {
    if (row.kind === KIND.BLANK) return [''];
    return [row.label, ...(row.values || [])];
  });
}

/** Rows/columns this model needs. A new sheet is only 1000×26. */
function gridSize(model) {
  let cols = 1;
  for (const row of model.rows) cols = Math.max(cols, 1 + (row.values ? row.values.length : 0));
  return { rows: model.rows.length, cols };
}

const textFormat = (f) => ({ userEnteredFormat: { textFormat: f } });

/** Model rows → the formatting requests for one tab. */
function styleRequests(model, sheetId) {
  const reqs = [];

  // Reset first. Clearing values does not clear formatting, so without this a
  // shrinking report keeps the emphasis of the rows it no longer has.
  reqs.push({
    repeatCell: {
      range: { sheetId },
      cell: { userEnteredFormat: {} },
      fields: 'userEnteredFormat',
    },
  });

  reqs.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: {
          frozenRowCount: model.freeze.rows,
          frozenColumnCount: model.freeze.cols,
        },
      },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  model.widths.forEach((w, i) => {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        // ExcelJS widths are in characters; Sheets wants pixels.
        properties: { pixelSize: Math.round(w * 7 + 12) },
        fields: 'pixelSize',
      },
    });
  });

  const at = (rowIndex, startCol, endCol, cell, fields) => reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: startCol, endColumnIndex: endCol },
      cell,
      fields,
    },
  });

  model.rows.forEach((row, i) => {
    const valueEnd = 1 + (row.values ? row.values.length : 0);
    switch (row.kind) {
      case KIND.TITLE:
        at(i, 0, 1, textFormat({ bold: true, fontSize: 16, foregroundColor: HEADER_RGB }), 'userEnteredFormat.textFormat');
        break;
      case KIND.SUBTITLE:
        at(i, 0, 1, textFormat({ fontSize: 9, foregroundColor: GREY_RGB }), 'userEnteredFormat.textFormat');
        break;
      case KIND.HEADER:
        at(i, 0, valueEnd, {
          userEnteredFormat: {
            backgroundColor: HEADER_RGB,
            textFormat: { bold: true, fontSize: 10, foregroundColor: WHITE_RGB },
            verticalAlignment: 'MIDDLE',
          },
        }, 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)');
        break;
      case KIND.SECTION:
        at(i, 0, 1, textFormat({ bold: true, fontSize: row.size || 11, foregroundColor: HEADER_RGB }), 'userEnteredFormat.textFormat');
        break;
      case KIND.NOTE:
        at(i, 0, 1, textFormat({ fontSize: 9, italic: true, foregroundColor: GREY_RGB }), 'userEnteredFormat.textFormat');
        break;
      case KIND.LINE:
        at(i, 1, valueEnd, {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: MONEY_FORMAT },
            ...(row.bold ? { textFormat: { bold: true } } : {}),
          },
        }, row.bold
          ? 'userEnteredFormat(numberFormat,textFormat)'
          : 'userEnteredFormat.numberFormat');
        if (row.bold) at(i, 0, 1, textFormat({ bold: true }), 'userEnteredFormat.textFormat');
        break;
      default:
        break;
    }
  });

  return reqs;
}

// ── the export ───────────────────────────────────────────────────────────────

/**
 * Write the given tabs into the one living spreadsheet.
 *
 * @param {object} pool  pg pool
 * @param {Array}  tabs  [{ title, model }] — model from lib/report-rows
 * @param {object} opts  { shareWith: email }
 * @returns {{url, spreadsheetId, created, shareWarning}}
 */
async function writeReport(pool, tabs, opts = {}) {
  if (!credentialsPresent()) {
    throw new SheetsError(
      'Google Sheets access is not configured — GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / '
      + 'GMAIL_REFRESH_TOKEN must be set on the server.',
      { configured: false },
    );
  }

  // Check the scope BEFORE calling Google, so the failure names the actual
  // state of the token instead of relaying a 403 that reads the same whether
  // the token is wrong or an API is switched off. Enabling the Sheets and Drive
  // APIs does NOT change an already-issued token — that distinction is the
  // whole reason this check exists.
  const { token, scopes } = await getAccessTokenInfo();
  const WRITE_SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ];
  if (scopes.length && !scopes.some((s) => WRITE_SCOPES.includes(s))) {
    throw new SheetsError(
      'GMAIL_REFRESH_TOKEN has not been re-minted yet. Google reports it currently grants: '
      + `${scopes.join(', ')} — and no Sheets/Drive scope. Enabling the APIs does not change an `
      + 'already-issued token: re-run get-refresh-token.js (it now requests drive.file alongside '
      + 'Gmail), approve in the browser, and replace GMAIL_REFRESH_TOKEN on Railway.',
      { configured: false },
    );
  }

  const titles = tabs.map((t) => t.title);
  const { meta, created } = await ensureSpreadsheet(pool, token, titles);
  const spreadsheetId = meta.spreadsheetId;

  // Tabs present in the stored file may not match what we are about to write —
  // a sheet created before a tab existed, or renamed by hand.
  let byTitle = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
  const missing = titles.filter((t) => !byTitle.has(t));
  if (missing.length) {
    await sheets(token, 'POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    });
    const refreshed = await sheets(token, 'GET',
      `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    byTitle = new Map((refreshed.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
  }

  // 1. Make the grid big enough BEFORE writing into it. A new sheet is 1000×26,
  //    and reports.js allows up to 120 monthly columns — a five-year P&L needs
  //    62 and would otherwise be rejected outright with "range exceeds grid
  //    limits". Only ever grows, so a hand-widened sheet is never truncated.
  const resize = [];
  for (const t of tabs) {
    const need = gridSize(t.model);
    const props = (meta.sheets || []).find((s) => s.properties.title === t.title)?.properties?.gridProperties || {};
    resize.push({
      updateSheetProperties: {
        properties: {
          sheetId: byTitle.get(t.title),
          gridProperties: {
            rowCount: Math.max(need.rows + 10, props.rowCount || 0, 100),
            columnCount: Math.max(need.cols, props.columnCount || 0, 26),
          },
        },
        fields: 'gridProperties.rowCount,gridProperties.columnCount',
      },
    });
  }
  await sheets(token, 'POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { requests: resize });

  // 2. Clear values. A bare sheet name as the range means the whole sheet.
  for (const t of titles) {
    await sheets(token, 'POST',
      `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}:clear`, {});
  }

  // 3. Write values. RAW so a number stays a number and a note reading
  //    "$1,234" stays the text we wrote rather than being reinterpreted.
  await sheets(token, 'POST', `/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: tabs.map((t) => ({
      range: `'${t.title.replace(/'/g, "''")}'!A1`,
      majorDimension: 'ROWS',
      values: toGrid(t.model),
    })),
  });

  // 4. Reset and apply formatting, all tabs in one call.
  const requests = tabs.flatMap((t) => styleRequests(t.model, byTitle.get(t.title)));
  if (requests.length) {
    await sheets(token, 'POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { requests });
  }

  const shareWarning = await shareWith(token, spreadsheetId, opts.shareWith);

  return {
    url: meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    spreadsheetId,
    created,
    shareWarning,
  };
}

module.exports = { writeReport, SheetsError, SPREADSHEET_TITLE };
