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
const db = require('./db');
const execP = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

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

      const { customerName, printType, printSide, paymentMethod } = req.body;

      if (!customerName || !printType || !printSide || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (printType === 'color' && printSide === 'both') {
        return res.status(400).json({ error: 'Color printing does not support Both Sides' });
      }

      const initialStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
      const stmt = db.prepare(`
        INSERT INTO orders (id, customer_name, file_name, file_path, page_count, print_type, print_side, price, payment_method, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const price = printType === 'bw' ? sheets * 5 : sheets * 10;
        const id = uuidv4();

        stmt.run(id, customerName, file.originalname, file.filename, pages, printType, printSide, price, paymentMethod, initialStatus);

        orders.push({
          orderId: id,
          price,
          pageCount: pages,
          sheets,
          fileName: file.originalname
        });
        totalPrice += price;
      }

      res.json({
        orders,
        totalPrice,
        customerName,
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

// ID Copy upload: receives front (+ optional back) as single order item
const uploadFields = upload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 }
]);

app.post('/api/upload-id-copy', (req, res) => {
  uploadFields(req, res, async function(err) {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    try {
      const frontFiles = req.files && req.files['front'];
      const backFiles = req.files && req.files['back'];
      if (!frontFiles || frontFiles.length === 0) {
        return res.status(400).json({ error: 'Front side image is required' });
      }

      const { customerName, printType, printSide, paymentMethod, copies, layout, backEnabled, printScale } = req.body;
      if (!customerName || !printType || !printSide || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (printType === 'color' && printSide === 'both') {
        return res.status(400).json({ error: 'Color printing does not support Both Sides' });
      }

      const initialStatus = paymentMethod === 'cash' ? 'paid' : 'pending';
      const id = uuidv4();
      const frontFile = frontFiles[0];
      const hasBack = backFiles && backFiles.length > 0 && backEnabled !== 'false';
      const backFile = hasBack ? backFiles[0] : null;

      const settings = getSettings();
      const sheets = 1; // 1 sheet per image
      let price = printType === 'bw' ? sheets * 5 : sheets * 10;
      if (hasBack && settings.chargeBack) {
        price += printType === 'bw' ? sheets * 5 : sheets * 10;
      }
      price *= parseInt(copies || 1, 10);

      const stmt = db.prepare(`
        INSERT INTO orders (id, customer_name, file_name, file_path, page_count, print_type, print_side, price, payment_method, status, is_id_copy, back_file_name, back_file_path, back_enabled, copies, layout, print_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id, customerName,
        frontFile.originalname, frontFile.filename,
        1, printType, printSide, price, paymentMethod, initialStatus,
        backFile ? backFile.originalname : null,
        backFile ? backFile.filename : null,
        hasBack ? 1 : 0,
        parseInt(copies || 1, 10),
        layout || 'separate',
        parseFloat(printScale) || 1.0
      );

      res.json({
        orderId: id,
        price,
        customerName,
        printType: printType === 'bw' ? 'Black & White' : 'Color',
        printSide: printSide === 'both' ? 'Both Sides' : 'Single Side',
        paymentMethod,
        copies: parseInt(copies || 1, 10),
        hasBack,
        layout: layout || 'separate'
      });
    } catch (err) {
      console.error('ID Copy upload error:', err);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
});

// Admin: toggle back charge setting
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { chargeBack: false };
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

app.get('/api/admin/settings', (req, res) => {
  res.json(getSettings());
});

