const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execFile } = require('child_process');
// Don't import getPrinters — it spawns Powershell.exe without windowsHide (causes the flash loop)
// We implement our own hidden version below
// SumatraPDF path bundled with pdf-to-printer
const SUMATRA = path.join(__dirname, 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe');

var cachedPrinters = null;
var lastPrinterCheck = 0;

// getPrinters replacement — runs WMI query directly via execFile (no cmd.exe shell flash) & caches for 5 minutes
function getPrintersHidden() {
  var now = Date.now();
  if (cachedPrinters && (now - lastPrinterCheck < 300000)) {
    return Promise.resolve(cachedPrinters);
  }
  return new Promise(function(resolve) {
    var args = [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', 'Get-CimInstance Win32_Printer -Property DeviceID,Name,PrinterPaperNames | ForEach-Object { $_.Name }'
    ];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 15000 }, function(err, stdout) {
      if (err || !stdout) return resolve(cachedPrinters || []);
      var names = stdout.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
      cachedPrinters = names.map(function(n) { return { name: n }; });
      lastPrinterCheck = Date.now();
      resolve(cachedPrinters);
    });
  });
}

// Run a PowerShell script with named parameters, fully hidden via execFile (bypasses cmd.exe window)
function runPsScript(psFile, params) {
  return new Promise(function(resolve, reject) {
    var args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', psFile];
    if (params) {
      Object.entries(params).forEach(function(kv) {
        args.push('-' + kv[0], String(kv[1]));
      });
    }
    execFile('powershell.exe', args, { windowsHide: true, timeout: 60000 }, function(err, stdout, stderr) {
      resolve({ stdout, stderr });
    });
  });
}

function sanitizePageRange(rangeStr) {
  if (!rangeStr || rangeStr === 'all') return 'all';
  var cleaned = String(rangeStr).replace(/[^0-9,-]/g, '').trim();
  cleaned = cleaned.replace(/^[,|-]+|[,|-]+$/g, '');
  return cleaned || 'all';
}

// Print PDF silently using SumatraPDF directly via spawn (no flash)
function printSinglePdfPage(filePath, opts) {
  return new Promise(function(resolve, reject) {
    var sumatraArgs = [
      '-print-to', opts.printer,
      '-silent',
      '-exit-on-print'
    ];
    var settings = ['fit', 'paper=A4']; // fit = stretch content to printable area on A4 paper
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

    var cleanRange = sanitizePageRange(opts.pages);
    if (cleanRange && cleanRange !== 'all') settings.push(cleanRange);

    var pps = parseInt(opts.pagesPerSheet) || 1;
    if (pps === 2) {
      settings.push('2-up');
    } else if (pps === 4) {
      settings.push('4-up');
    }

    if (settings.length) sumatraArgs.push('-print-settings', settings.join(','));
    sumatraArgs.push(filePath);

    console.log('[PRINT] SumatraPDF args:', sumatraArgs.join(' '));
    var child = spawn(SUMATRA, sumatraArgs, { windowsHide: true, detached: false });
    child.on('close', function(code) { resolve(code); });
    child.on('error', reject);
  });
}

async function printPdfSilent(filePath, opts) {
  var copyCount = Math.max(1, parseInt(opts.copies) || 1);
  console.log('[PRINT] Printing PDF:', filePath, '| Requested copies:', copyCount);
  for (var i = 0; i < copyCount; i++) {
    console.log('[PRINT] Printing set ' + (i + 1) + ' of ' + copyCount + ' to ' + opts.printer + '...');
    await printSinglePdfPage(filePath, opts);
  }
}

