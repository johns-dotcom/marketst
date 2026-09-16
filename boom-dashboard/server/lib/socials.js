// Canonical normalizer for social_handles JSONB rows. Every write path
// (POST /bk/entries, PUT /bk/entries/:id, vendor submit) runs incoming
// rows through this ONE function so the persisted shape can't drift
// between entry points — the previous per-site copies each rebuilt rows
// as {platform, handle} and silently stripped the artist tag (and would
// have stripped amounts), which is how per-artist scoping never made it
// to the database.
//
// Row shape: { platform, handle, artist?, amount? }
//   • artist — scopes the handle to one artist of a split invoice
//     (client-side display filtering). Dropped when blank.
//   • amount — per-creator spend carved out of the invoice total.
//     Stored as a positive number rounded to cents; dropped otherwise.
function normalizeSocialRows(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const platform = String(r.platform || '').trim().slice(0, 32);
      const handle = String(r.handle || '').trim().slice(0, 128);
      const artist = String(r.artist || '').trim().slice(0, 128);
      const amountNum = Number(r.amount);
      const row = { platform, handle };
      if (artist) row.artist = artist;
      if (Number.isFinite(amountNum) && amountNum > 0) {
        row.amount = Math.round(amountNum * 100) / 100;
      }
      return row;
    })
    .filter(r => r.handle);
  return cleaned.length ? cleaned : null;
}

module.exports = { normalizeSocialRows };
