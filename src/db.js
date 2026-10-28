import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function openDb(dbPath) {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE,
      title TEXT,
      content TEXT,
      embedding BLOB,
      pagerank REAL DEFAULT 0,
      depth INTEGER
    );

    CREATE TABLE IF NOT EXISTS edges (
      from_id TEXT,
      to_id   TEXT,
      anchor_text TEXT,
      weight  REAL DEFAULT 1.0,
      PRIMARY KEY (from_id, to_id, anchor_text)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
  `);

  return db;
}
