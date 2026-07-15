const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'printing.db'));

db.pragma('journal_mode = WAL');
db.pragma('ignore_check_constraints = ON');

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
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'accepted', 'rejected', 'payment_failed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec(`ALTER TABLE orders ADD COLUMN print_side TEXT NOT NULL DEFAULT 'single' CHECK(print_side IN ('single', 'both'))`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'razorpay' CHECK(payment_method IN ('razorpay', 'cash'))`);
} catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN razorpay_order_id TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN is_id_copy INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN back_file_name TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN back_file_path TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN back_enabled INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN copies INTEGER NOT NULL DEFAULT 1`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN printer_name TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN mobile_number TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN order_notes TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN orientation TEXT NOT NULL DEFAULT 'portrait'`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN page_range TEXT DEFAULT 'all'`); } catch (e) {}
try {
  // Add payment_failed to status check constraint (SQLite doesn't support ALTER CHECK, so we recreate table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders_new (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 1,
      print_type TEXT NOT NULL CHECK(print_type IN ('bw', 'color')),
      print_side TEXT NOT NULL DEFAULT 'single' CHECK(print_side IN ('single', 'both')),
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'accepted', 'rejected', 'payment_failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      print_side TEXT NOT NULL DEFAULT 'single' CHECK(print_side IN ('single', 'both')),
      payment_method TEXT NOT NULL DEFAULT 'razorpay' CHECK(payment_method IN ('razorpay', 'cash')),
      razorpay_order_id TEXT,
      is_id_copy INTEGER NOT NULL DEFAULT 0,
      back_file_name TEXT,
      back_file_path TEXT,
      back_enabled INTEGER NOT NULL DEFAULT 0,
      copies INTEGER NOT NULL DEFAULT 1,
      printer_name TEXT,
      mobile_number TEXT,
      order_notes TEXT,
      orientation TEXT NOT NULL DEFAULT 'portrait',
      page_range TEXT DEFAULT 'all',
      total_pdf_pages INTEGER NOT NULL DEFAULT 0,
      total_sheets INTEGER NOT NULL DEFAULT 0,
      price_before_discount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      pricing_type TEXT DEFAULT 'standard'
    )
  `);
  db.exec(`INSERT INTO orders_new SELECT 
    id, customer_name, file_name, file_path, page_count, print_type, print_side, price, status, created_at,
    print_side, payment_method, razorpay_order_id, is_id_copy, back_file_name, back_file_path, back_enabled,
    copies, printer_name, mobile_number, order_notes, orientation, page_range,
    0, 0, 0, 0, 'standard'
    FROM orders`);
  db.exec(`DROP TABLE orders`);
  db.exec(`ALTER TABLE orders_new RENAME TO orders`);
} catch (e) {}
module.exports = db;
