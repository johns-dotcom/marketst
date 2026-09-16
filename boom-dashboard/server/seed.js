const pool = require('./db');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const REQUIRED_ENV = ['PW_JOHN'];

const seed = async () => {
  // Guard: refuse to run if any password env vars are missing
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Seed aborted — missing required env vars: ${missing.join(', ')}. Set them in Railway before reseeding.`);
  }

  try {
    console.log('Starting database seeding...');

    // Create tables
    console.log('Creating tables...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'User',
        department VARCHAR(100),
        hierarchy_level INT DEFAULT 99,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS artists (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        genre VARCHAR(100),
        total_releases INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS releases (
        id SERIAL PRIMARY KEY,
        artist_id INT NOT NULL REFERENCES artists(id),
        project_name VARCHAR(255) NOT NULL,
        release_date DATE,
        release_type VARCHAR(50),
        genre VARCHAR(100),
        subgenre VARCHAR(100),
        priority VARCHAR(50),
        upc VARCHAR(30),
        isrc VARCHAR(30),
        apple_id VARCHAR(30),
        spotify_uri VARCHAR(255),
        presave_link VARCHAR(500),
        presave_analytics VARCHAR(500),
        ugc_link VARCHAR(500),
        apple_music_link VARCHAR(500),
        producer VARCHAR(255),
        featured_artists VARCHAR(500),
        distributor_notes TEXT,
        cover_art_status VARCHAR(50) DEFAULT 'Pending',
        notes TEXT,
        yt_video BOOLEAN DEFAULT false,
        recoup_added BOOLEAN DEFAULT false,
        uploaded BOOLEAN DEFAULT false,
        stem_pitch BOOLEAN DEFAULT false,
        s4a_pitch BOOLEAN DEFAULT false,
        amazon_pitch BOOLEAN DEFAULT false,
        pandora BOOLEAN DEFAULT false,
        budget BOOLEAN DEFAULT false,
        marketing_plan BOOLEAN DEFAULT false,
        official_thread BOOLEAN DEFAULT false,
        marquee BOOLEAN DEFAULT false,
        content BOOLEAN DEFAULT false,
        dsp_email BOOLEAN DEFAULT false,
        musixmatch BOOLEAN DEFAULT false,
        in_catalog BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        assigned_by INT REFERENCES users(id),
        task_type VARCHAR(20) DEFAULT 'assignment',
        description TEXT NOT NULL,
        category VARCHAR(50),
        priority VARCHAR(20) DEFAULT 'Medium',
        status VARCHAR(50) DEFAULT 'To Do',
        due_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id SERIAL PRIMARY KEY,
        artist_id INT NOT NULL REFERENCES artists(id),
        type VARCHAR(100) NOT NULL,
        date_signed DATE,
        expiration_date DATE,
        status VARCHAR(50) DEFAULT 'Active',
        royalty_split VARCHAR(100),
        advance VARCHAR(100),
        territory VARCHAR(100),
        num_releases VARCHAR(100),
        notes TEXT,
        file_path VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        artist_name VARCHAR(255) NOT NULL,
        genre VARCHAR(100),
        stage VARCHAR(100),
        ar_rep VARCHAR(255),
        source VARCHAR(100),
        notes TEXT,
        added_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        request TEXT NOT NULL,
        upc_isrc VARCHAR(50),
        type VARCHAR(100),
        request_date DATE,
        status VARCHAR(50) DEFAULT 'Pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        action VARCHAR(255) NOT NULL,
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_login_logs (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(100),
        user_agent TEXT
      );
    `);

    console.log('Tables created successfully');

    // Seed the initial account. Add the rest of the team from the Team page.
    console.log('Seeding users...');
    const allUsers = [
      { name: 'John', email: 'john@deanst.co', password: process.env.PW_JOHN, role: 'Superadmin', department: 'Operations', hierarchy_level: 1 },
    ];

    for (const u of allUsers) {
      const hash = await bcrypt.hash(u.password, 10);
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role, department, hierarchy_level, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [u.name, u.email, hash, u.role, u.department, u.hierarchy_level]
      );
    }

    // Load merged data
    console.log('Loading release data from data.json...');
    const data = require('./data.json');

    // Seed all artists
    console.log(`Seeding ${data.artists.length} artists...`);
    const artistIds = {};
    for (const artistName of data.artists) {
      const result = await pool.query(
        `INSERT INTO artists (name, created_at)
         VALUES ($1, NOW())
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
        [artistName]
      );
      if (result.rows.length > 0) {
        artistIds[artistName] = result.rows[0].id;
      } else {
        const existing = await pool.query('SELECT id FROM artists WHERE name = $1', [artistName]);
        if (existing.rows.length > 0) {
          artistIds[artistName] = existing.rows[0].id;
        }
      }
    }

    // Seed all releases
    console.log(`Seeding ${data.releases.length} releases...`);
    let seeded = 0;
    let skipped = 0;
    for (const r of data.releases) {
      const artistId = artistIds[r.artist];
      if (!artistId) { skipped++; continue; }

      try {
        await pool.query(
          `INSERT INTO releases (
            artist_id, project_name, release_date, release_type, genre, priority,
            upc, isrc, apple_id, spotify_uri, presave_link, presave_analytics, notes,
            yt_video, recoup_added, uploaded, stem_pitch, s4a_pitch, amazon_pitch,
            pandora, budget, marketing_plan, official_thread, marquee, content,
            dsp_email, musixmatch, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NOW(), NOW()
          )`,
          [
            artistId, r.project, r.date || null, r.format || null, r.genre || null, r.priority || null,
            r.upc || null, r.isrc || null, r.apple_id || null, r.spotify_uri || null,
            r.presave || null, r.presave_analytics || null, r.notes || null,
            r.yt_video || false, r.recoup_added || false, r.uploaded || false,
            r.stem_pitch || false, r.s4a_pitch || false, r.am4a_pitch || false,
            r.pandora || false, r.budget || false, r.marketing_plan || false,
            r.official_thread || false, r.marquee || false, r.content || false,
            r.dsp_email || false, r.musixmatch || false
          ]
        );
        seeded++;
        if (seeded % 300 === 0) console.log(`  ...${seeded} releases seeded`);
      } catch (err) {
        skipped++;
        console.error(`  Skipped "${r.artist} - ${r.project}": ${err.message}`);
      }
    }
    console.log(`  ...${seeded} total releases seeded, ${skipped} skipped`);

    // Update artist total_releases and genre
    console.log('Updating artist release counts and genres...');
    await pool.query(`
      UPDATE artists SET total_releases = sub.cnt
      FROM (SELECT artist_id, COUNT(*) as cnt FROM releases GROUP BY artist_id) sub
      WHERE artists.id = sub.artist_id
    `);
    await pool.query(`
      UPDATE artists SET genre = sub.genre
      FROM (
        SELECT DISTINCT ON (artist_id) artist_id, genre
        FROM releases WHERE genre IS NOT NULL
        ORDER BY artist_id, release_date DESC
      ) sub
      WHERE artists.id = sub.artist_id AND artists.genre IS NULL
    `);

    // Seed requests
    if (data.requests && data.requests.length > 0) {
      console.log(`Seeding ${data.requests.length} requests...`);
      for (const req of data.requests) {
        await pool.query(
          `INSERT INTO requests (request, upc_isrc, type, request_date, status, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          [req.request, req.upc_isrc, req.type, req.date, req.status || 'Pending', req.notes]
        );
      }
    }

    console.log('Database seeding completed successfully!');
    console.log(`  ${data.artists.length} artists`);
    console.log(`  ${seeded} releases`);
    console.log(`  ${(data.requests || []).length} requests`);
    console.log(`  1 team member`);
    console.log('Admin login: john@deanst.co / the PW_JOHN value in server/.env');
  } catch (error) {
    console.error('Seeding error:', error);
  }
};

if (require.main === module) {
  seed().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  module.exports = seed;
}
