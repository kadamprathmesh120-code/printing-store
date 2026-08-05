const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const { exec, spawn, execFile } = require('child_process');
const { promisify } = require('util');
const pdfParse = require('pdf-parse');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const https = require('https');
const db = require('./db');
const tracker = require('./printer-tracker');

const SUMATRA = path.join(__dirname, 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe');

let cachedPrinters = null;
let lastPrinterCheck = 0;

function getPrintersHidden() {
  const now = Date.now();
  if (cachedPrinters && (now - lastPrinterCheck < 300000)) {
    return Promise.resolve(cachedPrinters);
  }
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', 'Get-CimInstance Win32_Printer -Property DeviceID,Name,PrinterPaperNames | ForEach-Object { $_.Name }'
    ];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve(cachedPrinters || []);
      const names = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      cachedPrinters = names.map(n => ({ name: n }));
      lastPrinterCheck = Date.now();
      resolve(cachedPrinters);
    });
  });
}

function runPsScript(psFile, params) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', psFile];
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        args.push('-' + k, String(v));
      });
    }
    execFile('powershell.exe', args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

function sanitizePageRange(rangeStr) {
  if (!rangeStr || rangeStr === 'all') return 'all';
  let cleaned = String(rangeStr).replace(/[^0-9,-]/g, '').trim();
  cleaned = cleaned.replace(/^[,|-]+|[,|-]+$/g, '');
  return cleaned || 'all';
}

function printPdfSilent(filePath, opts) {
  return new Promise((resolve, reject) => {
    const sumatraArgs = [
      '-print-to', opts.printer,
      '-silent',
      '-exit-on-print'
    ];
    const settings = ['fit']; // Always fit page content to paper printable area (prevents blank/clipped pages)
    const copyCount = Math.max(1, parseInt(opts.copies) || 1);
    settings.push(copyCount + 'x');
    
    if (opts.side === 'duplex') {
      settings.push('duplexlong');
    } else {
      settings.push('simplex');
    }

    if (opts.monochrome) settings.push('monochrome');
    if (opts.orientation === 'landscape') {
      settings.push('landscape');
    } else if (opts.orientation === 'portrait') {
      settings.push('portrait');
    }
    
    const cleanRange = sanitizePageRange(opts.pages);
    if (cleanRange && cleanRange !== 'all') settings.push(cleanRange);

    const pps = parseInt(opts.pagesPerSheet) || 1;
    if (pps === 2) {
      settings.push('2-up');
    } else if (pps === 4) {
      settings.push('4-up');
    }

    if (settings.length) sumatraArgs.push('-print-settings', settings.join(','));
    sumatraArgs.push(filePath);

    console.log('[PRINT] SumatraPDF args:', sumatraArgs.join(' '));
    const child = spawn(SUMATRA, sumatraArgs, { windowsHide: true, detached: false });
    child.on('close', (code) => { resolve(code); });
    child.on('error', reject);
  });
}

function execP(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

function matchPrinter(pName, targetName) {
  if (!pName || !targetName) return false;
  if (pName === targetName) return true;
  const pLower = pName.toLowerCase();
  const tLower = targetName.toLowerCase();
  if (pLower.includes(tLower) || tLower.includes(pLower)) return true;
  if ((tLower.includes('205i') || tLower.includes('konica')) && (pLower.includes('205i') || pLower.includes('konica'))) return true;
  if (tLower.includes('kyocera') && pLower.includes('kyocera')) return true;
  if ((tLower.includes('hp95224c') || tLower.includes('smart tank')) && (pLower.includes('hp95224c') || pLower.includes('smart tank'))) return true;
  return false;
}

async function resolvePrinterName(targetName, isColor) {
  const BW_PRINTER_DEFAULT = 'Kyocera ECOSYS MA4000x KX';
  const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
  let bwPrinter = BW_PRINTER_DEFAULT;
  const PRINTER_CONFIG = path.join(__dirname, 'printer-config.json');
  if (fs.existsSync(PRINTER_CONFIG)) {
    try { bwPrinter = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8')).bwPrinter || bwPrinter; } catch(e) {}
  }

  if (isColor) return COLOR_PRINTER;
  if (!targetName) return bwPrinter;

  const tName = String(targetName).toLowerCase();
  if (tName.includes('205i') || tName.includes('konica')) return 'KONICA MINOLTA 205i(36:33:9E)';
  if (tName.includes('kyocera')) return 'Kyocera ECOSYS MA4000x KX';
  if (tName.includes('hp') || tName.includes('smart tank')) return COLOR_PRINTER;

  try {
    const printers = await getPrintersHidden();
    for (const p of printers) {
      if (p && p.name) {
        const pName = p.name.toLowerCase();
        if (p.name === targetName || pName.includes(tName) || tName.includes(pName)) return p.name;
      }
    }
  } catch (e) {}

  return bwPrinter;
}

// Load environment variables from .env file
require('dotenv').config();

// Admin password from admin-password.js (local) or process.env (Render)
let ADMIN_PASSWORD_FILE = '17062003';
try { ADMIN_PASSWORD_FILE = require('./admin-password'); } catch (e) {}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD_FILE || '17062003';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Razorpay configuration — uses environment variables ONLY, never hardcoded
//
// Locally (development):
//   Create a .env file (see .env.example) with RAZORPAY_KEY_ID and
//   RAZORPAY_KEY_SECRET. dotenv loads them automatically.
//
// On Render (production):
//   Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Render Dashboard →
//   Environment Variables. No .env file needed — process.env picks them up.
//
// Switching between Test and Live mode:
//   Test keys  start with rzp_test_...
//   Live keys  start with rzp_live_...
//   Change the values in .env (local) or Render Dashboard (production).
//   No code changes are required — only the environment variable values.
// ---------------------------------------------------------------------------
const isProd = process.env.NODE_ENV === 'production';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Report exactly which variable(s) are missing when keys are absent
const missing = [];
if (!RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
if (!RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');

if (missing.length > 0) {
  const msg = 'Missing environment variable(s): ' + missing.join(', ') +
    (isProd ? ' — set them in Render Dashboard → Environment Variables' : ' — add them to your .env file');
  if (isProd) {
    console.error('FATAL: ' + msg);
    process.exit(1);
  } else {
    console.warn('WARNING: ' + msg);
  }
}

// Log whether Razorpay credentials are loaded (mask the full key for security)
if (RAZORPAY_KEY_ID) {
  const masked = RAZORPAY_KEY_ID.substring(0, 8) + '...' + RAZORPAY_KEY_ID.slice(-4);
  console.log('Razorpay Key ID loaded:', masked);
} else {
  console.warn('Razorpay Key ID is NOT set — payment will be unavailable');
}

// Initialize Razorpay only if both credentials are present
let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });
  console.log('Razorpay instance created successfully');
} else {
  console.warn('Razorpay not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
}

// ---------------------------------------------------------------------------
// Cashfree configuration — uses environment variables
// ---------------------------------------------------------------------------
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'TEST').toUpperCase(); // 'TEST' (Sandbox) or 'PROD' (Production)

if (CASHFREE_APP_ID && CASHFREE_SECRET_KEY) {
  const maskedAppId = CASHFREE_APP_ID.substring(0, 4) + '...' + CASHFREE_APP_ID.slice(-4);
  console.log('Cashfree App ID loaded:', maskedAppId, '| Env:', CASHFREE_ENV);
} else {
  console.warn('Cashfree NOT configured — set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env if using Cashfree PG');
}

const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
}

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

// ---------------------------------------------------------------------------
// Block direct access to admin.html — redirect to login page instead.
// The login page (admin-login.html) is always accessible.
// ---------------------------------------------------------------------------
app.get('/admin.html', (req, res) => {
  res.redirect('/admin-login.html');
});
app.get('/admin', (req, res) => {
  res.redirect('/admin-login.html');
});

// Serve admin.html only through the authenticated endpoint below
app.get('/admin-dashboard', (req, res) => {
  // The client-side JS checks sessionStorage for the token;
  // this just serves the file. The API routes are token-protected.
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const activeAdminTokens = new Set();

// ---------------------------------------------------------------------------
// Admin Login API — verify password and issue a session token
// ---------------------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (String(password) !== String(ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong Password' });
  }
  // Generate a random token for this session
  const token = crypto.randomBytes(32).toString('hex');
  activeAdminTokens.add(token);
  console.log('Admin logged in. Active sessions:', activeAdminTokens.size);
  res.json({ success: true, token });
});

