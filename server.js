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

async function printFile(filePath, fileName, printer, printType, printSide) {
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

    const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
    const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
    const printer = order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER;

    try {
      const printers = await getPrinters();
      const hasPrinter = printers.some(function(p) { return p.name === printer; });
      if (hasPrinter) {
        if (order.is_id_copy && order.back_file_path) {
          const frontPath = path.join(__dirname, 'uploads', order.file_path);
          const backPath = path.join(__dirname, 'uploads', order.back_file_path);
          const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
          await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontPath + '" -backPath "' + backPath + '" -outputPath "' + combinedPath + '"');
          await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side);
        } else {
          const frontPath = path.join(__dirname, 'uploads', order.file_path);
          await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side);
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

    if (order.is_id_copy && order.back_file_path) {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      const backPath = path.join(__dirname, 'uploads', order.back_file_path);
      const combinedPath = path.join(__dirname, 'uploads', 'combined_' + order.file_path);
      await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'combine-idcopy.ps1') + '" -frontPath "' + frontPath + '" -backPath "' + backPath + '" -outputPath "' + combinedPath + '"');
      await printFile(combinedPath, 'combined_' + order.file_name, printer, order.print_type, order.print_side);
    } else {
      const frontPath = path.join(__dirname, 'uploads', order.file_path);
      await printFile(frontPath, order.file_name, printer, order.print_type, order.print_side);
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

    const fileUrl = `/uploads/${order.file_path}`;
    const ext = path.extname(order.file_name).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
    const isPdf = ext === '.pdf';
    let contentHtml = '';
    var backHtml = '';
    if (order.is_id_copy && order.back_file_path) {
      var backUrl = `/uploads/${order.back_file_path}`;
      backHtml = `<img src="${backUrl}" id="docBackImg" style="max-width:100%;max-height:100vh;display:block;margin:auto;page-break-before:always">`;
    }
    if (isPdf) {
      contentHtml = `<embed src="${fileUrl}#view=FitH" type="application/pdf" width="100%" height="100%" id="docEmbed">`;
    } else if (isImage) {
      contentHtml = `<img src="${fileUrl}" id="docImg" style="max-width:100%;max-height:100vh;display:block;margin:auto">${backHtml}`;
    } else {
      contentHtml = `<iframe src="${fileUrl}" width="100%" height="100%" frameborder="0"></iframe>${backHtml}`;
    }

    res.send(`<!DOCTYPE html>
<html><head><title>Print - ${escapeHtml(order.file_name)}</title>
<style>*{margin:0;padding:0}body{height:100vh;display:flex;flex-direction:column}
.header{padding:10px;background:#f0f2f5;border-bottom:1px solid #ddd;font-family:sans-serif;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.content{flex:1;overflow:auto}embed,img,iframe{border:none}
.btn-print{padding:8px 20px;background:#1a73e8;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
@media print{.header{display:none}.content{position:fixed;top:0;left:0;width:100%;height:100%}}
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
