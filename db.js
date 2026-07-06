const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'printing.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 1,
    print_type TEXT NOT NULL CHECK(print_type IN ('bw', 'color')),
    print_side TEXT NOT NULL DEFAULT 'single' CHECK(print_side IN ('single', 'both')),
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'accepted', 'rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec(`ALTER TABLE orders ADD COLUMN print_side TEXT NOT NULL DEFAULT 'single' CHECK(print_side IN ('single', 'both'))`);
} catch (e) {
  // column already exists
}

module.exports = db;
