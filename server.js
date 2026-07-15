const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const { exec } = require('child_process');
const { promisify } = require('util');
const { print: printPdf, getPrinters } = require('pdf-to-printer');
const pdfParse = require('pdf-parse');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('./db');
const execP = promisify(exec);

// Load environment variables from .env file (never commit .env)
require('dotenv').config();

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
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

      if (!customerName || !printType || !printSide || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (printType === 'color' && printSide === 'both') {
        return res.status(400).json({ error: 'Color printing does not support Both Sides' });
      }

      const copyCount = parseInt(copies) || 1;
      const initialStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
      const stmt = db.prepare(`
        INSERT INTO orders (id, customer_name, file_name, file_path, page_count, print_type, print_side, price, payment_method, status, mobile_number, order_notes, orientation, copies, page_range)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const orders = [];
      let totalPrice = 0;

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        let pages = await getPageCount(file.path, ext);

        const manualPages = req.body['pageCount_' + file.originalname];
        if (manualPages) pages = parseInt(manualPages, 10);

        if (!pages || pages < 1) pages = 1;

        const sheets = printSide === 'both' ? Math.ceil(pages / 2) : pages;
        const basePrice = printType === 'bw' ? sheets * 5 : sheets * 10;
        const price = basePrice * copyCount;
        const id = uuidv4();

        stmt.run(id, customerName, file.originalname, file.filename, pages, printType, printSide, price, paymentMethod, initialStatus, mobileNumber || null, orderNotes || null, orientation || 'portrait', copyCount, pageRange || 'all');

        orders.push({
          orderId: id,
          price,
          pageCount: pages,
          sheets,
          fileName: file.originalname,
          copies: copyCount
        });
        totalPrice += price;
      }

      res.json({
        orders,
        totalPrice,
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
    const BW_PRINTER = 'KONICA MINOLTA 205i(36:33:9E)';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';

    if (Array.isArray(orderIds)) {
      for (const oid of orderIds) {
        db.prepare('UPDATE orders SET status = ?, razorpay_order_id = ? WHERE id = ? AND status = ?').run('paid', razorpayOrderId, oid, 'pending');

        // Existing auto-accept and print logic — kept as-is
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
        if (order) {
          db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('accepted', oid);
          const printer = order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER;
          db.prepare('UPDATE orders SET printer_name = ? WHERE id = ?').run(printer, oid);
          try {
            const printers = await getPrinters();
            const hasPrinter = printers.some(p => p.name === printer);
            if (hasPrinter) {
              if (order.is_id_copy && order.back_file_path) {
                const frontPath = path.join(__dirname, 'uploads', order.file_path);
                const backPath = path.join(__dirname, 'uploads', order.back_file_path);
                const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
                await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontPath + '" -backPath "' + backPath + '" -outputPath "' + combinedPath + '"');
                await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
              } else {
                await printFile(path.join(__dirname, 'uploads', order.file_path), order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
              }
            }
          } catch (e) {}
        }
      }
    }

    res.json({ success: true, message: 'Payment verified. Printing started.' });
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/orders', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function printFile(filePath, fileName, printer, printType, printSide, pageRange, copies) {
  const ext = path.extname(fileName).toLowerCase();
  const isPdf = ext === '.pdf';
  const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
  if (isPdf) {
    const opts = {
      printer, silent: true,
      monochrome: printType === 'bw',
      side: printType === 'bw' && printSide === 'both' ? 'duplex' : 'simplex',
      paperSize: 'A4'
    };
    if (pageRange && pageRange !== 'all') opts.pages = pageRange;
    // Always pass copies (even 1) to override printer driver defaults
    if (copies) opts.copies = copies;
    await printPdf(filePath, opts);
  } else if (isImage) {
    await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'print-image.ps1') + '" -filePath "' + filePath + '" -printerName "' + printer + '"');
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
    if (order.status !== 'paid') {
      return res.status(400).json({ error: `Cannot accept order with status "${order.status}"` });
    }

    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('accepted', req.params.id);

    const BW_PRINTER = req.body.printer || 'KONICA MINOLTA 205i(36:33:9E)';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
    const printer = order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER;

    // Save selected printer to order
    db.prepare('UPDATE orders SET printer_name = ? WHERE id = ?').run(printer, req.params.id);

    try {
      const printers = await getPrinters();
      const hasPrinter = printers.some(function(p) { return p.name === printer; });
      if (hasPrinter) {
        if (order.is_id_copy && order.back_file_path) {
          const frontPath = path.join(__dirname, 'uploads', order.file_path);
          const backPath = path.join(__dirname, 'uploads', order.back_file_path);
          const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
          await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontPath + '" -backPath "' + backPath + '" -outputPath "' + combinedPath + '"');
          await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
        } else {
          const frontPath = path.join(__dirname, 'uploads', order.file_path);
          await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
        }
      }
    } catch (e) {}

    res.json({ success: true, message: 'Order accepted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/orders/:id/reject', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'paid') {
      return res.status(400).json({ error: `Cannot reject order with status "${order.status}"` });
    }

    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('rejected', req.params.id);

    res.json({ success: true, message: 'Order rejected.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/printers', async (req, res) => {
  try {
    const list = await getPrinters();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get printers' });
  }
});

app.post('/api/admin/print/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const BW_PRINTER = 'KONICA MINOLTA 205i(36:33:9E)';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
    const printer = req.body.printer || (order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER);

    if (order.is_id_copy && order.back_file_path) {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      const backPath = path.join(__dirname, 'uploads', order.back_file_path);
      const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
      await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontPath + '" -backPath "' + backPath + '" -outputPath "' + combinedPath + '"');
      await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
    } else {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side, order.page_range, order.copies);
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
          await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontP + '" -backPath "' + backP + '" -outputPath "' + combinedPath + '"');
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

const idcUpload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }).fields([
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

      const initialStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
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
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
});
