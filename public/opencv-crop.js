var OCV_CROP = (function() {

var ocvReady = false;
var ocvLoading = false;
var ocvQueue = [];

// ---------- OpenCV.js loader ----------
function loadOpenCV(callback) {
  if (ocvReady) { callback(); return; }
  ocvQueue.push(callback);
  if (ocvLoading) return;
  ocvLoading = true;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://docs.opencv.org/4.9.0/opencv.js';
  s.onload = function() {
    var check = function() {
      if (typeof cv !== 'undefined' && cv.Mat && cv.imread) {
        ocvReady = true;
        ocvQueue.forEach(function(f) { f(); });
        ocvQueue = [];
      } else {
        setTimeout(check, 200);
      }
    };
    setTimeout(check, 1000);
  };
  s.onerror = function() {
    ocvLoading = false;
    ocvQueue.forEach(function(f) { f(new Error('OpenCV failed to load')); });
    ocvQueue = [];
  };
  document.head.appendChild(s);
}

// ---------- Fallback detection (pure JS when OpenCV fails) ----------
function detectEdgesPure(data, w, h) {
  var gray = new Float32Array(w * h);
  for (var i = 0; i < w * h; i++) {
    gray[i] = data[i*4] * 0.299 + data[i*4+1] * 0.587 + data[i*4+2] * 0.114;
  }
  var blurred = new Float32Array(w * h);
  for (var y = 1; y < h-1; y++) {
    for (var x = 1; x < w-1; x++) {
      blurred[y*w+x] = (gray[(y-1)*w+x-1] + gray[(y-1)*w+x] + gray[(y-1)*w+x+1] +
                        gray[y*w+x-1] + gray[y*w+x] + gray[y*w+x+1] +
                        gray[(y+1)*w+x-1] + gray[(y+1)*w+x] + gray[(y+1)*w+x+1]) / 9;
    }
  }
  var edges = new Float32Array(w * h);
  var maxEdge = 0;
  for (var y = 1; y < h-1; y++) {
    for (var x = 1; x < w-1; x++) {
      var gx = -blurred[(y-1)*w+x-1] + blurred[(y-1)*w+x+1] - 2*blurred[y*w+x-1] + 2*blurred[y*w+x+1] - blurred[(y+1)*w+x-1] + blurred[(y+1)*w+x+1];
      var gy = -blurred[(y-1)*w+x-1] - 2*blurred[(y-1)*w+x] - blurred[(y-1)*w+x+1] + blurred[(y+1)*w+x-1] + 2*blurred[(y+1)*w+x] + blurred[(y+1)*w+x+1];
      edges[y*w+x] = Math.sqrt(gx*gx + gy*gy);
      if (edges[y*w+x] > maxEdge) maxEdge = edges[y*w+x];
    }
  }
  return { edges: edges, maxEdge: maxEdge };
}

function findQuadCornersPure(data, w, h) {
  var e = detectEdgesPure(data, w, h);
  var edges = e.edges, maxEdge = e.maxEdge;
  var threshold = maxEdge * 0.15;
  var margin = Math.round(Math.min(w, h) * 0.05);
  var searchEndX = w - margin, searchEndY = h - margin;

  // Find edge points along 4 boundaries using line scanning
  var topPts = [], bottomPts = [], leftPts = [], rightPts = [];

  for (var x = margin; x < searchEndX; x += 2) {
    for (var y = margin; y < searchEndY; y++) {
      if (edges[y*w+x] > threshold) { topPts.push({x:x,y:y}); break; }
    }
    for (var y = searchEndY-1; y >= margin; y--) {
      if (edges[y*w+x] > threshold) { bottomPts.push({x:x,y:y}); break; }
    }
  }
  for (var y = margin; y < searchEndY; y += 2) {
    for (var x = margin; x < searchEndX; x++) {
      if (edges[y*w+x] > threshold) { leftPts.push({x:x,y:y}); break; }
    }
    for (var x = searchEndX-1; x >= margin; x--) {
      if (edges[y*w+x] > threshold) { rightPts.push({x:x,y:y}); break; }
    }
  }

  if (topPts.length < 10 || bottomPts.length < 10 || leftPts.length < 10 || rightPts.length < 10) {
    return null;
  }

  // Fit lines to edge points using RANSAC-like averaging
  function fitLine(pts, axis) {
    var weights = new Array(pts.length);
    for (var iter = 0; iter < 3; iter++) {
      var sumW = 0, sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
      for (var i = 0; i < pts.length; i++) {
        var wgt = weights[i] !== undefined ? weights[i] : 1;
        sumW += wgt; sumX += pts[i].x * wgt; sumY += pts[i].y * wgt;
        sumXX += pts[i].x * pts[i].x * wgt; sumXY += pts[i].x * pts[i].y * wgt;
      }
      var slope = (sumW * sumXY - sumX * sumY) / (sumW * sumXX - sumX * sumX);
      var intercept = (sumY - slope * sumX) / sumW;
      // Recalculate weights
      var medianDist = 0;
      var dists = [];
      for (var i = 0; i < pts.length; i++) {
        var pred = axis === 'x' ? slope * pts[i].x + intercept : slope * pts[i].x + intercept;
        var dist = Math.abs(axis === 'x' ? (pts[i].y - pred) : (pts[i].y - pred));
        dists.push(dist);
      }
      dists.sort(function(a,b) { return a-b; });
      medianDist = dists[Math.floor(dists.length/2)] || 1;
      for (var i = 0; i < pts.length; i++) {
        var pred = axis === 'x' ? slope * pts[i].x + intercept : slope * pts[i].x + intercept;
        var dist = Math.abs(axis === 'x' ? (pts[i].y - pred) : (pts[i].y - pred));
        weights[i] = dist < medianDist * 3 ? 1 : 0;
      }
    }
    return { slope: slope, intercept: intercept };
  }

  // For horizontal lines (top/bottom): y = slope * x + intercept
  // For vertical lines (left/right): x = slope * y + intercept
  var topLine = fitLine(topPts, 'x');
  var bottomLine = fitLine(bottomPts, 'x');
  // For vertical lines, swap x and y
  var leftLineData = leftPts.map(function(p) { return {x: p.y, y: p.x}; });
  var rightLineData = rightPts.map(function(p) { return {x: p.y, y: p.x}; });
  var leftLine = fitLine(leftLineData, 'x');
  var rightLine = fitLine(rightLineData, 'x');

  // Intersection of lines to find 4 corners
  function intersect(line1, line2, axis) {
    // line1: y = m1*x + b1 (x-axis)
    // line2: x = m2*y + b2 (y-axis) - stored as y = m2'*x + b2' after swap
    // For horizontal line (m1, b1) and vertical line (m2_swapped, b2_swapped)
    // m2_swapped is slope when treating y as x, so original: x = m2_swapped * y + b2_swapped
    // y = (x - b2_swapped) / m2_swapped
    // at intersection: m1*x + b1 = (x - b2_swapped) / m2_swapped
    // m1*m2_swapped*x + b1*m2_swapped = x - b2_swapped
    // x - m1*m2_swapped*x = b1*m2_swapped + b2_swapped
    // x * (1 - m1*m2_swapped) = b1*m2_swapped + b2_swapped
    if (axis === 'tl' || axis === 'tr') {
      var m1 = line1.slope, b1 = line1.intercept;
      var m2 = line2.slope, b2 = line2.intercept; // line2 is from swapped data (y as x)
      var denom = 1 - m1 * m2;
      if (Math.abs(denom) < 0.001) denom = 0.001;
      var ix = (b1 * m2 + b2) / denom;
      var iy = m1 * ix + b1;
      return { x: ix, y: iy };
    }
    return { x: 0, y: 0 };
  }

  var tl = intersect(topLine, leftLine, 'tl');
  var tr = intersect(topLine, rightLine, 'tr');
  var bl = intersect(bottomLine, leftLine, 'bl');
  var br = intersect(bottomLine, rightLine, 'br');

  // Validate corners are within image bounds
  function clampCorner(c) {
    return { x: Math.max(0, Math.min(w-1, c.x)), y: Math.max(0, Math.min(h-1, c.y)) };
  }

  var corners = [clampCorner(tl), clampCorner(tr), clampCorner(br), clampCorner(bl)];

  // Check if detected area is reasonable
  var area = Math.abs((corners[1].x - corners[0].x) * (corners[2].y - corners[0].y) -
                      (corners[2].x - corners[0].x) * (corners[1].y - corners[0].y));
  var totalArea = w * h;
  if (area < totalArea * 0.05) return null;

  return corners;
}

// ---------- OpenCV-based detection ----------
function detectCornersOpenCV(canvas) {
  var src = null, gray = null, blurred = null, edges = null;
  var contours = null, hierarchy = null;
  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Adaptive threshold for challenging lighting
    var adaptive = new cv.Mat();
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);

    // Canny edge detection
    cv.Canny(adaptive, edges, 30, 100);

    // Dilate to close gaps
    var kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);

    // Find contours
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Sort by area descending
    var contourList = [];
    for (var i = 0; i < contours.size(); i++) {
      contourList.push({
        index: i,
        area: cv.contourArea(contours.get(i))
      });
    }
    contourList.sort(function(a, b) { return b.area - a.area; });

    var bestCorners = null;
    for (var ci = 0; ci < Math.min(contourList.length, 10); ci++) {
      var cnt = contours.get(contourList[ci].index);
      var peri = cv.arcLength(cnt, true);
      var approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        var c = [];
        for (var j = 0; j < 4; j++) {
          c.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
        // Order corners: TL, TR, BR, BL
        c.sort(function(a, b) { return a.y - b.y; });
        var top = [c[0], c[1]];
        var bottom = [c[2], c[3]];
        top.sort(function(a, b) { return a.x - b.x; });
        bottom.sort(function(a, b) { return a.x - b.x; });
        bestCorners = [top[0], top[1], bottom[1], bottom[0]];

        // Verify area is reasonable
        var w2 = canvas.width, h2 = canvas.height;
        var dx1 = bestCorners[1].x - bestCorners[0].x;
        var dy1 = bestCorners[1].y - bestCorners[0].y;
        var dx2 = bestCorners[2].x - bestCorners[3].x;
        var dy2 = bestCorners[2].y - bestCorners[3].y;
        var cw = Math.max(Math.sqrt(dx1*dx1 + dy1*dy1), Math.sqrt(dx2*dx2 + dy2*dy2));
        var ch = Math.max(Math.abs(bestCorners[2].y - bestCorners[0].y), Math.abs(bestCorners[3].y - bestCorners[1].y));
        if (cw > w2 * 0.1 && ch > h2 * 0.1 && cw < w2 * 1.2 && ch < h2 * 1.2) {
          approx.delete();
          break;
        }
        bestCorners = null;
      }
      approx.delete();
    }

    kernel.delete();
    adaptive.delete();
    return bestCorners;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// ---------- Main detection entry point ----------
function detectCorners(canvas, callback) {
  var w = canvas.width, h = canvas.height;
  if (w < 10 || h < 10) { callback(null); return; }

  loadOpenCV(function(err) {
    if (err || !ocvReady || !cv.Mat) {
      // Fallback: pure JS detection
      var ctx = canvas.getContext('2d');
      var imageData = ctx.getImageData(0, 0, w, h);
      var corners = findQuadCornersPure(imageData.data, w, h);
      callback(corners);
    } else {
      try {
        var corners = detectCornersOpenCV(canvas);
        callback(corners);
      } catch(e) {
        // Fallback
        var ctx = canvas.getContext('2d');
        var imageData = ctx.getImageData(0, 0, w, h);
        var corners = findQuadCornersPure(imageData.data, w, h);
        callback(corners);
      }
    }
  });
}

// ---------- Perspective transformation (pure JS) ----------
function applyPerspective(srcData, srcW, srcH, corners, dstW, dstH) {
  var dst = new Uint8ClampedArray(dstW * dstH * 4);
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];

  // Destination corners
  var dstCorners = [
    {x: 0, y: 0},
    {x: dstW - 1, y: 0},
    {x: dstW - 1, y: dstH - 1},
    {x: 0, y: dstH - 1}
  ];

  // Calculate perspective transform matrix
  // Using direct mapping (simplified - for production, use proper homography)
  // For each output pixel, find corresponding input pixel using bilinear interpolation
  for (var dy = 0; dy < dstH; dy++) {
    for (var dx = 0; dx < dstW; dx++) {
      // Normalize position in output
      var u = dx / (dstW - 1);
      var v = dy / (dstH - 1);

      // Bilinear interpolation between corners
      var topX = tl.x + (tr.x - tl.x) * u;
      var topY = tl.y + (tr.y - tl.y) * u;
      var botX = bl.x + (br.x - bl.x) * u;
      var botY = bl.y + (br.y - bl.y) * u;

      var sx = topX + (botX - topX) * v;
      var sy = topY + (botY - topY) * v;

      // Bilinear sampling from source
      var ix = Math.floor(sx), iy = Math.floor(sy);
      var fx = sx - ix, fy = sy - iy;

      ix = Math.max(0, Math.min(srcW - 2, ix));
      iy = Math.max(0, Math.min(srcH - 2, iy));

      var idx00 = (iy * srcW + ix) * 4;
      var idx10 = (iy * srcW + ix + 1) * 4;
      var idx01 = ((iy + 1) * srcW + ix) * 4;
      var idx11 = ((iy + 1) * srcW + ix + 1) * 4;

      for (var c = 0; c < 4; c++) {
        var v00 = srcData[idx00 + c];
        var v10 = srcData[idx10 + c];
        var v01 = srcData[idx01 + c];
        var v11 = srcData[idx11 + c];
        dst[(dy * dstW + dx) * 4 + c] =
          v00 * (1-fx) * (1-fy) + v10 * fx * (1-fy) +
          v01 * (1-fx) * fy + v11 * fx * fy;
      }
    }
  }
  return dst;
}

