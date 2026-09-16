// Import an Ads Manager export — for PROPORTIONS only.
//
// ── Why there is no parser here ──
// Nobody has handed this app a sample export, and a parser written against
// guessed column names is a parser that fails on the first real file. So the file
// is never assumed: its header row is read, shown, and pointed at. The mapping is
// remembered per platform, so it is a one-time step and the second import is a
// drop-and-go.
//
// ── The file is not the money ──
// Ads Manager's spend will not equal the bank — taxes, credits, currency, and
// charges landing days after the spend. Rather than allocating the report's
// figures and parking a difference, its numbers are treated as WEIGHTS and the
// month's ACTUAL charges are divided by them (`proportional` on the server, which
// apportions to the cent). 100% of the real money is allocated, so the tie-out
// holds by construction and there is no remainder to explain.

import { useMemo, useState } from 'react'
import { Upload, X } from 'lucide-react'

const usd = (n) => (Number(n) || 0).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

/**
 * A CSV row splitter that survives quoted commas — the first thing a campaign
 * name with a comma in it would otherwise break.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map(splitCsvLine).filter((r) => r.length === header.length);
  return { header, rows };
}

const MAP_KEY = 'ad_import_map_v1';
const loadMap = (platform) => {
  try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}')[platform] || null; } catch { return null; }
};
const saveMap = (platform, m) => {
  try {
    const all = JSON.parse(localStorage.getItem(MAP_KEY) || '{}');
    all[platform] = m;
    localStorage.setItem(MAP_KEY, JSON.stringify(all));
  } catch { /* a remembered mapping is a convenience, never a requirement */ }
};

/** Best guess at which app campaign an exported name refers to. A SUGGESTION. */
function suggest(name, campaigns) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  const exact = campaigns.find((c) => String(c.name).trim().toLowerCase() === n);
  if (exact) return String(exact.id);
  // Containment either way, longest first, so "Jerri — Nightcall — Q3" finds
  // "Nightcall" rather than whichever short name happened to be first.
  const hits = campaigns
    .filter((c) => {
      const cn = String(c.name).trim().toLowerCase();
      return cn.length > 2 && (n.includes(cn) || cn.includes(n));
    })
    .sort((a, b) => String(b.name).length - String(a.name).length);
  return hits.length ? String(hits[0].id) : '';
}