app.post('/api/admin/settings', (req, res) => {
  const settings = getSettings();
  if (typeof req.body.chargeBack === 'boolean') {
    settings.chargeBack = req.body.chargeBack;
  }
  saveSettings(settings);
  res.json(settings);
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

app.get('/api/admin/orders', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function printFile(filePath, fileName, printer, printType, printSide, printScale) {
  const ext = path.extname(fileName).toLowerCase();
  const isPdf = ext === '.pdf';
  const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
  if (isPdf) {
    await printPdf(filePath, {
      printer, silent: true,
      monochrome: printType === 'bw',
      side: printType === 'bw' && printSide === 'both' ? 'duplex' : 'simplex',
      paperSize: 'A4'
    });
  } else if (isImage) {
    await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'print-image.ps1') + '" -filePath "' + filePath + '" -printerName "' + printer + '"' + (printScale && printScale !== 1.0 ? ' -printScale ' + printScale : ''));
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

    const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
    const printer = order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER;

    try {
      const printers = await getPrinters();
      const hasPrinter = printers.some(function(p) { return p.name === printer; });
      if (hasPrinter) {
        const scale = order.print_scale || 1.0;
        // Print front file
        const frontPath = path.join(__dirname, 'uploads', order.file_path);
        await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side, scale);
        // Print back file if present
        if (order.is_id_copy && order.back_enabled && order.back_file_path) {
          const backPath = path.join(__dirname, 'uploads', order.back_file_path);
          await printFile(backPath, order.back_file_name, printer, order.print_type, order.print_side, scale);
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

    const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
    const printer = req.body.printer || (order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER);

    const scale = order.print_scale || 1.0;
    const frontPath = path.join(__dirname, 'uploads', order.file_path);
    await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side, scale);

    if (order.is_id_copy && order.back_enabled && order.back_file_path) {
      const backPath = path.join(__dirname, 'uploads', order.back_file_path);
      await printFile(backPath, order.back_file_name, printer, order.print_type, order.print_side, scale);
    }

    res.json({ success: true, message: `Sent to printer: ${printer}` });
  } catch (err) {
    console.error('Print error:', err);
    res.status(500).json({ error: 'Print failed: ' + err.message });
  }
});

app.get('/print/:id', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).send('Order not found');

    const name = escapeHtml(order.customer_name);
    const copies = order.copies || 1;
    const isIdCopy = order.is_id_copy;

    let extraInfo = '';
    if (isIdCopy) {
      extraInfo = ` | <strong>Front &amp; Back ID Copy</strong> × ${copies}`;
      if (order.back_enabled && order.back_file_path) {
        extraInfo += ` | Back: ${escapeHtml(order.back_file_name || '')}`;
      } else {
        extraInfo += ` | Single-sided`;
      }
    }

    let contentHtml = '';
    if (isIdCopy) {
      // Show both front and back
      const frontUrl = `/uploads/${order.file_path}`;
      contentHtml = `<div style="display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px;">
        <div style="text-align:center;width:100%;max-width:500px;">
          <h3 style="margin-bottom:8px;">Front</h3>
          <img src="${frontUrl}" style="max-width:100%;max-height:45vh;border:1px solid #ddd;border-radius:4px;">
        </div>`;
      if (order.back_enabled && order.back_file_path) {
        const backUrl = `/uploads/${order.back_file_path}`;
        contentHtml += `<div style="text-align:center;width:100%;max-width:500px;">
          <h3 style="margin-bottom:8px;">Back</h3>
          <img src="${backUrl}" style="max-width:100%;max-height:45vh;border:1px solid #ddd;border-radius:4px;">
        </div>`;
      }
      contentHtml += `</div>`;
    } else {
      const fileUrl = `/uploads/${order.file_path}`;
      const ext = path.extname(order.file_name).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
      const isPdf = ext === '.pdf';
      if (isPdf) {
        contentHtml = `<embed src="${fileUrl}#view=FitH" type="application/pdf" width="100%" height="100%" id="docEmbed">`;
      } else if (isImage) {
        contentHtml = `<img src="${fileUrl}" id="docImg" style="max-width:100%;max-height:100vh;display:block;margin:auto">`;
      } else {
        contentHtml = `<iframe src="${fileUrl}" width="100%" height="100%" frameborder="0"></iframe>`;
      }
    }

    res.send(`<!DOCTYPE html>
<html><head><title>Print - ${isIdCopy ? 'ID Copy' : escapeHtml(order.file_name)}</title>
<style>*{margin:0;padding:0}body{height:100vh;display:flex;flex-direction:column}
.header{padding:10px;background:#f0f2f5;border-bottom:1px solid #ddd;font-family:sans-serif;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.content{flex:1;overflow:auto}embed,img,iframe{border:none}
.btn-print{padding:8px 20px;background:#1a73e8;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
@media print{.header{display:none}.content{position:fixed;top:0;left:0;width:100%;height:100%}}
</style></head>
<body>
<div class="header"><span>Customer: <strong>${name}</strong>${extraInfo} | ${order.print_type === 'bw' ? 'B&W' : 'Color'} | ${order.print_side === 'both' ? 'Both Sides' : 'Single Side'} | ₹${order.price}</span>
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