// ---------- Enhancement filters (applied to canvas) ----------
function applyFilter(ctx, w, h, mode) {
  var imageData = ctx.getImageData(0, 0, w, h);
  var d = imageData.data;
  var len = w * h * 4;

  switch (mode) {
    case 'original':
      // No change
      break;

    case 'color':
      // Auto contrast stretch + slight saturation boost
      var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (var i = 0; i < len; i += 4) {
        if (d[i] < rMin) rMin = d[i]; if (d[i] > rMax) rMax = d[i];
        if (d[i+1] < gMin) gMin = d[i+1]; if (d[i+1] > gMax) gMax = d[i+1];
        if (d[i+2] < bMin) bMin = d[i+2]; if (d[i+2] > bMax) bMax = d[i+2];
      }
      var rRange = rMax - rMin || 1, gRange = gMax - gMin || 1, bRange = bMax - bMin || 1;
      for (var i = 0; i < len; i += 4) {
        d[i] = Math.min(255, Math.max(0, (d[i] - rMin) / rRange * 255));
        d[i+1] = Math.min(255, Math.max(0, (d[i+1] - gMin) / gRange * 255));
        d[i+2] = Math.min(255, Math.max(0, (d[i+2] - bMin) / bRange * 255));
        // Slight saturation boost
        var avg = (d[i] + d[i+1] + d[i+2]) / 3;
        d[i] = Math.min(255, d[i] + (d[i] - avg) * 0.3);
        d[i+1] = Math.min(255, d[i+1] + (d[i+1] - avg) * 0.3);
        d[i+2] = Math.min(255, d[i+2] + (d[i+2] - avg) * 0.3);
      }
      break;

    case 'grayscale':
      for (var i = 0; i < len; i += 4) {
        var g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        d[i] = g; d[i+1] = g; d[i+2] = g;
      }
      break;

    case 'bw':
      // Otsu-like threshold
      var hist = new Int32Array(256);
      for (var i = 0; i < len; i += 4) {
        var g = Math.round(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
        hist[g]++;
      }
      var total = w * h;
      var sumB = 0, wB = 0, maxVar = 0, threshold = 128;
      for (var t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        var wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        var mB = sumB / wB;
        var mF = (total * 128 - sumB) / wF; // simplified
        var varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
      }
      for (var i = 0; i < len; i += 4) {
        var g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        var val = g > threshold ? 255 : 0;
        d[i] = val; d[i+1] = val; d[i+2] = val;
      }
      break;

    case 'magic':
      // Shadow removal + contrast + saturation + sharpening
      // 1. Estimate background (large blur)
      var bg = new Float32Array(w * h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          bg[idx] = d[idx*4] * 0.299 + d[idx*4+1] * 0.587 + d[idx*4+2] * 0.114;
        }
      }
      // Simple box blur for background estimation (kernel size ~10% of image)
      var ks = Math.max(3, Math.round(Math.min(w, h) * 0.05));
      if (ks % 2 === 0) ks++;
      var half = Math.floor(ks / 2);
      var blurred = new Float32Array(w * h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var sum = 0, count = 0;
          for (var ky = -half; ky <= half; ky++) {
            for (var kx = -half; kx <= half; kx++) {
              var px = x + kx, py = y + ky;
              if (px >= 0 && px < w && py >= 0 && py < h) {
                sum += bg[py * w + px]; count++;
              }
            }
          }
          blurred[y*w+x] = sum / count;
        }
      }
      // 2. Apply shadow removal and enhancement
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          var base = blurred[idx];
          // Shadow removal: d = d * (mean / base)
          var globalMean = 128;
          var scale = base > 10 ? globalMean / base : 1;
          for (var c = 0; c < 3; c++) {
            var val = d[idx*4 + c] * scale;
            val = (val - 128) * 1.3 + 128; // contrast
            val = Math.min(255, Math.max(0, val));
            d[idx*4 + c] = Math.round(val);
          }
          // Saturation boost
          var avg = (d[idx*4] + d[idx*4+1] + d[idx*4+2]) / 3;
          d[idx*4] = Math.min(255, Math.max(0, d[idx*4] + (d[idx*4] - avg) * 0.5));
          d[idx*4+1] = Math.min(255, Math.max(0, d[idx*4+1] + (d[idx*4+1] - avg) * 0.5));
          d[idx*4+2] = Math.min(255, Math.max(0, d[idx*4+2] + (d[idx*4+2] - avg) * 0.5));
        }
      }
      break;
  }

  ctx.putImageData(imageData, 0, 0);
}