// Simple hidden exec (for non-PS commands)
function execP(cmd) {
  return new Promise(function(resolve, reject) {
    exec(cmd, { windowsHide: true }, function(err, stdout, stderr) {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

const RENDER_URL = 'https://printing-store.onrender.com';
const BW_PRINTER_DEFAULT = 'Kyocera ECOSYS MA4000x KX';
const COLOR_PRINTER_DEFAULT = 'HP95224C (HP Smart Tank 580-590 series)';
const PRINTER_CONFIG = path.join(__dirname, 'printer-config.json');
var BW_PRINTER = BW_PRINTER_DEFAULT;
var COLOR_PRINTER = COLOR_PRINTER_DEFAULT;
if (fs.existsSync(PRINTER_CONFIG)) {
  try {
    var cfg = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8'));
    BW_PRINTER = cfg.bwPrinter || BW_PRINTER;
    COLOR_PRINTER = cfg.colorPrinter || COLOR_PRINTER;
  } catch(e) {}
}
const tracker = require('./printer-tracker');
const TRACKING_FILE = path.join(__dirname, 'printed-orders.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

let printed = {};
if (fs.existsSync(TRACKING_FILE)) {
  printed = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
}

function savePrinted() {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(printed, null, 2));
}

function fetchJson(url) {
  return new Promise(function(resolve, reject) {
    var mod = url.startsWith('https') ? https : http;
    mod.get(url, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise(function(resolve, reject) {
    var file = fs.createWriteStream(dest);
    var mod = url.startsWith('https') ? https : http;
    mod.get(url, function(res) {
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch(e){}
        return reject(new Error('Failed to download ' + url + ' (HTTP Status ' + res.statusCode + ')'));
      }
      res.pipe(file);
      file.on('finish', function() { file.close(); resolve(); });
    }).on('error', function(err) {
      file.close();
      if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch(e){}
      reject(err);
    });
  });
}

async function sendPrinterHeartbeat() {
  try {
    var printers = await getPrintersHidden();
    var payload = JSON.stringify({ printers: printers });
    var url = new URL(RENDER_URL + '/api/printer-heartbeat');
    var mod = url.protocol === 'https:' ? https : http;

    var req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {});
    req.on('error', function(e) {});
    req.write(payload);
    req.end();
  } catch (e) {}
}

async function resolvePrinterName(targetName) {
  var activeBw = BW_PRINTER_DEFAULT;
  if (fs.existsSync(PRINTER_CONFIG)) {
    try { activeBw = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8')).bwPrinter || activeBw; } catch(e) {}
  }
  if (!targetName) return activeBw;

  var tName = (targetName || '').toLowerCase();
  if (tName.includes('205i') || tName.includes('konica')) return 'KONICA MINOLTA 205i(36:33:9E)';
  if (tName.includes('kyocera')) return 'Kyocera ECOSYS MA4000x KX';
  if (tName.includes('hp') || tName.includes('smart tank')) return COLOR_PRINTER;
  try {
    var printers = await getPrintersHidden();
    for (var i = 0; i < printers.length; i++) {
      var p = printers[i];
      if (p && p.name) {
        var pName = p.name.toLowerCase();
        if (p.name === targetName || pName.includes(tName) || tName.includes(pName)) return p.name;
      }
    }
  } catch (e) {}
  return activeBw;
}

var activePrints = new Set();

async function checkAndPrint() {
  try {
    // Sync active B&W printer selection from Render server
    try {
      var serverCfg = await fetchJson(RENDER_URL + '/api/admin/printer-config');
      if (serverCfg && serverCfg.bwPrinter) {
        fs.writeFileSync(PRINTER_CONFIG, JSON.stringify({ bwPrinter: serverCfg.bwPrinter }, null, 2));
      }
    } catch(e) {}

    var orders = await fetchJson(RENDER_URL + '/api/admin/orders');
    if (!Array.isArray(orders)) return; // server not ready or returned an error object
    var acceptedOrders = orders.filter(function(o) { return o.status === 'accepted' && !tracker.isOrderPrinted(o.id); });
    if (orders.length > 0) {
      console.log('Found', orders.length, 'total orders,', acceptedOrders.length, 'to print');
    }
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (order.status === 'accepted' && !tracker.isOrderPrinted(order.id) && !activePrints.has(order.id)) {
        activePrints.add(order.id);
        tracker.markOrderPrinted(order.id);
        var backLocal = '';
        var combinedPath = '';
        var localFile = '';
        try {
          var fileUrl = RENDER_URL + '/uploads/' + order.file_path;
          console.log('New order:', order.file_name, '-', order.customer_name, '(copies:', order.copies, ')');
          console.log('Downloading:', fileUrl);
          var ext = path.extname(order.file_name).toLowerCase();
          localFile = path.join(DOWNLOAD_DIR, order.file_path);

          fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
          await downloadFile(fileUrl, localFile);

          // Dynamically fetch current active B&W printer
          var activeBw = BW_PRINTER_DEFAULT;
          if (fs.existsSync(PRINTER_CONFIG)) {
            try { activeBw = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8')).bwPrinter || activeBw; } catch(e) {}
          }

          var isColorOrder = (order.print_type === 'color');
          var requestedPrinter = isColorOrder ? COLOR_PRINTER : activeBw;
          var printer = await resolvePrinterName(requestedPrinter);
          console.log('DEBUG: order.id=' + order.id + ', copies=' + order.copies + ', printer=' + printer + ', file=' + order.file_name);
          var isPdf = ext === '.pdf';
          var isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
          var copyNum = Math.max(1, parseInt(order.copies) || 1);

          var orient = (order.orientation || 'portrait').toLowerCase();
          if (order.is_id_copy) {
            // Combine front (+ back if available) into side-by-side A4 image (86x54 mm)
            if (order.back_file_path) {
              var backUrl = RENDER_URL + '/uploads/' + order.back_file_path;
              backLocal = path.join(DOWNLOAD_DIR, order.back_file_path);
              await downloadFile(backUrl, backLocal);
            }
            combinedPath = path.join(DOWNLOAD_DIR, 'combined_' + order.file_path);
            var psParams = { frontPath: localFile, outputPath: combinedPath };
            if (backLocal) psParams.backPath = backLocal;
            await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), psParams);
            var idPrintParams = { filePath: combinedPath, printerName: printer, copies: copyNum, orientation: orient };
            await runPsScript(path.join(__dirname, 'print-image.ps1'), idPrintParams);
            console.log('Printed combined ID copy (86x54 mm) to', printer);
          } else if (isPdf) {
            var pdfOpts = { printer: printer, silent: true, monochrome: order.print_type === 'bw', side: order.print_side === 'both' ? 'duplex' : 'simplex', paperSize: 'A4', copies: copyNum, orientation: orient, pagesPerSheet: order.pages_per_sheet || 1 };
            if (order.page_range && order.page_range !== 'all') pdfOpts.pages = order.page_range;
            await printPdfSilent(localFile, pdfOpts);
            console.log('Printed', copyNum, 'copy' + (copyNum > 1 ? 'ies' : '') + ' to', printer);
          } else if (isImage) {
            var imgPrintParams = { filePath: localFile, printerName: printer, copies: copyNum, orientation: orient };
            await runPsScript(path.join(__dirname, 'print-image.ps1'), imgPrintParams);
          } else {
            await execP('print /D:"' + printer + '" "' + localFile + '"');
          }

          console.log('Printed:', order.file_name, 'to', printer);

          // Notify server to mark printed & delete server uploads
          try {
            fetchJson(RENDER_URL + '/api/orders/' + order.id + '/mark-printed').catch(function(){});
          } catch(e){}

          // Clean up downloaded local files
          try {
            if (localFile && fs.existsSync(localFile)) { fs.unlinkSync(localFile); }
            if (backLocal && fs.existsSync(backLocal)) { fs.unlinkSync(backLocal); }
            if (combinedPath && fs.existsSync(combinedPath)) { fs.unlinkSync(combinedPath); }
            console.log('Deleted downloaded local files for order:', order.id);
          } catch(e) {
            console.error('Error deleting local downloaded files:', e.message);
          }
        } catch(e) {
          console.error('Failed to print order ' + order.id + ':', e.message);
        } finally {
          activePrints.delete(order.id);
        }
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (e.stack) console.error('Stack:', e.stack.split('\n').slice(0,3).join('\n'));
  }
}

console.log('Local printer agent started');
console.log('Polling:', RENDER_URL);
console.log('B&W printer:', BW_PRINTER);
console.log('Color printer:', COLOR_PRINTER);
console.log('Downloads dir:', DOWNLOAD_DIR);
console.log('Tracking file:', TRACKING_FILE);
console.log('Already printed:', Object.keys(printed).length, 'orders');
try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); console.log('Downloads dir ready'); } catch(e) { console.error('Failed to create downloads dir:', e.message); }
console.log('');
console.log('IMPORTANT: If the BW printer prints extra copies, run this ONCE as Admin:');
console.log('  Set-PrintConfiguration -PrinterName "' + BW_PRINTER + '" -CopyCount 1');
console.log('');
console.log('Checking every 3 seconds...');
checkAndPrint();
setInterval(checkAndPrint, 3000);
