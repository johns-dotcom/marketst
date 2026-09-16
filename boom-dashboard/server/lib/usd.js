/**
 * Convert a foreign amount to USD, the app's functional currency.
 *
 * Precedence, and the order matters:
 *
 *   1. `lockedRate` — the `fx_rate_to_usd` stamped on the expense when it was
 *      marked Paid. This is the rate as of the payment day and it is the ONLY
 *      historically-correct figure. Once a payment settles, its USD value is a
 *      fact, not something to re-derive at today's rate.
 *   2. USD passes through untouched.
 *   3. The cached live rate, as a fallback for rows with no lock.
 *   4. Failing all that, the face value — never a silent zero, because a
 *      dropped amount is harder to notice than a slightly wrong one.
 *
 * Rates are quoted per-USD (EUR: 0.92 means €0.92 = $1), hence divide.
 *
 * Lived as a module-local in routes/reports.js until the 1099 report needed the
 * same conversion. A second copy would have drifted, and drift in currency
 * conversion means a tax figure that's wrong in a way nobody can see — the same
 * failure mode as the duplicated payee normalizer (see lib/normalize-bank-payee).
 */

const { getCached } = require('../services/fx');

function usdOf(amount, currency, lockedRate) {
  const n = parseFloat(amount || 0);
  const locked = parseFloat(lockedRate || 0);
  if (locked > 0) return n / locked;
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'USD') return n;
  const live = getCached().rates?.[cur];
  return live > 0 ? n / live : n;
}

module.exports = { usdOf };