// ---------- Crop state manager ----------
var currentCrop = null;
var currentCallback = null;
var isIdCopyMode = false;
var selectedFilter = 'original';
var zoomLevel = 1;
var panX = 0, panY = 0;
var isDraggingCorner = false;
var isPanning = false;
var isPinching = false;
var dragCornerIndex = -1;
var dragStartX = 0, dragStartY = 0;
var corners = []; // [{x, y}, ...] TL, TR, BR, BL
var canvasEl = null;
var modalEl = null;
var previewCanvas = null;
var sourceImage = null;
var containerEl = null;
var lastPinchDist = 0;
var snapEnabled = true;

function distance(a, b) {
  return Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Snap corner to nearest strong edge
function snapToEdge(corner, edgeData, w, h, radius) {
  if (!snapEnabled) return corner;
  radius = radius || Math.round(Math.min(w, h) * 0.03);
  var bestDist = radius;
  var bestX = corner.x, bestY = corner.y;

  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      var sx = Math.round(corner.x + dx);
      var sy = Math.round(corner.y + dy);
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      var edgeVal = edgeData[sy * w + sx];
      if (edgeVal > 0) {
        var d = Math.sqrt(dx*dx + dy*dy);
        if (d < bestDist) {
          bestDist = d;
          bestX = sx;
          bestY = sy;
        }
      }
    }
  }
  return { x: bestX, y: bestY };
}

