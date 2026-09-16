/**
 * One-shot cleanup for combo-string "artists" introduced by the master-sheet
 * import. The import created an artist row per literal ARTIST cell, so
 * collabs landed as single rows like:
 *   "Klypso, Snoop Dogg, Doggface, War"
 *   "Sam Short x Deux Twins"
 *   "Adria Khan x Giraffage"
 *
 * This script walks those, picks the first name as the lead artist (creating
 * it only if it doesn't already exist), repoints each affected release to
 * the lead, writes the rest of the names into releases.featured_artists, and
 * deletes the combo artist row if it has no releases left.
 *
 * Splitter rules (deliberately conservative):
 *   - Split on  ", "     and       " x "    and    " feat. " / " ft. "
 *   - Do NOT split on " & " — too many legit duo names use it
 *     (e.g. "Merk & Kremont", "Earth, Wind & Fire").
 *   - If a release already has featured_artists set, preserve it; we only
 *     write when the field is empty so manual cleanup wins.
 *
 * Usage:
 *   DATABASE_URL=... node server/scripts/split-collab-artists.js [--apply]
 *
 * Defaults to a dry run that prints every proposed split. Re-run with
 * --apply to commit the changes inside one transaction.
 */

require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

// Splits on ", " or " x " or " feat. " / " ft. " (case-insensitive).
// Intentionally NOT on " & ".
const SPLIT_RE = /\s*,\s*|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+/i;

function splitCollabName(name) {
  if (!name) return null;
  const parts = name.split(SPLIT_RE).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { lead: parts[0], featured: parts.slice(1) };
}

const norm = s => (s || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');

(async function main() {
  console.log(`\nMode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}\n`);

  const { rows: artists } = await pool.query('SELECT id, name FROM artists ORDER BY id');
  const byName = new Map(artists.map(a => [norm(a.name), a]));

  const candidates = [];
  for (const a of artists) {
    const split = splitCollabName(a.name);
    if (split) candidates.push({ artist: a, ...split });
  }
  console.log(`Combo-string artists found: ${candidates.length}\n`);

  if (!candidates.length) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  // For each candidate, look up its releases up front so we can show the
  // dry-run plan and (later) write featured_artists per release.
  const plans = [];
  for (const c of candidates) {
    const { rows: rels } = await pool.query(
      'SELECT id, project_name, featured_artists FROM releases WHERE artist_id = $1',
      [c.artist.id]
    );
    const lead = byName.get(norm(c.lead));
    plans.push({ ...c, releases: rels, leadExists: !!lead, leadId: lead ? lead.id : null });
  }

  // Print the plan (dry-run output, also shown before --apply for the record)
  for (const p of plans) {
    console.log(`[#${p.artist.id}] "${p.artist.name}"`);
    console.log(`   lead:     "${p.lead}"${p.leadExists ? ` (existing #${p.leadId})` : ' (will create)'}`);
    console.log(`   featured: ${p.featured.join(', ')}`);
    if (p.releases.length === 0) {
      console.log(`   releases: none — combo artist will be deleted`);
    } else {
      console.log(`   releases (${p.releases.length}):`);
      for (const r of p.releases) {
        const note = r.featured_artists ? ' [keeps existing featured_artists]' : '';
        console.log(`     - "${r.project_name}"${note}`);
      }
    }
    console.log('');
  }

  const summary = plans.reduce((s, p) => {
    s.leadsToCreate += p.leadExists ? 0 : 1;
    s.releasesToRepoint += p.releases.length;
    s.combosToDelete += 1; // every combo row gets deleted at the end
    return s;
  }, { leadsToCreate: 0, releasesToRepoint: 0, combosToDelete: 0 });
  console.log('--- Summary ---');
  console.log(`  Lead artists to create:  ${summary.leadsToCreate}`);
  console.log(`  Releases to repoint:     ${summary.releasesToRepoint}`);
  console.log(`  Combo artist rows to remove: ${summary.combosToDelete}`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to commit.');
    await pool.end();
    return;
  }

  console.log('\nApplying…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refresh the in-memory artist map inside the txn so newly-created leads
    // are visible to subsequent plans.
    const localByName = new Map(byName);

    for (const p of plans) {
      let leadId = p.leadId;
      if (!leadId) {
        const existing = localByName.get(norm(p.lead));
        if (existing) {
          leadId = existing.id;
        } else {
          const ins = await client.query(
            'INSERT INTO artists (name) VALUES ($1) RETURNING id, name',
            [p.lead]
          );
          leadId = ins.rows[0].id;
          localByName.set(norm(ins.rows[0].name), ins.rows[0]);
        }
      }

      const featuredCsv = p.featured.join(', ');
      for (const r of p.releases) {
        if (r.featured_artists) {
          // Preserve any manually-set featured_artists; only re-point.
          await client.query(
            'UPDATE releases SET artist_id = $1 WHERE id = $2',
            [leadId, r.id]
          );
        } else {
          await client.query(
            'UPDATE releases SET artist_id = $1, featured_artists = $2 WHERE id = $3',
            [leadId, featuredCsv, r.id]
          );
        }
      }

      // Delete the combo row only if it no longer has children. (Releases
      // table has artist_id NOT NULL with no ON DELETE — defensive check.)
      const { rowCount: stillReferenced } = await client.query(
        'SELECT 1 FROM releases WHERE artist_id = $1 LIMIT 1',
        [p.artist.id]
      );
      if (!stillReferenced) {
        await client.query('DELETE FROM artists WHERE id = $1', [p.artist.id]);
      } else {
        console.warn(`  ! Combo artist #${p.artist.id} still has releases pointing at it — not deleting.`);
      }
    }

    await client.query('COMMIT');
    console.log(`\nDone. Repointed ${summary.releasesToRepoint} releases, removed ${summary.combosToDelete} combo artist rows.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
