const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { execFileSync } = require('child_process');

/**
 * Converts any image format (BMP, WebP, progressive JPEG, etc.) to a standard PNG using GDI+
 */
function convertImageToPng(srcPath, destPath) {
  const psScript = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.IO.Path]::GetFullPath('${srcPath.replace(/'/g, "''")}')
    $dest = [System.IO.Path]::GetFullPath('${destPath.replace(/'/g, "''")}')
    $img = [System.Drawing.Image]::FromFile($src)
    $bmp = New-Object System.Drawing.Bitmap($img)
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $img.Dispose()
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], {
    windowsHide: true,
    timeout: 30000
  });
}

/**
 * Embeds any image file safely into a PDFDocument instance
 */
async function embedAnyImage(doc, imgPath) {
  let bytes = fs.readFileSync(imgPath);
  // 1. Direct JPEG embed
  try {
    return await doc.embedJpg(bytes);
  } catch (e) {}

  // 2. Direct PNG embed
  try {
    return await doc.embedPng(bytes);
  } catch (e) {}

  // 3. Fallback: convert to PNG via GDI+
  const tempPng = imgPath + '.' + Date.now() + '.tmp.png';
  try {
    convertImageToPng(imgPath, tempPng);
    bytes = fs.readFileSync(tempPng);
    return await doc.embedPng(bytes);
  } finally {
    if (fs.existsSync(tempPng)) {
      try { fs.unlinkSync(tempPng); } catch (e) {}
    }
  }
}

/**
 * Adds an image as an A4 page into a PDFDocument
 */
async function addImagePage(doc, imgPath, orientation = 'portrait') {
  const img = await embedAnyImage(doc, imgPath);
  const isLandscape = (orientation || '').toLowerCase() === 'landscape';
  const pageWidth = isLandscape ? 841.89 : 595.28;
  const pageHeight = isLandscape ? 595.28 : 841.89;

  const page = doc.addPage([pageWidth, pageHeight]);

  // Keep 8pt safety margin for printable area
  const margin = 8;
  const availW = pageWidth - (margin * 2);
  const availH = pageHeight - (margin * 2);

  const scale = Math.min(availW / img.width, availH / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;

  const x = (pageWidth - drawW) / 2;
  const y = (pageHeight - drawH) / 2;

  page.drawImage(img, { x, y, width: drawW, height: drawH });
  return 1;
}

/**
 * Parses page range string (e.g. "1-3,5", "all") into 0-indexed page indices
 */
function parsePageRangeIndices(rangeStr, totalPages) {
  if (!rangeStr || rangeStr === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const clean = String(rangeStr).replace(/\s+/g, '');
  const indices = new Set();
  const parts = clean.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n, 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let p = Math.max(1, start); p <= Math.min(totalPages, end); p++) {
          indices.add(p - 1);
        }
      }
    } else {
      const p = parseInt(part, 10);
      if (!isNaN(p) && p >= 1 && p <= totalPages) {
        indices.add(p - 1);
      }
    }
  }
  const sorted = Array.from(indices).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : Array.from({ length: totalPages }, (_, i) => i);
}

/**
 * Appends selected pages of a PDF into the merged PDFDocument
 */
async function addPdfPages(mergedDoc, pdfPath, pageRange = 'all') {
  const pdfBytes = fs.readFileSync(pdfPath);
  const donorDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const totalPages = donorDoc.getPageCount();
  const pageIndices = parsePageRangeIndices(pageRange, totalPages);
  const copiedPages = await mergedDoc.copyPages(donorDoc, pageIndices);
  for (const p of copiedPages) {
    mergedDoc.addPage(p);
  }
  return copiedPages.length;
}

/**
 * Combines an array of customer files into a single unified multi-page PDF.
 * 
 * @param {Array<Object>} items - List of files to merge:
 *   [ { filePath, fileName, ext, isIdCopy, backFilePath, orientation, pageRange } ]
 * @param {string} outputPath - Target PDF path
 * @param {Object} options - { isDuplex: boolean }
 * @returns {Promise<{ outputPath: string, totalPages: number }>}
 */
async function combineBatchFilesToPdf(items, outputPath, options = {}) {
  const mergedDoc = await PDFDocument.create();
  const isDuplex = !!options.isDuplex;
  const tempFilesToClean = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ext = (item.ext || path.extname(item.filePath || item.fileName || '')).toLowerCase();
      const isLast = (i === items.length - 1);
      let pagesAdded = 0;

      if (item.isIdCopy) {
        // Run combine-idcopy.ps1 if front + back
        let combinedImgPath = item.filePath;
        if (item.runIdCombine) {
          const combinePs = path.join(__dirname, 'combine-idcopy.ps1');
          combinedImgPath = item.filePath + '.combined_id.png';
          tempFilesToClean.push(combinedImgPath);
          const psScript = `
            Add-Type -AssemblyName System.Drawing
            & '${combinePs.replace(/'/g, "''")}' -frontPath '${item.filePath.replace(/'/g, "''")}' ${item.backFilePath ? `-backPath '${item.backFilePath.replace(/'/g, "''")}'` : ''} -outputPath '${combinedImgPath.replace(/'/g, "''")}'
          `;
          try {
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], { windowsHide: true, timeout: 30000 });
          } catch (e) {
            console.error('[COMBINER] combine-idcopy error:', e.message);
            combinedImgPath = item.filePath;
          }
        }
        pagesAdded = await addImagePage(mergedDoc, combinedImgPath, item.orientation || 'portrait');
      } else if (ext === '.pdf') {
        pagesAdded = await addPdfPages(mergedDoc, item.filePath, item.pageRange || 'all');
      } else if (['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.jfif'].includes(ext)) {
        pagesAdded = await addImagePage(mergedDoc, item.filePath, item.orientation || 'portrait');
      } else {
        // Generic fallback: attempt image embed
        try {
          pagesAdded = await addImagePage(mergedDoc, item.filePath, item.orientation || 'portrait');
        } catch (e) {
          console.error('[COMBINER] Could not embed item:', item.filePath, e.message);
        }
      }

      // If Duplex mode (2-sided print), don't let the next document start on the back of the previous document!
      // Add a blank page if this file has an odd number of pages and another file follows.
      if (isDuplex && !isLast && (pagesAdded % 2 !== 0)) {
        const isLandscape = (item.orientation || '').toLowerCase() === 'landscape';
        mergedDoc.addPage(isLandscape ? [841.89, 595.28] : [595.28, 841.89]);
      }
    }

    const finalBytes = await mergedDoc.save();
    fs.writeFileSync(outputPath, finalBytes);
    return {
      outputPath,
      totalPages: mergedDoc.getPageCount()
    };
  } finally {
    for (const f of tempFilesToClean) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    }
  }
}

module.exports = {
  convertImageToPng,
  embedAnyImage,
  addImagePage,
  addPdfPages,
  combineBatchFilesToPdf,
  parsePageRangeIndices
};