function getEdgeData(canvas) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width, h = canvas.height;
  var imageData = ctx.getImageData(0, 0, w, h);
  var d = imageData.data;
  var gray = new Float32Array(w * h);
  for (var i = 0; i < w * h; i++) {
    gray[i] = d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114;
  }
  var edges = new Float32Array(w * h);
  var maxE = 0;
  for (var y = 1; y < h-1; y++) {
    for (var x = 1; x < w-1; x++) {
      var gx = -gray[(y-1)*w+x-1] + gray[(y-1)*w+x+1] - 2*gray[y*w+x-1] + 2*gray[y*w+x+1] - gray[(y+1)*w+x-1] + gray[(y+1)*w+x+1];
      var gy = -gray[(y-1)*w+x-1] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+x+1] + gray[(y+1)*w+x-1] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+x+1];
      edges[y*w+x] = Math.sqrt(gx*gx + gy*gy);
      if (edges[y*w+x] > maxE) maxE = edges[y*w+x];
    }
  }
  // Normalize
  var threshold = maxE * 0.2;
  for (var i = 0; i < w * h; i++) {
    edges[i] = edges[i] > threshold ? 1 : 0;
  }
  return edges;
}

// ---------- Main render function ----------
function renderCrop() {
  if (!canvasEl || !sourceImage) return;
  var ctx = canvasEl.getContext('2d');
  var w = canvasEl.width, h = canvasEl.height;

  ctx.clearRect(0, 0, w, h);
  ctx.save();

  // Apply zoom and pan
  ctx.translate(panX, panY);
  ctx.scale(zoomLevel, zoomLevel);

  // Draw source image
  ctx.drawImage(sourceImage, 0, 0, w, h);

  // Draw crop overlay (dim outside the quadrilateral)
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();

  ctx.save();
  ctx.clip();
  // Clear area inside quadrilateral (no dimming)
  ctx.restore();

  // Dim outside
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill('evenodd');

  // Draw quadrilateral outline
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2 / zoomLevel;
  ctx.setLineDash([6 / zoomLevel, 4 / zoomLevel]);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw corner handles (circles)
  var hs = Math.max(12, 20 / zoomLevel);
  var colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A'];
  for (var i = 0; i < 4; i++) {
    var cx = corners[i].x, cy = corners[i].y;

    // Outer glow
    ctx.beginPath();
    ctx.arc(cx, cy, hs * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(26, 115, 232, 0.2)';
    ctx.fill();

    // Handle circle
    ctx.beginPath();
    ctx.arc(cx, cy, hs, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = 2.5 / zoomLevel;
    ctx.stroke();

    // Inner dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3 / zoomLevel, 0, Math.PI * 2);
    ctx.fillStyle = colors[i];
    ctx.fill();
  }

  ctx.restore();
}

// ---------- Get canvas coordinates from mouse/touch event ----------
function getCanvasPos(e) {
  var rect = canvasEl.getBoundingClientRect();
  var clientX = e.touches ? e.touches[0].clientX : e.clientX;
  var clientY = e.touches ? e.touches[0].clientY : e.clientY;
  var dpr = canvasEl.width / rect.width;
  var x = (clientX - rect.left) * dpr;
  var y = (clientY - rect.top) * dpr;
  // Account for zoom/pan
  x = (x - panX) / zoomLevel;
  y = (y - panY) / zoomLevel;
  return { x: x, y: y };
}

function getTouchPos(e, index) {
  index = index || 0;
  var rect = canvasEl.getBoundingClientRect();
  var clientX = e.touches[index].clientX;
  var clientY = e.touches[index].clientY;
  var dpr = canvasEl.width / rect.width;
  var x = (clientX - rect.left) * dpr;
  var y = (clientY - rect.top) * dpr;
  x = (x - panX) / zoomLevel;
  y = (y - panY) / zoomLevel;
  return { x: x, y: y };
}

// Find which corner handle is near a point
function getCornerHandle(pos, threshold) {
  threshold = threshold || 25;
  for (var i = 0; i < corners.length; i++) {
    if (distance(pos, corners[i]) < threshold) return i;
  }
  return -1;
}

// Check if point is inside quadrilateral
function isInsideQuad(pos) {
  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }
  var inside = false;
  for (var i = 0, j = 3; i < 4; j = i++) {
    if ((corners[i].y > pos.y) !== (corners[j].y > pos.y) &&
        pos.x < (corners[j].x - corners[i].x) * (pos.y - corners[i].y) / (corners[j].y - corners[i].y) + corners[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------- Show preview ----------
function showPreview() {
  if (!previewCanvas || !canvasEl || corners.length !== 4) return;

  var w = canvasEl.width, h = canvasEl.height;

  // Calculate output dimensions
  var cw = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]));
  var ch = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]));

  if (cw < 10 || ch < 10) return;

  // For ID Copy, use fixed aspect ratio
  if (isIdCopyMode) {
    ch = cw / (86/54);
  }

  var outW = Math.round(cw);
  var outH = Math.round(ch);

  if (isIdCopyMode) {
    outW = 1016;
    outH = 638;
  }

  // Limit preview resolution for performance
  var previewW = outW, previewH = outH;
  var maxPreviewPx = 1500000; // ~1.5MP max for preview
  if (previewW * previewH > maxPreviewPx) {
    var scale = Math.sqrt(maxPreviewPx / (previewW * previewH));
    previewW = Math.round(previewW * scale);
    previewH = Math.round(previewH * scale);
  }

  // Get source image data
  var ctx = canvasEl.getContext('2d');
  var srcData = ctx.getImageData(0, 0, w, h).data;

  // Apply perspective correction (at preview resolution)
  var correctedData = applyPerspective(srcData, w, h, corners, previewW, previewH);

  previewCanvas._fullW = outW;
  previewCanvas._fullH = outH;
  previewCanvas._srcData = srcData;
  previewCanvas._corners = corners.map(function(c) { return {x:c.x, y:c.y}; });

  previewCanvas.width = previewW;
  previewCanvas.height = previewH;
  var pCtx = previewCanvas.getContext('2d');
  pCtx.imageSmoothingQuality = 'high';

  var imageData = pCtx.createImageData(previewW, previewH);
  imageData.data.set(correctedData);
  pCtx.putImageData(imageData, 0, 0);

  // Apply selected filter to preview
  applyFilter(pCtx, previewW, previewH, selectedFilter);

  // Show preview in a modal/overlay
  showPreviewModal();
}