export default function ImportMapper({ campaigns = [], platform = 'Facebook', busy = false,
  onCancel, onPreview }) {
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState(null);
  const [nameCol, setNameCol] = useState('');
  const [spendCol, setSpendCol] = useState('');
  const [links, setLinks] = useState({});

  const take = async (f) => {
    if (!f) return;
    const text = await f.text();
    const parsed = parseCsv(text);
    setFile(f); setCsv(parsed);
    const remembered = loadMap(platform);
    const has = (c) => c && parsed.header.includes(c);
    setNameCol(has(remembered?.nameCol) ? remembered.nameCol
      : (parsed.header.find((h) => /campaign/i.test(h)) || ''));
    setSpendCol(has(remembered?.spendCol) ? remembered.spendCol
      : (parsed.header.find((h) => /spend|amount|cost/i.test(h)) || ''));
    setLinks({});
  };

  // One entry per exported campaign, spend summed — an export is usually a row
  // per campaign per day.
  const grouped = useMemo(() => {
    if (!csv || !nameCol || !spendCol) return [];
    const ni = csv.header.indexOf(nameCol);
    const si = csv.header.indexOf(spendCol);
    if (ni < 0 || si < 0) return [];
    const by = new Map();
    for (const r of csv.rows) {
      const name = r[ni];
      const spend = Number(String(r[si] || '').replace(/[^0-9.-]/g, '')) || 0;
      if (!name || spend <= 0) continue;
      by.set(name, (by.get(name) || 0) + spend);
    }
    return [...by.entries()]
      .map(([name, spend]) => ({ name, spend }))
      .sort((a, b) => b.spend - a.spend);
  }, [csv, nameCol, spendCol]);

  const total = grouped.reduce((s, g) => s + g.spend, 0);
  const linkFor = (g) => (links[g.name] !== undefined ? links[g.name] : suggest(g.name, campaigns));
  const mapped = grouped.filter((g) => linkFor(g));
  const mappedTotal = mapped.reduce((s, g) => s + g.spend, 0);

  const go = () => {
    saveMap(platform, { nameCol, spendCol });
    // Weights, not amounts. The server divides the month's real charges by these.
    const byCampaign = new Map();
    for (const g of mapped) {
      const id = Number(linkFor(g));
      byCampaign.set(id, (byCampaign.get(id) || 0) + g.spend);
    }
    onPreview?.([...byCampaign.entries()].map(([campaign_id, amount]) => ({ campaign_id, amount })));
  };

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <Upload size={14} className="text-gray-400" />
        <span className="text-sm font-bold text-ink">Import an Ads Manager export</span>
        <button onClick={onCancel} className="ml-auto text-gray-300 hover:text-gray-600"><X size={14} /></button>
      </div>

      {!csv ? (
        <label className="block border border-dashed border-rule rounded-lg px-4 py-6 text-center cursor-pointer hover:bg-gray-50">
          <input type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => take(e.target.files?.[0])} />
          <span className="text-[13px] text-gray-500">Drop a CSV here, or click to choose one</span>
          <span className="block text-[11px] text-gray-400 mt-1">
            Its numbers are used as proportions only — the amounts written are this month's real charges.
          </span>
        </label>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-3">
            <span className="text-[12px] text-gray-400 truncate max-w-[200px]">{file?.name}</span>
            {[['Campaign column', nameCol, setNameCol], ['Spend column', spendCol, setSpendCol]].map(
              ([label, val, set]) => (
                <div key={label}>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">{label}</label>
                  <select value={val} onChange={(e) => set(e.target.value)}
                    className="px-2 py-1.5 text-[13px] border border-rule rounded-lg bg-card">
                    <option value="">—</option>
                    {csv.header.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            <button onClick={() => { setCsv(null); setFile(null) }}
              className="text-[12px] text-gray-400 hover:text-gray-600 ml-auto">Choose another file</button>
          </div>

          {!grouped.length ? (
            <p className="text-[12px] text-gray-400">
              Point at the campaign and spend columns to see what is in the file.
            </p>
          ) : (
            <>
              <div className="rounded-lg border border-rule overflow-hidden max-h-72 overflow-y-auto">
                {grouped.map((g) => {
                  const link = linkFor(g);
                  return (
                    <div key={g.name}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] border-b border-divider/60 last:border-0">
                      <span className="truncate flex-1 text-gray-700" title={g.name}>{g.name}</span>
                      <span className="tabular-nums text-gray-400 w-24 text-right">{usd(g.spend)}</span>
                      <span className="tabular-nums text-gray-300 w-12 text-right">
                        {total ? `${Math.round((g.spend / total) * 100)}%` : ''}
                      </span>
                      <select value={link}
                        onChange={(e) => setLinks((p) => ({ ...p, [g.name]: e.target.value }))}
                        className={`px-2 py-1 text-[12px] border rounded-md bg-card w-56 ${
                          link ? 'border-rule' : 'border-amber-400'}`}>
                        <option value="">Skip — no campaign</option>
                        {campaigns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.artist || 'no artist'}{c.song ? ` · ${c.song}` : ''} — {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              {/* Said out loud rather than silently dropped: a skipped campaign's
                  share is not allocated, and the reader needs to know the split is
                  over the mapped subset. */}
              <div className="flex items-center gap-2 mt-2.5">
                <button onClick={go} disabled={busy || !mapped.length}
                  className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-40">Preview</button>
                <span className="text-[11px] text-gray-400">
                  {mapped.length} of {grouped.length} campaigns mapped
                  {mapped.length !== grouped.length && total > 0 && (
                    <> — {usd(total - mappedTotal)} of the file is skipped, and this month's charges
                      will be split between the mapped ones only</>
                  )}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
