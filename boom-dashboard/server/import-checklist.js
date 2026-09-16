/**
 * One-time script: Import missing catalog releases from the checklist PDF.
 *
 * Usage:
 *   node import-checklist.js          (dry run — shows what would be inserted)
 *   node import-checklist.js --run     (actually inserts into the database)
 */

const pool = require('./db');
const missing = require('./data/missing_releases.json');

async function run() {
  const dryRun = !process.argv.includes('--run');
  if (dryRun) console.log('=== DRY RUN (pass --run to execute) ===\n');

  // 1. Load existing artists
  const { rows: existingArtists } = await pool.query('SELECT id, name FROM artists');
  const artistMap = {}; // lowercase name -> id
  for (const a of existingArtists) {
    artistMap[a.name.toLowerCase()] = a.id;
  }

  // 2. Load existing releases to avoid duplicates
  const { rows: existingReleases } = await pool.query(
    "SELECT LOWER(a.name) AS artist, LOWER(r.project_name) AS project FROM releases r JOIN artists a ON r.artist_id = a.id"
  );
  const existingSet = new Set(existingReleases.map(r => `${r.artist}|||${r.project}`));

  let inserted = 0;
  let skipped = 0;
  let artistsCreated = 0;

  for (const entry of missing) {
    const { artist, project, date } = entry;
    const key = `${artist.toLowerCase()}|||${project.toLowerCase()}`;

    if (existingSet.has(key)) {
      skipped++;
      continue;
    }

    // Find or create artist
    let artistId = artistMap[artist.toLowerCase()];
    if (!artistId) {
      if (dryRun) {
        console.log(`  [NEW ARTIST] ${artist}`);
        artistMap[artist.toLowerCase()] = -1;
        artistId = -1;
        artistsCreated++;
      } else {
        const res = await pool.query(
          'INSERT INTO artists (name, genre, total_releases, created_at) VALUES ($1, $2, 0, NOW()) RETURNING id',
          [artist, '']
        );
        artistId = res.rows[0].id;
        artistMap[artist.toLowerCase()] = artistId;
        artistsCreated++;
        console.log(`  [NEW ARTIST] ${artist} (id=${artistId})`);
      }
    }

    // Determine release type from project name
    let releaseType = 'Single';
    const pLower = project.toLowerCase();
    if (pLower.includes(' album') || pLower.includes('deluxe')) releaseType = 'Album';
    else if (pLower.includes(' ep') || pLower.endsWith(' ep')) releaseType = 'EP';
    else if (pLower.includes('remix')) releaseType = 'Remix';

    // Determine if past or upcoming
    const releaseDate = new Date(date);
    const now = new Date();
    const priority = releaseDate > now ? 'Medium' : 'Low';

    if (dryRun) {
      inserted++;
      existingSet.add(key);
    } else {
      await pool.query(
        `INSERT INTO releases (artist_id, project_name, release_date, release_type, priority, in_catalog, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())`,
        [artistId, project, date, releaseType, priority]
      );
      inserted++;
      existingSet.add(key);
    }
  }

  // Update artist total_releases counts
  if (!dryRun) {
    await pool.query(`
      UPDATE artists SET total_releases = (
        SELECT COUNT(*) FROM releases WHERE releases.artist_id = artists.id
      )
    `);
  }

  console.log(`\n--- Summary ---`);
  console.log(`New artists created: ${artistsCreated}`);
  console.log(`Releases inserted:   ${inserted}`);
  console.log(`Skipped (duplicates): ${skipped}`);
  console.log(`Total in checklist:   ${missing.length}`);
  if (dryRun) console.log('\nRe-run with --run to apply changes.');

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