function showPreviewModal() {
  var existing = document.getElementById('ocvPreviewModal');
  if (!existing) {
    var div = document.createElement('div');
    div.id = 'ocvPreviewModal';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    div.innerHTML = '<div id="ocvPreviewContainer" style="max-width:100%;max-height:80vh;overflow:hidden;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.5);"></div>' +
      '<div style="margin-top:16px;display:flex;gap:12px;">' +
      '<button id="ocvPreviewBack" style="padding:10px 24px;background:#6c757d;color:white;border:none;border-radius:6px;font-size:1em;cursor:pointer;">Back</button>' +
      '<button id="ocvPreviewConfirm" style="padding:10px 24px;background:#28a745;color:white;border:none;border-radius:6px;font-size:1em;cursor:pointer;">Confirm Crop</button>' +
      '</div>';
    document.body.appendChild(div);

    document.getElementById('ocvPreviewBack').onclick = function() {
      document.getElementById('ocvPreviewModal').style.display = 'none';
    };
    document.getElementById('ocvPreviewConfirm').onclick = function() {
      document.getElementById('ocvPreviewModal').style.display = 'none';
      commitCropResult();
    };
    existing = div;
  }
  existing.style.display = 'flex';
  var container = document.getElementById('ocvPreviewContainer');
  container.innerHTML = '';
  container.appendChild(previewCanvas);
  previewCanvas.style.cssText = 'max-width:100%;max-height:80vh;display:block;border-radius:4px;';
}

