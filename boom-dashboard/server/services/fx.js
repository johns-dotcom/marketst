// FX rates service.
//
// Pulls daily mid-market rates from frankfurter.app — ECB-published, free,
// no API key. Caches in memory; refreshes once on import + every 12h.
// Falls back to a hardcoded table if the API can't be reached on first
// load so the rest of the app keeps working.
//
// Shape returned:
//   { rates: { USD: 1, EUR: 0.92, GBP: 0.79, ... }, fetchedAt: ISO8601 }
//
// All rates are expressed as 1 USD = X foreign. To convert a foreign
// amount to USD, divide: usd = foreignAmount / rates[currency].

const https = require('https');

// Every currency the statements pipeline can store. This list MUST cover
// the parser/repair ISO set in routes/statements.js — a currency missing
// here gets rate 0 and every conversion silently falls back to the face
// value (a ₱11,353 PayPal payment displayed as ≈$11,353). TWD is the one
// exception: the ECB publishes no TWD reference rate, so it stays out —
// endpoints that need a rate refuse rather than fake it.
const SUPPORTED = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'JPY', 'BRL', 'CHF',
  'SEK', 'NOK', 'DKK', 'NZD', 'HKD', 'SGD', 'CNY', 'PLN', 'CZK', 'HUF', 'ILS', 'THB', 'PHP'];

// Last-resort fallback. Only used if the very first fetch fails before
// any successful refresh; replaced on the first good refresh().
const FALLBACK = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.37,
  AUD: 1.51,
  MXN: 17.2,
  JPY: 156,
  BRL: 5.6,
  CHF: 0.91,
  SEK: 10.7,
  NOK: 10.8,
  DKK: 6.86,
  NZD: 1.68,
  HKD: 7.8,
  SGD: 1.35,
  CNY: 7.25,
  PLN: 4.0,
  CZK: 23.4,
  HUF: 362,
  ILS: 3.7,
  THB: 36.4,
  PHP: 58.3,
};

let cached = { rates: { ...FALLBACK }, fetchedAt: null, source: 'fallback' };

function fetchRates() {
  return new Promise((resolve, reject) => {
    const to = SUPPORTED.filter(c => c !== 'USD').join(',');
    const req = https.get(
      // frankfurter moved: api.frankfurter.app now 301s to api.frankfurter.dev/v1
      // and plain https.get doesn't follow redirects — production sat on the
      // stale FALLBACK table (EUR 0.92 vs real ~0.87) until a wrong €→$
      // conversion surfaced in a campaigns export.
      `https://api.frankfurter.dev/v1/latest?from=USD&to=${to}`,
      { headers: { 'User-Agent': 'marketst-dashboard/1.0' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.rates) return reject(new Error('No rates in response'));
            const rates = { USD: 1, ...json.rates };
            resolve({ rates, fetchedAt: new Date().toISOString(), source: 'frankfurter.dev' });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('FX fetch timed out')));
  });
}

async function refresh() {
  try {
    const next = await fetchRates();
    cached = next;
    console.log(`[fx] Refreshed rates at ${next.fetchedAt}`);
  } catch (err) {
    console.warn(`[fx] Refresh failed: ${err.message}; keeping cached rates (source=${cached.source})`);
  }
}

function getCached() {
  return cached;
}

// Historical rates by date — used to stamp fx_rate_to_usd on an expense
// when it's marked paid (we want the rate as-of the payment day, not as-of
// today). Cached forever once fetched: a historical date's rate is
// immutable. Frankfurter has data back to 1999 — anything older fails.
//
// Returns { rates: { USD:1, EUR:0.92, ... }, fetchedAt: ISO } or null on
// any fetch error so callers can decide whether to skip or fall back.
const historicalCache = new Map();
function isPlainDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function fetchHistorical(date) {
  return new Promise((resolve, reject) => {
    const to = SUPPORTED.filter(c => c !== 'USD').join(',');
    const req = https.get(
      `https://api.frankfurter.dev/v1/${date}?from=USD&to=${to}`,
      { headers: { 'User-Agent': 'marketst-dashboard/1.0' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.rates) return reject(new Error('No rates in response'));
            // Frankfurter returns the previous working-day rate for
            // weekends/holidays — that's fine, it's still the canonical
            // "as-of" rate by ECB convention.
            resolve({
              rates: { USD: 1, ...json.rates },
              fetchedAt: new Date().toISOString(),
              date: json.date || date,
            });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('FX historical fetch timed out')));
  });
}

async function getHistorical(date) {
  if (!isPlainDate(date)) return null;
  if (historicalCache.has(date)) return historicalCache.get(date);
  try {
    const result = await fetchHistorical(date);
    historicalCache.set(date, result);
    return result;
  } catch (err) {
    console.warn(`[fx] Historical fetch for ${date} failed: ${err.message}`);
    return null;
  }
}

// Refresh on import + every 12h.
refresh();
setInterval(refresh, 12 * 60 * 60 * 1000).unref();

module.exports = { getCached, refresh, getHistorical, SUPPORTED };
