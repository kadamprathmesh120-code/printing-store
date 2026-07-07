const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { print } = require('pdf-to-printer');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

const RENDER_URL = 'https://printing-store.onrender.com';
const BW_PRINTER = 'Kyocera ECOSYS MA4000x KX';
const COLOR_PRINTER = 'HP95224C (HP Smart Tank 580-590 series)';
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

async function checkAndPrint() {
  try {
    var orders = await fetchJson(RENDER_URL + '/api/admin/orders');
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (order.status === 'accepted' && !printed[order.id]) {
        console.log('New order:', order.file_name, '-', order.customer_name);
        var fileUrl = RENDER_URL + '/uploads/' + order.file_path;
        var ext = path.extname(order.file_name).toLowerCase();
        var localFile = path.join(DOWNLOAD_DIR, order.file_path);

        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        await downloadFile(fileUrl, localFile);

        var printer = order.print_type === 'bw' ? BW_PRINTER : COLOR_PRINTER;
        var isPdf = ext === '.pdf';
        var isImage = ['.jpg', '.jpeg', '.png'].includes(ext);
        var scale = order.print_scale || 1.0;

        if (isPdf) {
          await print(localFile, { printer, silent: true, monochrome: order.print_type === 'bw', side: order.print_type === 'bw' && order.print_side === 'both' ? 'duplex' : 'simplex', paperSize: 'A4' });
        } else if (isImage) {
          await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'print-image.ps1') + '" -filePath "' + localFile + '" -printerName "' + printer + '"' + (scale !== 1.0 ? ' -printScale ' + scale : ''));
        } else {
          await execP('print /D:"' + printer + '" "' + localFile + '"');
        }

        // Print back file for ID copy orders
        if (order.is_id_copy && order.back_enabled && order.back_file_path) {
          var backUrl = RENDER_URL + '/uploads/' + order.back_file_path;
          var backLocalFile = path.join(DOWNLOAD_DIR, order.back_file_path);
          try {
            await downloadFile(backUrl, backLocalFile);
            var backExt = path.extname(order.back_file_name || '').toLowerCase();
            if (backExt === '.pdf') {
              await print(backLocalFile, { printer, silent: true, monochrome: order.print_type === 'bw', side: 'simplex', paperSize: 'A4' });
            } else {
              await execP('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(__dirname, 'print-image.ps1') + '" -filePath "' + backLocalFile + '" -printerName "' + printer + '"' + (scale !== 1.0 ? ' -printScale ' + scale : ''));
            }
            console.log('Printed back:', order.back_file_name, 'to', printer);
          } catch (backErr) {
            console.error('Error printing back:', backErr.message);
          }
        }

        printed[order.id] = true;
        savePrinted();
        console.log('Printed:', order.file_name, 'to', printer);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

console.log('Local printer agent started');
console.log('Polling:', RENDER_URL);
console.log('B&W printer:', BW_PRINTER);
console.log('Color printer:', COLOR_PRINTER);
console.log('Checking every 10 seconds...\n');
checkAndPrint();
setInterval(checkAndPrint, 10000);