// ---------- Commit crop result ----------
function commitCropResult() {
  if (!currentCallback) return;

  var fullW = previewCanvas._fullW || previewCanvas.width;
  var fullH = previewCanvas._fullH || previewCanvas.height;
  var srcData = previewCanvas._srcData;
  var srcCorners = previewCanvas._corners || corners;
  var w = canvasEl ? canvasEl.width : 0;
  var h = canvasEl ? canvasEl.height : 0;

  // Generate full-resolution output
  var finalCanvas = document.createElement('canvas');
  finalCanvas.width = fullW;
  finalCanvas.height = fullH;
  var fCtx = finalCanvas.getContext('2d');
  fCtx.imageSmoothingQuality = 'high';

  if (srcData && srcCorners.length === 4) {
    var fullData = applyPerspective(srcData, w, h, srcCorners, fullW, fullH);
    var imageData = fCtx.createImageData(fullW, fullH);
    imageData.data.set(fullData);
    fCtx.putImageData(imageData, 0, 0);
  } else {
    fCtx.drawImage(previewCanvas, 0, 0, fullW, fullH);
  }

  // Apply filter at full resolution
  applyFilter(fCtx, fullW, fullH, selectedFilter);

  fCtx.canvas.toBlob(function(blob) {
    if (!blob) return;
    var fileName = sourceImage && sourceImage.src ? (sourceImage.src.split('/').pop() || 'cropped.png') : 'cropped.png';
    if (fileName.startsWith('blob:')) fileName = 'cropped_' + Date.now() + '.png';
    var file = new File([blob], fileName, { type: 'image/png' });
    currentCallback(file, selectedFilter);
    closeModal();
  }, 'image/png', 1);
}

// ---------- Close modal ----------
function closeModal() {
  if (modalEl) {
    modalEl.classList.add('hidden');
    modalEl.style.display = 'none';
  }
  if (previewCanvas) {
    previewCanvas.width = 0;
    previewCanvas.height = 0;
  }
  currentCrop = null;
}

// ---------- Open crop modal ----------
function openModal(image, idCopy, callback) {
  sourceImage = image;
  isIdCopyMode = idCopy || false;
  currentCallback = callback;
  selectedFilter = 'original';
  zoomLevel = 1;
  panX = 0;
  panY = 0;
  corners = [];

  modalEl = document.getElementById('ocvCropModal');
  if (!modalEl) {
    createModalHTML();
    modalEl = document.getElementById('ocvCropModal');
  }

  canvasEl = document.getElementById('ocvCropCanvas');
  containerEl = document.getElementById('ocvCropContainer');
  previewCanvas = document.getElementById('ocvPreviewResult');

  // Size the canvas
  var maxVH = 0.7;
  var maxW = window.innerWidth * 0.9;
  var maxH = window.innerHeight * maxVH;
  var w = image.width, h = image.height;
  if (w > maxW) { h = h * maxW / w; w = maxW; }
  if (h > maxH) { w = w * maxH / h; h = maxH; }
  var dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.round(w * dpr);
  canvasEl.height = Math.round(h * dpr);
  canvasEl.style.width = Math.round(w) + 'px';
  canvasEl.style.height = Math.round(h) + 'px';

  modalEl.classList.remove('hidden');
  modalEl.style.display = 'flex';

  // Show loading indicator
  var loadingEl = document.getElementById('ocvLoading');
  if (loadingEl) loadingEl.style.display = 'block';
  var filterBar = document.getElementById('ocvFilterBar');
  if (filterBar) filterBar.style.display = 'none';

  // Set default corners (slightly inset from edges)
  var ins = 15 * dpr;
  corners = [
    {x: ins, y: ins},
    {x: canvasEl.width - ins, y: ins},
    {x: canvasEl.width - ins, y: canvasEl.height - ins},
    {x: ins, y: canvasEl.height - ins}
  ];

  // Draw initial state
  renderCrop();

  // Auto-detect corners
  detectCorners(canvasEl, function(detected) {
    if (detected && detected.length === 4) {
      corners = detected;
      renderCrop();
    }
    if (loadingEl) loadingEl.style.display = 'none';
    if (filterBar) filterBar.style.display = 'flex';
  });
}