// ---------------------------------------------------------------------------
// Admin Token Verification — check if a token is still valid
// ---------------------------------------------------------------------------
app.post('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.body && req.body.token);
  if (token && activeAdminTokens.has(token)) {
    return res.json({ valid: true });
  }
  res.status(401).json({ valid: false, error: 'Not authenticated' });
});

// ---------------------------------------------------------------------------
// Admin Logout — remove the token so it can no longer be used
// ---------------------------------------------------------------------------
app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.body && req.body.token);
  if (token) {
    activeAdminTokens.delete(token);
    console.log('Admin logged out. Active sessions:', activeAdminTokens.size);
  }
  res.json({ success: true });
});

app.post('/api/log', (req, res) => {
  const { type, message } = req.body;
  console.log(`[CLIENT-LOG] [${type}] ${message}`);
  res.sendStatus(200);
});

async function getPageCount(filePath, ext) {
  if (ext === '.pdf') {
    try {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return data.numpages || 1;
    } catch (e) {
      return 1;
    }
  }
  if (['.jpg', '.jpeg', '.png'].includes(ext)) return 1;
  return null;
}

// Count how many pages are selected in a page-range string like "1", "1-3", "1,3,5"
function countPagesInRange(rangeStr, maxPages) {
  if (!rangeStr || rangeStr === 'all') return maxPages;
  var trimmed = rangeStr.replace(/\s/g, '');
  if (!trimmed) return maxPages;
  var parts = trimmed.split(',');
  var count = 0;
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi];
    if (part.indexOf('-') !== -1) {
      var rangeParts = part.split('-');
      var start = parseInt(rangeParts[0], 10);
      var end = parseInt(rangeParts[1], 10);
      if (!isNaN(start) && !isNaN(end)) {
        var from = Math.max(1, start);
        var to = Math.min(maxPages, end);
        if (to >= from) count += to - from + 1;
      }
    } else {
      var page = parseInt(part, 10);
      if (!isNaN(page) && page >= 1 && page <= maxPages) count++;
    }
  }
  return Math.max(1, count);
}

