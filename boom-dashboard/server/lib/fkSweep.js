const pool = require('../db');

// Clear non-cascading foreign-key references to a row before deleting it.
//
// Hand-enumerated cleanup lists in the delete handlers went stale every
// time a new table gained a user_id/artist_id column, producing FK-violation
// 500s. This reads the live FK graph from information_schema instead: every
// constraint that points at `targetTable` and has no ON DELETE action gets
// cleared — SET NULL when the referencing column is nullable, row DELETE
// when it isn't. Constraints declared with CASCADE/SET NULL are left for
// Postgres to handle.
//
// `db` accepts a pool client so callers can run the sweep inside their own
// transaction. Table/column names come from information_schema (not user
// input) and are identifier-quoted anyway.
async function clearForeignKeyRefs(targetTable, targetId, { db = pool, skipTables = [] } = {}) {
  const skip = new Set(skipTables.map(t => t.toLowerCase()));
  const { rows } = await db.query(
    `SELECT DISTINCT tc.table_name, kcu.column_name, col.is_nullable
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.constraint_schema
       JOIN information_schema.columns col
         ON col.table_name = tc.table_name
        AND col.column_name = kcu.column_name
        AND col.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = $1
        AND rc.delete_rule IN ('NO ACTION', 'RESTRICT')`,
    [targetTable]
  );
  for (const r of rows) {
    if (skip.has(r.table_name.toLowerCase())) continue;
    const tbl = `"${r.table_name.replace(/"/g, '')}"`;
    const col = `"${r.column_name.replace(/"/g, '')}"`;
    if (r.is_nullable === 'YES') {
      await db.query(`UPDATE ${tbl} SET ${col} = NULL WHERE ${col} = $1`, [targetId]);
    } else {
      await db.query(`DELETE FROM ${tbl} WHERE ${col} = $1`, [targetId]);
    }
  }
}

module.exports = { clearForeignKeyRefs };