// ---------- Create modal HTML ----------
function createModalHTML() {
  var div = document.createElement('div');
  div.id = 'ocvCropModal';
  div.className = 'hidden';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:100;display:none;align-items:center;justify-content:center;';
  var isId = isIdCopyMode;
  div.innerHTML =
    '<div style="background:#1a1a2e;border-radius:12px;padding:12px;max-width:540px;width:94%;color:white;max-height:98vh;overflow-y:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<h3 style="margin:0;font-size:1em;">' + (isId ? 'ID Copy Crop' : 'Crop Document') + ' <span id="ocvCropInfo" style="font-size:0.8em;font-weight:400;color:#aaa;">' + (isId ? '86×54mm' : '') + '</span></h3>' +
        '<div>' +
          '<span id="ocvLoading" style="display:none;font-size:0.8em;color:#FFD700;margin-right:8px;">Detecting edges...</span>' +
          '<button onclick="OCV_CROP.zoomIn()" class="ocv-btn">+</button>' +
          '<button onclick="OCV_CROP.zoomOut()" class="ocv-btn">−</button>' +
          '<button onclick="OCV_CROP.resetView()" class="ocv-btn">Fit</button>' +
        '</div>' +
      '</div>' +
      '<div id="ocvCropContainer" style="border-radius:8px;overflow:hidden;background:#000;position:relative;touch-action:none;display:flex;justify-content:center;">' +
        '<canvas id="ocvCropCanvas" style="display:block;touch-action:none;"></canvas>' +
      '</div>' +
      '<div id="ocvFilterBar" style="display:none;gap:4px;padding:6px 0;justify-content:center;flex-wrap:wrap;">' +
        '<button class="ocv-filter-btn active" data-filter="original" onclick="OCV_CROP.setFilter(\'original\',this)">Original</button>' +
        '<button class="ocv-filter-btn" data-filter="color" onclick="OCV_CROP.setFilter(\'color\',this)">Color</button>' +
        '<button class="ocv-filter-btn" data-filter="grayscale" onclick="OCV_CROP.setFilter(\'grayscale\',this)">Grayscale</button>' +
        '<button class="ocv-filter-btn" data-filter="bw" onclick="OCV_CROP.setFilter(\'bw\',this)">B&W</button>' +
        '<button class="ocv-filter-btn" data-filter="magic" onclick="OCV_CROP.setFilter(\'magic\',this)">Magic</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;padding:4px 0;">' +
        '<button onclick="OCV_CROP.autoDetect()" class="ocv-btn" style="background:#16213e;flex:1;">Auto Detect</button>' +
        '<button onclick="OCV_CROP.toggleSnap()" id="ocvSnapBtn" class="ocv-btn" style="background:#16213e;">Snap: ON</button>' +
        '<button onclick="OCV_CROP.rotate(-90)" class="ocv-btn" style="background:#16213e;">↺</button>' +
        '<button onclick="OCV_CROP.rotate(90)" class="ocv-btn" style="background:#16213e;">↻</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;padding:4px 0;">' +
        '<button onclick="OCV_CROP.cancel()" class="ocv-btn" style="background:#6c757d;flex:1;">Cancel</button>' +
        '<button onclick="OCV_CROP.showPreview()" class="ocv-btn" style="background:#1a73e8;flex:2;font-weight:700;">Preview & Crop</button>' +
      '</div>' +
      '<div id="ocvCropError" style="color:#dc3545;text-align:center;font-size:0.8em;padding:2px;"></div>' +
    '</div>';
  document.body.appendChild(div);

  // Canvas for preview result (hidden)
  var pCanvas = document.createElement('canvas');
  pCanvas.id = 'ocvPreviewResult';
  pCanvas.style.display = 'none';
  document.body.appendChild(pCanvas);

  // Setup events
  setupEvents();
}

var eventsSetup = false;
function setupEvents() {
  if (eventsSetup) return;
  eventsSetup = true;
  var ce = document.getElementById('ocvCropCanvas');
  if (!ce) return;

  ce.addEventListener('mousedown', onPointerDown);
  ce.addEventListener('mousemove', onPointerMove);
  ce.addEventListener('mouseup', onPointerUp);
  ce.addEventListener('mouseleave', onPointerUp);
  ce.addEventListener('touchstart', onTouchStart, { passive: false });
  ce.addEventListener('touchmove', onTouchMove, { passive: false });
  ce.addEventListener('touchend', onTouchEnd, { passive: false });
  ce.addEventListener('wheel', onWheel, { passive: false });
}

var pointerState = { dragging: false, cornerIdx: -1, moving: false, startX: 0, startY: 0, startCorners: [] };

function onPointerDown(e) {
  if (!canvasEl || corners.length !== 4) return;
  var pos = getCanvasPos(e);
  var idx = getCornerHandle(pos);

  if (idx >= 0) {
    pointerState.dragging = true;
    pointerState.cornerIdx = idx;
    pointerState.startX = pos.x;
    pointerState.startY = pos.y;
    pointerState.startCorners = corners.map(function(c) { return {x:c.x, y:c.y}; });
    return;
  }

  if (isInsideQuad(pos)) {
    pointerState.moving = true;
    pointerState.startX = pos.x;
    pointerState.startY = pos.y;
    pointerState.startCorners = corners.map(function(c) { return {x:c.x, y:c.y}; });
  }
}

function onPointerMove(e) {
  if (!canvasEl || corners.length !== 4) return;
  var pos = getCanvasPos(e);
  var w = canvasEl.width, h = canvasEl.height;

  if (pointerState.dragging) {
    var dx = pos.x - pointerState.startX;
    var dy = pos.y - pointerState.startY;
    var idx = pointerState.cornerIdx;
    corners[idx] = {
      x: clamp(pointerState.startCorners[idx].x + dx, 0, w),
      y: clamp(pointerState.startCorners[idx].y + dy, 0, h)
    };
    renderCrop();
    return;
  }

  if (pointerState.moving) {
    var dx = pos.x - pointerState.startX;
    var dy = pos.y - pointerState.startY;
    for (var i = 0; i < 4; i++) {
      corners[i] = {
        x: clamp(pointerState.startCorners[i].x + dx, 0, w),
        y: clamp(pointerState.startCorners[i].y + dy, 0, h)
      };
    }
    renderCrop();
    return;
  }

  // Update cursor
  var idx2 = getCornerHandle(pos);
  canvasEl.style.cursor = idx2 >= 0 ? 'grab' : (isInsideQuad(pos) ? 'move' : 'default');
}

function onPointerUp(e) {
  if (pointerState.dragging && corners.length === 4 && snapEnabled) {
    var edgeData = getEdgeData(canvasEl);
    var snapped = snapToEdge(corners[pointerState.cornerIdx], edgeData, canvasEl.width, canvasEl.height);
    corners[pointerState.cornerIdx] = snapped;
    renderCrop();
  }
  pointerState.dragging = false;
  pointerState.moving = false;
}

// Touch events with pinch-to-zoom
var touchState = { dragging: false, cornerIdx: -1, moving: false, pinching: false, lastDist: 0, startPanX: 0, startPanY: 0, startZoom: 1, startX: 0, startY: 0, startCorners: [] };

