const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
// Don't import getPrinters — it spawns Powershell.exe without windowsHide (causes the flash loop)
// We implement our own hidden version below
// SumatraPDF path bundled with pdf-to-printer
const SUMATRA = path.join(__dirname, 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe');

// getPrinters replacement — runs the EXACT same WMI query as pdf-to-printer but fully hidden
function getPrintersHidden() {
  return new Promise(function(resolve) {
    var query = 'Get-CimInstance Win32_Printer -Property DeviceID,Name,PrinterPaperNames | ForEach-Object { $_.Name }';
    exec('powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + query + '"',
      { windowsHide: true, timeout: 15000 },
      function(err, stdout) {
        if (err || !stdout) return resolve([]);
        var names = stdout.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
        resolve(names.map(function(n) { return { name: n }; }));
      }
    );
  });
}


// Run a PowerShell script with named parameters, fully hidden
function runPsScript(psFile, params) {
  return new Promise(function(resolve, reject) {
    // Build param string e.g. -filePath "x" -printerName "y"
    var paramStr = Object.entries(params).map(function(kv) {
      return '-' + kv[0] + ' "' + String(kv[1]).replace(/"/g, '`"') + '"';
    }).join(' ');
    var fullCmd = 'powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass' +
                  ' -File "' + psFile + '" ' + paramStr;
    exec(fullCmd, { windowsHide: true, timeout: 60000 }, function(err, stdout, stderr) {
      resolve({ stdout, stderr });
    });
  });
}

// Print PDF silently using SumatraPDF via PowerShell Start-Process (no flash)
function printPdfSilent(filePath, opts) {
  return new Promise(function(resolve, reject) {
    var sumatraArgs = [
      '-print-to', '"' + opts.printer + '"',
      '-silent',
      '-exit-on-print'
    ];
    var settings = [];
    if (opts.copies && opts.copies > 1) settings.push(opts.copies + 'x');
    if (opts.side === 'duplex') settings.push('duplexlong');
    if (opts.monochrome) settings.push('monochrome');
    if (opts.pages) settings.push(opts.pages);
    if (settings.length) sumatraArgs.push('-print-settings', settings.join(','));
    sumatraArgs.push(filePath);

    // Use spawn with windowsHide — proper arg array avoids any quoting/truncation issues
    var child = spawn(SUMATRA, sumatraArgs, { windowsHide: true, detached: false });
    child.on('close', function(code) { resolve(code); });
    child.on('error', reject);
  });
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
const BW_PRINTER_DEFAULT = 'KONICA MINOLTA 205i(36:33:9E)';
const PRINTER_CONFIG = path.join(__dirname, 'printer-config.json');
var BW_PRINTER = BW_PRINTER_DEFAULT;
if (fs.existsSync(PRINTER_CONFIG)) {
  try { BW_PRINTER = JSON.parse(fs.readFileSync(PRINTER_CONFIG, 'utf8')).bwPrinter || BW_PRINTER; } catch(e) {}
}
const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
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
      res.pipe(file);
      file.on('finish', function() { file.close(); resolve(); });
    }).on('error', function(err) { fs.unlink(dest, function(){}); reject(err); });
  });
}

async function sendPrinterHeartbeat() {
  try {
    var printers = await getPrinters();
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
  if (!targetName) return BW_PRINTER;
  var tName = (targetName || '').toLowerCase();
  if (tName.includes('205i') || tName.includes('konica')) return BW_PRINTER_DEFAULT;
  if (tName.includes('hp') || tName.includes('smart tank')) return COLOR_PRINTER;
  try {
    var printers = await getPrinters();
    for (var i = 0; i < printers.length; i++) {
      var p = printers[i];
      if (p && p.name) {
        var pName = p.name.toLowerCase();
        if (p.name === targetName || pName.includes(tName) || tName.includes(pName)) return p.name;
      }
    }
  } catch (e) {}
  return targetName;
}

async function checkAndPrint() {
  try {
    sendPrinterHeartbeat();
    var orders = await fetchJson(RENDER_URL + '/api/admin/orders');
    if (!Array.isArray(orders)) return; // server not ready or returned an error object
    var acceptedOrders = orders.filter(function(o) { return o.status === 'accepted' && !tracker.isOrderPrinted(o.id); });
    if (orders.length > 0) {
      console.log('Found', orders.length, 'total orders,', acceptedOrders.length, 'to print');
    }
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (order.status === 'accepted' && !tracker.isOrderPrinted(order.id)) {
        var fileUrl = RENDER_URL + '/uploads/' + order.file_path;
        console.log('New order:', order.file_name, '-', order.customer_name, '(copies:', order.copies, ')');
        console.log('Downloading:', fileUrl);
        var ext = path.extname(order.file_name).toLowerCase();
        var localFile = path.join(DOWNLOAD_DIR, order.file_path);

        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        await downloadFile(fileUrl, localFile);

        var requestedPrinter = order.printer_name || (order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER);
        var printer = await resolvePrinterName(requestedPrinter);
        console.log('DEBUG: order.id=' + order.id + ', copies=' + order.copies + ', printer=' + printer + ', file=' + order.file_name);
        var isPdf = ext === '.pdf';
        var isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
        var copyNum = Math.max(1, parseInt(order.copies) || 1);

        if (order.is_id_copy && order.back_file_path) {
          // Combine front+back into single A4 image, print once
          var backUrl = RENDER_URL + '/uploads/' + order.back_file_path;
          var backLocal = path.join(DOWNLOAD_DIR, order.back_file_path);
          await downloadFile(backUrl, backLocal);
          var combinedPath = path.join(DOWNLOAD_DIR, 'combined_' + order.file_path);
          await runPsScript(path.join(__dirname, 'combine-idcopy.ps1'), { frontPath: localFile, backPath: backLocal, outputPath: combinedPath });
          var idPrintParams = { filePath: combinedPath, printerName: printer };
          if (copyNum > 1) idPrintParams.copies = copyNum;
          await runPsScript(path.join(__dirname, 'print-image.ps1'), idPrintParams);
          console.log('Printed combined ID copy to', printer);
        } else if (isPdf) {
          var pdfOpts = { printer, silent: true, monochrome: order.print_type === 'bw', side: order.print_side === 'both' ? 'duplex' : 'simplex', paperSize: 'A4' };
          if (order.page_range && order.page_range !== 'all') pdfOpts.pages = order.page_range;
          if (copyNum > 1) pdfOpts.copies = copyNum;
          await printPdfSilent(localFile, pdfOpts);
          console.log('Printed', copyNum, 'copy' + (copyNum > 1 ? 'ies' : '') + ' to', printer);
        } else if (isImage) {
          var imgPrintParams = { filePath: localFile, printerName: printer };
          if (copyNum > 1) imgPrintParams.copies = copyNum;
          await runPsScript(path.join(__dirname, 'print-image.ps1'), imgPrintParams);
        } else {
          await execP('print /D:"' + printer + '" "' + localFile + '"');
        }

        tracker.markOrderPrinted(order.id);
        console.log('Printed:', order.file_name, 'to', printer);
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
console.log('Checking every 10 seconds...');
checkAndPrint();
setInterval(checkAndPrint, 10000);