const uploadMw = upload.array('files', 20);
app.post('/api/upload', (req, res) => {
  uploadMw(req, res, async function(err) {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    try {
      const files = req.files;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const { customerName, printType, printSide, paymentMethod, mobileNumber, orderNotes, orientation, copies, pageRange } = req.body;
      const pagesPerSheet = Math.max(1, parseInt(req.body.pagesPerSheet) || 1);

      if (!customerName || !printType || !printSide || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (printType === 'color' && printSide === 'both') {
        return res.status(400).json({ error: 'Color printing does not support Both Sides' });
      }

      const copyCount = parseInt(copies) || 1;
      const batchId = 'batch_' + uuidv4();
      // Cash orders go directly to 'paid' so admin sees Accept button immediately
      const initialStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
      const stmt = db.prepare(`
        INSERT INTO orders (id, customer_name, file_name, file_path, page_count, print_type, print_side, price, payment_method, status, mobile_number, order_notes, orientation, copies, page_range, effective_pages, total_sheets, price_before_discount, discount_amount, pricing_type, pages_per_sheet, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const orders = [];
      let totalPrice = 0;
      let totalSheets = 0;
      let totalPdfPages = 0;

      // Helper function for tiered pricing
      function calculateTieredPrice(sheets, type) {
        const isColor = (type === 'color');
        const baseRate = isColor ? 10 : 5;
        const bulkRate = isColor ? 8 : 3;
        if (sheets <= 20) {
          return sheets * baseRate;
        } else {
          return 20 * baseRate + (sheets - 20) * bulkRate;
        }
      }

      // First pass: calculate sheets per file
      const fileSheets = [];
      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        let pages = await getPageCount(file.path, ext);

        const manualPages = req.body['pageCount_' + file.originalname];
        if (manualPages) pages = parseInt(manualPages, 10);

        if (!pages || pages < 1) pages = 1;

        // Use page range to determine effective page count for pricing
        var effectivePages = pages;
        if (pageRange && pageRange !== 'all') {
          effectivePages = countPagesInRange(pageRange, pages);
        }
        var ppsPages = Math.ceil(effectivePages / pagesPerSheet);
        const sheets = printSide === 'both' ? Math.ceil(ppsPages / 2) : ppsPages;
        
        fileSheets.push({ file, pages, effectivePages, sheets });
        totalSheets += sheets;
        totalPdfPages += effectivePages;
      }

      // Calculate total price with tiered pricing on TOTAL sheets × copies
      const totalSheetsWithCopies = totalSheets * copyCount;
      const totalTieredPrice = calculateTieredPrice(totalSheetsWithCopies, printType);
      
      // Calculate price before discount
      const baseRate = printType === 'color' ? 10 : 5;
      const totalPriceBeforeDiscount = totalSheetsWithCopies * baseRate;
      const totalDiscountAmount = Math.max(0, totalPriceBeforeDiscount - totalTieredPrice);

      // Distribute price proportionally to each file based on their sheet count
      let totalDistributedPrice = 0;
      for (let i = 0; i < fileSheets.length; i++) {
        const { file, pages, effectivePages, sheets } = fileSheets[i];
        const id = uuidv4();
        
        // Proportional price allocation
        let price;
        if (i === fileSheets.length - 1) {
          // Last file gets remainder to avoid rounding errors
          price = totalTieredPrice - totalDistributedPrice;
        } else {
          price = Math.round(totalTieredPrice * (sheets / totalSheets));
        }
        totalDistributedPrice += price;

        // Proportional discount allocation
        const filePriceBeforeDiscount = sheets * copyCount * 5;
        const fileDiscountAmount = Math.round(totalDiscountAmount * (filePriceBeforeDiscount / totalPriceBeforeDiscount));

        stmt.run(id, customerName, file.originalname, file.filename, pages, printType, printSide, price, paymentMethod, initialStatus, mobileNumber || null, orderNotes || null, orientation || 'portrait', copyCount, pageRange || 'all', effectivePages, sheets, filePriceBeforeDiscount, fileDiscountAmount, totalSheetsWithCopies > 20 ? 'bulk' : 'standard', pagesPerSheet, batchId);

        orders.push({
          orderId: id,
          price,
          pageCount: pages,
          sheets,
          fileName: file.originalname,
          copies: copyCount,
          effectivePages,
          priceBeforeDiscount: filePriceBeforeDiscount,
          discountAmount: fileDiscountAmount,
          pricingType: totalSheetsWithCopies > 20 ? 'bulk' : 'standard'
        });
        totalPrice += price;
      }

      res.json({
        orders,
        totalPrice,
        totalSheets,
        totalPdfPages,
        customerName,
        mobileNumber,
        orderNotes,
        orientation,
        copies: copyCount,
        pageRange,
        printType: printType === 'bw' ? 'Black & White' : 'Color',
        printSide: printSide === 'both' ? 'Both Sides' : 'Single Side',
        paymentMethod
      });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
});

app.get('/api/orders/:id', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.all('/api/orders/:id/mark-printed', (req, res) => {
  try {
    const id = req.params.id;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (order) {
      tracker.markOrderPrinted(id);
      // Files are retained for admin preview and cleaned up based on PREVIEW_RETENTION_HOURS
    }
    res.json({ success: true, message: 'Marked printed successfully. Document retained for admin preview.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.post('/api/orders/:id/confirm-payment', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already ${order.status}` });
    }

    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('paid', req.params.id);

    res.json({ success: true, message: 'Payment confirmed. Waiting for admin approval.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Cash payment for ID copy (and regular orders) — marks order as paid (awaiting admin approval to print)
app.post('/api/orders/:id/pay-cash', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Set status to 'paid' (Cash Confirmed - Awaiting Admin Approval to Print)
    db.prepare('UPDATE orders SET status = ?, payment_method = ? WHERE id = ?').run('paid', 'cash', req.params.id);
    console.log(`Cash payment recorded for order ${req.params.id}. Awaiting admin approval.`);
    res.json({ success: true, message: 'Cash payment recorded. Waiting for admin approval.' });
  } catch (err) {
    console.error('pay-cash error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});


// Razorpay: create an order for the total amount
app.post('/api/create-razorpay-order', (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Razorpay is not configured on this server' });
    }

    const { amount, orderIds } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const options = {
      amount: Math.round(amount * 100), // convert to paise
      currency: 'INR',
      receipt: 'order_' + Date.now(),
      payment_capture: 1
    };

    razorpay.orders.create(options, (err, order) => {
      if (err) {
        console.error('Razorpay create order error:', err);
        return res.status(500).json({ error: 'Failed to create Razorpay order' });
      }
      // Store razorpay_order_id on each order row for verification
      if (Array.isArray(orderIds)) {
        const stmt = db.prepare('UPDATE orders SET razorpay_order_id = ? WHERE id = ?');
        for (const oid of orderIds) {
          stmt.run(order.id, oid);
        }
      }
      // Log key status (without exposing the full key) for debugging
      console.log('Returning order ID:', order.id, '| key_id present:', !!RAZORPAY_KEY_ID);
      // Include key_id in response so frontend never needs hardcoded keys
      if (!RAZORPAY_KEY_ID) {
        return res.status(500).json({ error: 'Razorpay Key ID is not configured on the server' });
      }
      res.json({ razorpayOrderId: order.id, amount: options.amount, currency: options.currency, key_id: RAZORPAY_KEY_ID });
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Razorpay: verify payment signature and mark orders paid
app.post('/api/verify-razorpay-payment', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Razorpay is not configured on this server' });
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderIds } = req.body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify payment signature using HMAC SHA256 with the key secret
    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');

    if (expectedSig !== razorpaySignature) {
      // Signature does not match — mark orders as payment_failed
      if (Array.isArray(orderIds)) {
        for (const oid of orderIds) {
          db.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').run('payment_failed', oid, 'pending');
        }
      }
      return res.status(400).json({ error: 'Payment verification failed (signature mismatch)' });
    }

    // Signature verified — mark all associated orders as paid
    const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';

    // Check auto-print setting
    const autoPrintRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('razorpay_autoprint_enabled');
    const autoPrintEnabled = autoPrintRow ? autoPrintRow.value === '1' : true; // default ON

    if (Array.isArray(orderIds)) {
      for (const oid of orderIds) {
        db.prepare('UPDATE orders SET status = ?, razorpay_order_id = ? WHERE id = ? AND status = ?').run('paid', razorpayOrderId, oid, 'pending');

        // Auto-accept and print only if enabled
        if (autoPrintEnabled) {
          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
          if (order) {
            tracker.unmarkOrderPrinted(oid);
            db.prepare('UPDATE orders SET status = ?, is_printed = 0 WHERE id = ?').run('accepted', oid);
            const printer = await resolvePrinterName(order.printer_name, order.print_type === 'color');
            db.prepare('UPDATE orders SET printer_name = ? WHERE id = ?').run(printer, oid);
            try {
              const printers = await getPrintersHidden();
              const hasPrinter = printers.some(p => matchPrinter(p.name, printer));
              if (hasPrinter) {
                tracker.markOrderPrinted(oid);
                if (order.is_id_copy) {
                  const frontPath = path.join(__dirname, 'uploads', order.file_path);
                  const backPath = order.back_file_path ? path.join(__dirname, 'uploads', order.back_file_path) : '';
                  const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
                  await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath, backPath, outputPath: combinedPath });
                  await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
                } else {
                  await printFile(path.join(__dirname, 'uploads', order.file_path), order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
                }
              }
            } catch (e) {
              console.error('Razorpay auto-print error:', e.message);
            }
          }
        }
      }
    }

    res.json({ success: true, message: autoPrintEnabled ? 'Payment verified. Printing started.' : 'Payment verified. Waiting for admin approval.' });
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cashfree: create order & get payment_session_id
app.post('/api/create-cashfree-order', async (req, res) => {
  try {
    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(503).json({ error: 'Cashfree Payment Gateway is not configured on this server' });
    }

    const { amount, orderIds, customerName, customerMobile } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const cashfreeOrderId = 'CF_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const amountVal = Number(amount).toFixed(2);

    const hostHeader = req.get('host') || '';
    const isLocal = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1');
    const baseUrl = isLocal ? 'https://printing-store.onrender.com' : `https://${hostHeader}`;
    const returnUrl = `${baseUrl}/api/verify-cashfree-payment?order_id={order_id}`;

    const postData = JSON.stringify({
      order_id: cashfreeOrderId,
      order_amount: parseFloat(amountVal),
      order_currency: 'INR',
      customer_details: {
        customer_id: 'cust_' + Date.now(),
        customer_name: customerName || 'Customer',
        customer_phone: customerMobile && customerMobile.length >= 10 ? customerMobile : '9999999999'
      },
      order_meta: {
        return_url: returnUrl
      }
    });

    const host = CASHFREE_ENV === 'PROD' || CASHFREE_ENV === 'PRODUCTION' ? 'api.cashfree.com' : 'sandbox.cashfree.com';
    const options = {
      hostname: host,
      port: 443,
      path: '/pg/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const request = https.request(options, (response) => {
      let result = '';
      response.on('data', (chunk) => { result += chunk; });
      response.on('end', () => {
        try {
          const resObj = JSON.parse(result);
          if (resObj.payment_session_id) {
            if (Array.isArray(orderIds)) {
              const stmt = db.prepare('UPDATE orders SET cashfree_order_id = ?, payment_method = ? WHERE id = ?');
              for (const oid of orderIds) {
                stmt.run(cashfreeOrderId, 'cashfree', oid);
              }
            }
            return res.json({
              success: true,
              cashfreeOrderId: cashfreeOrderId,
              paymentSessionId: resObj.payment_session_id,
              environment: CASHFREE_ENV
            });
          } else {
            console.error('Cashfree order creation error:', result);
            return res.status(500).json({ error: resObj.message || 'Failed to create Cashfree order session' });
          }
        } catch (e) {
          console.error('Cashfree response parse error:', e);
          return res.status(500).json({ error: 'Invalid response from Cashfree API' });
        }
      });
    });

    request.on('error', (err) => {
      console.error('Cashfree request error:', err);
      return res.status(500).json({ error: 'Failed to communicate with Cashfree' });
    });

    request.write(postData);
    request.end();

  } catch (err) {
    console.error('Cashfree order error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Cashfree: verify order status
app.post('/api/verify-cashfree-payment', async (req, res) => {
  try {
    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return res.status(503).json({ error: 'Cashfree Payment Gateway is not configured on this server' });
    }

    const { cashfreeOrderId, orderIds } = req.body;
    const cfOrderId = cashfreeOrderId || req.query.order_id;

    if (!cfOrderId) {
      return res.status(400).json({ error: 'Missing Cashfree Order ID' });
    }

    const host = CASHFREE_ENV === 'PROD' || CASHFREE_ENV === 'PRODUCTION' ? 'api.cashfree.com' : 'sandbox.cashfree.com';
    const options = {
      hostname: host,
      port: 443,
      path: `/pg/orders/${encodeURIComponent(cfOrderId)}`,
      method: 'GET',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      }
    };

    const request = https.request(options, (response) => {
      let result = '';
      response.on('data', (chunk) => { result += chunk; });
      response.on('end', async () => {
        try {
          const resObj = JSON.parse(result);
          if (resObj.order_status === 'PAID') {
            const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
            const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';

            const autoPrintRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('razorpay_autoprint_enabled');
            const autoPrintEnabled = autoPrintRow ? autoPrintRow.value === '1' : true;

            const targetOrderIds = Array.isArray(orderIds) && orderIds.length > 0 ? orderIds : [];
            if (targetOrderIds.length === 0) {
              const rows = db.prepare('SELECT id FROM orders WHERE cashfree_order_id = ?').all(cfOrderId);
              targetOrderIds.push(...rows.map(r => r.id));
            }

            for (const oid of targetOrderIds) {
              db.prepare('UPDATE orders SET status = ?, payment_method = ?, cashfree_order_id = ? WHERE id = ? AND status = ?')
                .run('paid', 'cashfree', cfOrderId, oid, 'pending');

              if (autoPrintEnabled) {
                const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
                if (order) {
                  tracker.unmarkOrderPrinted(oid);
                  db.prepare('UPDATE orders SET status = ?, is_printed = 0 WHERE id = ?').run('accepted', oid);
                  const printer = await resolvePrinterName(order.printer_name, order.print_type === 'color');
                  db.prepare('UPDATE orders SET printer_name = ? WHERE id = ?').run(printer, oid);
                  try {
                    const printers = await getPrintersHidden();
                    const hasPrinter = printers.some(p => matchPrinter(p.name, printer));
                    if (hasPrinter) {
                      tracker.markOrderPrinted(oid);
                      if (order.is_id_copy) {
                        const frontPath = path.join(__dirname, 'uploads', order.file_path);
                        const backPath = order.back_file_path ? path.join(__dirname, 'uploads', order.back_file_path) : '';
                        const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
                        await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath, backPath, outputPath: combinedPath });
                        await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
                      } else {
                        await printFile(path.join(__dirname, 'uploads', order.file_path), order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
                      }
                    }
                  } catch (e) {
                    console.error('Cashfree auto-print error:', e.message);
                  }
                }
              }
            }

            return res.json({ success: true, message: autoPrintEnabled ? 'Cashfree payment verified. Printing started.' : 'Cashfree payment verified. Waiting for admin approval.' });
          } else {
            return res.status(400).json({ error: 'Payment status is ' + (resObj.order_status || 'PENDING') });
          }
        } catch (e) {
          console.error('Cashfree verify parse error:', e);
          return res.status(500).json({ error: 'Invalid response from Cashfree API' });
        }
      });
    });

    request.on('error', (err) => {
      console.error('Cashfree verify request error:', err);
      return res.status(500).json({ error: 'Failed to communicate with Cashfree' });
    });

    request.end();

  } catch (err) {
    console.error('Cashfree verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Public /api/admin/* endpoints (accessible without admin token — for
// local-printer.js agent and Razorpay auto-print setting)
// ---------------------------------------------------------------------------
app.get('/api/admin/orders', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/autoprint', (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('autoprint_enabled');
    res.json({ enabled: row ? row.value === '1' : true });
  } catch (err) {
    res.json({ enabled: true });
  }
});

app.post('/api/admin/autoprint', (req, res) => {
  try {
    const { enabled } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('autoprint_enabled', enabled ? '1' : '0');
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/printer-config', (req, res) => {
  try {
    const PRINTER_CONFIG = path.join(__dirname, 'printer-config.json');
    let bwPrinter = 'Kyocera ECOSYS MA4000x KX';
    if (fs.existsSync(PRINTER_CONFIG)) {
      try { bwPrinter = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8')).bwPrinter || bwPrinter; } catch(e){}
    }
    res.json({ bwPrinter });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/select-printer', (req, res) => {
  try {
    const { bwPrinter } = req.body;
    if (!bwPrinter) return res.status(400).json({ error: 'bwPrinter required' });

    const PRINTER_CONFIG = path.join(__dirname, 'printer-config.json');
    fs.writeFileSync(PRINTER_CONFIG, JSON.stringify({ bwPrinter }, null, 2));
    console.log('[PRINTER] Active B&W printer switched to:', bwPrinter);
    res.json({ success: true, bwPrinter });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update printer config' });
  }
});

let lastPrinterHeartbeat = { timestamp: 0, printers: [] };

app.post('/api/printer-heartbeat', (req, res) => {
  try {
    const { printers } = req.body;
    if (Array.isArray(printers)) {
      lastPrinterHeartbeat = {
        timestamp: Date.now(),
        printers: printers
      };
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

app.get('/api/admin/razorpay-autoprint', (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('razorpay_autoprint_enabled');
    res.json({ enabled: row ? row.value === '1' : true });
  } catch (err) {
    res.json({ enabled: true });
  }
});

app.post('/api/admin/razorpay-autoprint', (req, res) => {
  try {
    const { enabled } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('razorpay_autoprint_enabled', enabled ? '1' : '0');
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin Auth Middleware — protects all remaining /api/admin/* routes.
// Login, verify, logout, and the public endpoints above are exempt.
// ---------------------------------------------------------------------------
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/verify' || req.path === '/logout') {
    return next();
  }
  const token = req.headers['x-admin-token'];
  if (!token || !activeAdminTokens.has(token)) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  next();
});

async function printFile(filePath, fileName, printer, printType, printSide, pageRange, copies, orientation) {
  const ext = path.extname(fileName).toLowerCase();
  const isPdf = ext === '.pdf';
  const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
  const copyNum = Math.max(1, parseInt(copies) || 1);
  const orient = (orientation || 'portrait').toLowerCase();
  if (isPdf) {
    const opts = {
      printer,
      monochrome: printType === 'bw',
      side: printSide === 'both' ? 'duplex' : 'simplex',
      copies: copyNum,
      orientation: orient,
      paperSize: 'A4'
    };
    const cleanRange = sanitizePageRange(pageRange);
    if (cleanRange && cleanRange !== 'all') opts.pages = cleanRange;
    console.log(`[PRINT] File: ${fileName} | Type: ${printType} | Side: ${printSide} | Pages: ${cleanRange} | Copies: ${copyNum} | Orientation: ${orient}`);
    await printPdfSilent(filePath, opts);
  } else if (isImage) {
    const imgParams = { filePath, printerName: printer, copies: copyNum, orientation: orient };
    await runPsScript(path.join(__dirname, 'print-image.ps1'), imgParams);
  } else {
    await execP('print /D:"' + printer + '" "' + filePath + '"');
  }
}

app.post('/api/admin/orders/:id/accept', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let batchOrders = [order];
    if (order.batch_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE batch_id = ?').all(order.batch_id);
    } else if (order.cashfree_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE cashfree_order_id = ?').all(order.cashfree_order_id);
    } else if (order.razorpay_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').all(order.razorpay_order_id);
    }

    const payMethod = req.body.paymentMethod || 'cash';
    let count = 0;

    for (const bOrder of batchOrders) {
      if (['paid', 'payment_failed', 'pending', 'created'].includes(bOrder.status)) {
        tracker.unmarkOrderPrinted(bOrder.id);
        const finalPayMethod = (['payment_failed', 'pending', 'created'].includes(bOrder.status)) ? payMethod : (bOrder.payment_method || payMethod);
        db.prepare("UPDATE orders SET status = 'accepted', payment_method = ?, is_printed = 0 WHERE id = ?").run(finalPayMethod, bOrder.id);

        const printer = await resolvePrinterName(req.body.printer, bOrder.print_type === 'color');
        db.prepare('UPDATE orders SET printer_name = ? WHERE id = ?').run(printer, bOrder.id);

        try {
          const printers = await getPrintersHidden();
          const hasPrinter = printers.some(p => matchPrinter(p.name, printer));
          if (hasPrinter) {
            tracker.markOrderPrinted(bOrder.id);
            if (bOrder.is_id_copy) {
              const frontPath = path.join(__dirname, 'uploads', bOrder.file_path);
              const backPath = bOrder.back_file_path ? path.join(__dirname, 'uploads', bOrder.back_file_path) : '';
              const combinedPath = path.join(__dirname, 'uploads', 'combined_' + bOrder.file_path);
              await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath, backPath, outputPath: combinedPath });
              await printFile(combinedPath, 'combined_' + bOrder.file_name, printer, bOrder.print_type, bOrder.print_side, bOrder.page_range, bOrder.copies, bOrder.orientation);
            } else {
              await printFile(path.join(__dirname, 'uploads', bOrder.file_path), bOrder.file_name, printer, bOrder.print_type, bOrder.print_side, bOrder.page_range, bOrder.copies, bOrder.orientation);
            }
          }
        } catch (e) {
          console.error('Accept direct print error:', e.message);
        }
        count++;
      }
    }

    res.json({ success: true, message: `Accepted ${count} order file(s)` });
  } catch (err) {
    console.error('Accept batch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/orders/:id/reject', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let batchOrders = [order];
    if (order.batch_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE batch_id = ?').all(order.batch_id);
    } else if (order.cashfree_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE cashfree_order_id = ?').all(order.cashfree_order_id);
    } else if (order.razorpay_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').all(order.razorpay_order_id);
    }

    for (const bOrder of batchOrders) {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('rejected', bOrder.id);
    }

    res.json({ success: true, message: `Rejected ${batchOrders.length} order file(s).` });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Report Machine/Printer Error for an Order
app.post('/api/admin/orders/:id/report-error', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const reason = req.body.reason || 'Paper Jam / Machine Error';
    db.prepare('UPDATE orders SET status = ?, order_notes = ? WHERE id = ?').run('printer_error', reason, req.params.id);
    console.log(`Machine error reported for order ${req.params.id}: ${reason}`);
    res.json({ success: true, message: 'Machine error reported. Order status updated.' });
  } catch (err) {
    console.error('report-error failure:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Resume Order from Printer Error back to Paid/Accepted
app.post('/api/admin/orders/:id/resume', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('paid', req.params.id);
    console.log(`Order ${req.params.id} resumed from printer error back to paid.`);
    res.json({ success: true, message: 'Order resumed. Ready for admin accept/print.' });
  } catch (err) {
    console.error('resume order failure:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

function deleteOrderFiles(order) {
  if (!order) return;
  const uploadsDir = path.join(__dirname, 'uploads');
  if (order.file_path) {
    const fp = path.join(uploadsDir, order.file_path);
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch (e) { console.error('Failed to delete file:', fp, e); }
    }
  }
  if (order.back_file_path) {
    const bp = path.join(uploadsDir, order.back_file_path);
    if (fs.existsSync(bp)) {
      try { fs.unlinkSync(bp); } catch (e) { console.error('Failed to delete back file:', bp, e); }
    }
  }
  if (order.file_path) {
    const cp = path.join(uploadsDir, 'combined_' + order.file_path);
    if (fs.existsSync(cp)) {
      try { fs.unlinkSync(cp); } catch (e) { console.error('Failed to delete combined file:', cp, e); }
    }
  }
}

app.delete('/api/admin/orders-all', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders').all();
    for (const order of orders) {
      deleteOrderFiles(order);
    }
    db.prepare('DELETE FROM orders').run();

    const uploadsDir = path.join(__dirname, 'uploads');
    let deletedFileCount = 0;
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try { fs.unlinkSync(filePath); deletedFileCount++; } catch (e) {}
      }
    }

    res.json({ success: true, message: `Deleted all ${orders.length} orders and ${deletedFileCount} uploaded document files.` });
  } catch (err) {
    console.error('Delete all orders error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.delete('/api/admin/orders/:id', (req, res) => {
  try {
    if (req.params.id === 'all') {
      const orders = db.prepare('SELECT * FROM orders').all();
      for (const order of orders) {
        deleteOrderFiles(order);
      }
      db.prepare('DELETE FROM orders').run();

      const uploadsDir = path.join(__dirname, 'uploads');
      let deletedFileCount = 0;
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir);
        for (const file of files) {
          const filePath = path.join(uploadsDir, file);
          try { fs.unlinkSync(filePath); deletedFileCount++; } catch (e) {}
        }
      }

      return res.json({ success: true, message: `Deleted all ${orders.length} orders and ${deletedFileCount} uploaded document files.` });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let batchOrders = [order];
    if (order.batch_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE batch_id = ?').all(order.batch_id);
    } else if (order.cashfree_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE cashfree_order_id = ?').all(order.cashfree_order_id);
    } else if (order.razorpay_order_id) {
      batchOrders = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').all(order.razorpay_order_id);
    }

    for (const bOrder of batchOrders) {
      deleteOrderFiles(bOrder);
      db.prepare('DELETE FROM orders WHERE id = ?').run(bOrder.id);
    }

    res.json({ success: true, message: `Deleted ${batchOrders.length} order file(s)` });
  } catch (err) {
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.post('/api/admin/cleanup-files', (req, res) => {
  try {
    const retentionHours = parseInt(req.body?.retentionHours || process.env.PREVIEW_RETENTION_HOURS || '168', 10);
    const retentionMs = retentionHours * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs).toISOString();

    const oldOrders = db.prepare(`
      SELECT * FROM orders 
      WHERE created_at < ? AND status IN ('accepted', 'rejected', 'payment_failed')
    `).all(cutoffDate);

    let deletedFilesCount = 0;
    for (const order of oldOrders) {
      deleteOrderFiles(order);
      deletedFilesCount++;
    }

    const uploadsDir = path.join(__dirname, 'uploads');
    let orphanCount = 0;
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > retentionMs) {
            fs.unlinkSync(filePath);
            orphanCount++;
          }
        } catch (e) {}
      }
    }

    res.json({ success: true, message: `Cleaned uploaded documents older than ${retentionHours} hours (${deletedFilesCount} orders, ${orphanCount} orphan files).` });
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

function autoCleanupUploadedDocuments() {
  try {
    const retentionHours = parseInt(process.env.PREVIEW_RETENTION_HOURS || '168', 10); // 7 days retention for admin preview
    const retentionMs = retentionHours * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs).toISOString();

    const oldOrders = db.prepare(`
      SELECT * FROM orders 
      WHERE created_at < ? AND status IN ('accepted', 'rejected', 'payment_failed')
    `).all(cutoffDate);

    for (const order of oldOrders) {
      deleteOrderFiles(order);
    }

    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > retentionMs) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('Auto cleanup error:', err);
  }
}
autoCleanupUploadedDocuments();
setInterval(autoCleanupUploadedDocuments, 60 * 60 * 1000);


app.get('/api/admin/printers', async (req, res) => {
  try {
    if (lastPrinterHeartbeat.printers && lastPrinterHeartbeat.printers.length > 0) {
      return res.json(lastPrinterHeartbeat.printers);
    }
    if (cachedPrinters) {
      return res.json(cachedPrinters);
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get printers' });
  }
});

app.post('/api/admin/print/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const printer = await resolvePrinterName(req.body.printer, order.print_type === 'color');
    tracker.markOrderPrinted(order.id);

    if (order.is_id_copy) {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      const backPath = order.back_file_path ? path.join(__dirname, 'uploads', order.back_file_path) : '';
      const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
      await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath, backPath, outputPath: combinedPath });
      await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
    } else {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies, order.orientation);
    }

    res.json({ success: true, message: `Sent to printer: ${printer}` });
  } catch (err) {
    console.error('Print error:', err);
    res.status(500).json({ error: 'Print failed: ' + err.message });
  }
});

app.get('/print/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).send('Order not found');

    const name = escapeHtml(order.customer_name);

    const fileUrl = `/uploads/${order.file_path}`;
    const ext = path.extname(order.file_name).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
    const isPdf = ext === '.pdf';

    // For ID Copy, generate combined A4 image if possible
    var combinedImgUrl = '';
    var hasCombined = false;
    if (order.is_id_copy && order.back_file_path) {
      var combinedName = 'combined_' + order.file_path;
      var combinedPath = path.join(__dirname, 'uploads', combinedName);
      combinedImgUrl = '/uploads/' + combinedName;
      if (!fs.existsSync(combinedPath)) {
        try {
          var frontP = path.join(__dirname, 'uploads', order.file_path);
          var backP = path.join(__dirname, 'uploads', order.back_file_path);
          await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath: frontP, backPath: backP, outputPath: combinedPath });
        } catch(e){}
      }
      hasCombined = fs.existsSync(combinedPath);
    }

    var contentHtml = '';
    if (isPdf) {
      contentHtml = `<embed src="${fileUrl}#view=FitH" type="application/pdf" width="100%" height="100%" id="docEmbed">`;
    } else if (isImage) {
      if (hasCombined) {
        contentHtml = `<div class="a4page"><img src="${combinedImgUrl}" class="a4img"></div>`;
      } else if (order.is_id_copy && order.back_file_path) {
        contentHtml = `<div class="idcard-page"><img src="${fileUrl}" id="docImg" class="idcard-img"><div class="idcard-gap"></div><img src="/uploads/${order.back_file_path}" style="display:block;margin:12px auto 0;max-width:86mm;height:auto;"></div>`;
      } else {
        contentHtml = `<img src="${fileUrl}" id="docImg" style="max-width:100%;max-height:100vh;display:block;margin:auto">`;
      }
    } else {
      contentHtml = `<iframe src="${fileUrl}" width="100%" height="100%" frameborder="0"></iframe>`;
    }

    var printStyles = '.content{flex:1;overflow:auto}embed,img,iframe{border:none}';
    if (hasCombined) {
      printStyles += `
.a4page{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.a4img{max-width:100%;max-height:100%;display:block;}
@media print{@page{size:A4;margin:0}body{margin:0}.header{display:none}.content{position:fixed;top:0;left:0;width:100%;height:100%}}`;
    } else if (order.is_id_copy && order.back_file_path) {
      printStyles += `
.idcard-page{width:210mm;height:297mm;margin:0 auto;padding:25mm 0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;}
.idcard-img{max-width:86mm;height:auto;display:block;}
.idcard-gap{height:30mm;}
@media print{@page{size:A4;margin:0}body{margin:0}.header{display:none}.content{overflow:visible}}`;
    } else {
      printStyles += `@media print{.header{display:none}.content{position:fixed;top:0;left:0;width:100%;height:100%}}`;
    }

    res.send(`<!DOCTYPE html>
<html><head><title>Print - ${escapeHtml(order.file_name)}</title>
<style>*{margin:0;padding:0}body{height:100vh;display:flex;flex-direction:column}
.header{padding:10px;background:#f0f2f5;border-bottom:1px solid #ddd;font-family:sans-serif;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.btn-print{padding:8px 20px;background:#1a73e8;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
${printStyles}
</style></head>
<body>
<div class="header"><span>Customer: <strong>${name}</strong> | ${order.print_type === 'bw' ? 'B&W' : 'Color'} | ${order.print_side === 'both' ? 'Both Sides' : 'Single Side'} | ₹${order.price}</span>
<button class="btn-print" onclick="window.print()">Print</button>
</div>
<div class="content">${contentHtml}</div>
<script>
var statusEl = document.querySelector('.header span');
statusEl.innerHTML += ' | <span style="color:#28a745">Sent to printer</span>';
</script>
</body></html>`);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    if (m === '"') return '&quot;';
    return '&#039;';
  });
}

app.get('/api/qr', async (req, res) => {
  try {
    const baseUrl = req.query.url || `${req.protocol}://${req.get('host')}`;
    const qrDataUrl = await qrcode.toDataURL(baseUrl, { width: 300, margin: 2 });
    res.json({ qr: qrDataUrl, url: baseUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

app.get('/api/upi-qr', async (req, res) => {
  try {
    const amount = req.query.amount || '';
    const name = req.query.name || 'ANITA SHIVAJI KADAM';
    const upiId = '8698411983@ibl';
    let upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=Printing%20Store`;
    if (amount) upiLink += `&am=${amount}`;
    const qrDataUrl = await qrcode.toDataURL(upiLink, { width: 300, margin: 2 });
    res.json({ qr: qrDataUrl, upiLink, upiId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate UPI QR' });
  }
});

const idcUpload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }).fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 }
]);

app.post('/api/upload-id-copy', (req, res) => {
  idcUpload(req, res, async function(err) {
    if (err) {
      console.error('ID Copy multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    try {
      const frontFile = req.files && req.files.front && req.files.front[0];
      if (!frontFile) return res.status(400).json({ error: 'Front image required' });

      const { customerName, printType, printSide, paymentMethod, backEnabled } = req.body;
      if (!customerName || !printType || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (printType === 'color' && printSide === 'both') {
        return res.status(400).json({ error: 'Color printing does not support Both Sides' });
      }

      const initialStatus = 'pending';
      const isBack = backEnabled === 'true' || backEnabled === true;
      const backFile = isBack && req.files && req.files.back && req.files.back[0] ? req.files.back[0] : null;

      const pages = 1; // ID Copy is 1 sheet
      const sheets = printType === 'bw' ? 1 : 1;
      const price = printType === 'bw' ? 5 : 10;

      const id = uuidv4();
      const stmt = db.prepare(`
        INSERT INTO orders (id, customer_name, file_name, file_path, back_file_name, back_file_path, back_enabled, page_count, print_type, print_side, price, payment_method, status, is_id_copy, copies)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `);
      stmt.run(id, customerName, frontFile.originalname, frontFile.filename,
        backFile ? backFile.originalname : null,
        backFile ? backFile.filename : null,
        isBack ? 1 : 0,
        pages, printType, printSide || 'single', price, paymentMethod, initialStatus);

      res.json({ orderId: id, price, message: `ID Copy uploaded (${isBack ? 'Front+Back' : 'Front only'})` });
    } catch (err) {
      console.error('ID Copy upload error:', err);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Printing Store Server running at http://localhost:${PORT}`);
  console.log(`Customer page: http://localhost:${PORT}`);
  console.log(`Admin login: http://localhost:${PORT}/admin-login.html`);
});