function onTouchStart(e) {
  e.preventDefault();
  if (!canvasEl || corners.length !== 4) return;

  if (e.touches.length === 2) {
    touchState.pinching = true;
    touchState.lastDist = hypot(e.touches[0], e.touches[1]);
    touchState.startPanX = panX;
    touchState.startPanY = panY;
    touchState.startZoom = zoomLevel;
    return;
  }

  if (e.touches.length === 1) {
    var pos = getTouchPos(e);
    var idx = getCornerHandle(pos);

    if (idx >= 0) {
      touchState.dragging = true;
      touchState.cornerIdx = idx;
      touchState.startX = pos.x;
      touchState.startY = pos.y;
      touchState.startCorners = corners.map(function(c) { return {x:c.x, y:c.y}; });
      return;
    }

    if (isInsideQuad(pos)) {
      touchState.moving = true;
      touchState.startX = pos.x;
      touchState.startY = pos.y;
      touchState.startCorners = corners.map(function(c) { return {x:c.x, y:c.y}; });
    }
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (!canvasEl || corners.length !== 4) return;
  var w = canvasEl.width, h = canvasEl.height;

  if (touchState.pinching && e.touches.length === 2) {
    var dist = hypot(e.touches[0], e.touches[1]);
    var scale = dist / touchState.lastDist;
    zoomLevel = clamp(touchState.startZoom * scale, 0.5, 5);

    // Pan toward pinch center
    var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    var cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    var rect = canvasEl.getBoundingClientRect();
    var dpr = canvasEl.width / rect.width;
    panX = cx * dpr - (rect.left * dpr) - (canvasEl.width / 2 * zoomLevel) + (canvasEl.width / 2) * (1 - zoomLevel);

    renderCrop();
    return;
  }

  if (touchState.dragging && e.touches.length === 1) {
    var pos = getTouchPos(e);
    var dx = pos.x - touchState.startX;
    var dy = pos.y - touchState.startY;
    var idx = touchState.cornerIdx;
    corners[idx] = {
      x: clamp(touchState.startCorners[idx].x + dx, 0, w),
      y: clamp(touchState.startCorners[idx].y + dy, 0, h)
    };
    renderCrop();
    return;
  }

  if (touchState.moving && e.touches.length === 1) {
    var pos = getTouchPos(e);
    var dx = pos.x - touchState.startX;
    var dy = pos.y - touchState.startY;
    for (var i = 0; i < 4; i++) {
      corners[i] = {
        x: clamp(touchState.startCorners[i].x + dx, 0, w),
        y: clamp(touchState.startCorners[i].y + dy, 0, h)
      };
    }
    renderCrop();
    return;
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  if (touchState.dragging && corners.length === 4) {
    var edgeData = getEdgeData(canvasEl);
    var snapped = snapToEdge(corners[touchState.cornerIdx], edgeData, canvasEl.width, canvasEl.height);
    corners[touchState.cornerIdx] = snapped;
    renderCrop();
  }
  touchState.dragging = false;
  touchState.moving = false;
  touchState.pinching = false;
}

function onWheel(e) {
  e.preventDefault();
  var delta = e.deltaY > 0 ? -0.1 : 0.1;
  zoomLevel = clamp(zoomLevel + delta, 0.5, 5);

  // Zoom toward mouse position
  var rect = canvasEl.getBoundingClientRect();
  var dpr = canvasEl.width / rect.width;
  var mx = (e.clientX - rect.left) * dpr;
  var my = (e.clientY - rect.top) * dpr;
  panX = mx - (mx - panX) * (zoomLevel / (zoomLevel - delta));

  renderCrop();
}

function hypot(t1, t2) {
  var dx = t1.clientX - t2.clientX;
  var dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

// ---------- Public API ----------
return {
  loadOpenCV: loadOpenCV,

  openModal: function(image, idCopy, callback) {
    openModal(image, idCopy, callback);
  },

  setFilter: function(mode, btn) {
    selectedFilter = mode;
    document.querySelectorAll('.ocv-filter-btn').forEach(function(b) {
      b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');
  },

  autoDetect: function() {
    if (!canvasEl) return;
    var loadingEl = document.getElementById('ocvLoading');
    if (loadingEl) loadingEl.style.display = 'block';
    detectCorners(canvasEl, function(detected) {
      if (detected && detected.length === 4) {
        corners = detected;
        renderCrop();
      }
      if (loadingEl) loadingEl.style.display = 'none';
    });
  },

  toggleSnap: function() {
    snapEnabled = !snapEnabled;
    var btn = document.getElementById('ocvSnapBtn');
    if (btn) btn.textContent = 'Snap: ' + (snapEnabled ? 'ON' : 'OFF');
  },

  rotate: function(deg) {
    if (!canvasEl || corners.length !== 4) return;
    var cx = canvasEl.width / 2, cy = canvasEl.height / 2;
    var rad = deg * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    for (var i = 0; i < 4; i++) {
      var dx = corners[i].x - cx, dy = corners[i].y - cy;
      corners[i] = {
        x: clamp(cx + dx * cos - dy * sin, 0, canvasEl.width),
        y: clamp(cy + dx * sin + dy * cos, 0, canvasEl.height)
      };
    }
    renderCrop();
  },

  showPreview: function() {
    showPreview();
  },

  commitCrop: function() {
    commitCropResult();
  },

  cancel: function() {
    if (currentCallback) currentCallback(null, null);
    closeModal();
  },

  zoomIn: function() {
    zoomLevel = clamp(zoomLevel + 0.2, 0.5, 5);
    renderCrop();
  },

  zoomOut: function() {
    zoomLevel = clamp(zoomLevel - 0.2, 0.5, 5);
    renderCrop();
  },

  resetView: function() {
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    renderCrop();
  },

  // For integration with existing code
  getState: function() {
    return { corners: corners, filter: selectedFilter, zoom: zoomLevel, panX: panX, panY: panY };
  }
};

})();
