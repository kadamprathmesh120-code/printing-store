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

  var rawCorners = [clampCorner(tl), clampCorner(tr), clampCorner(br), clampCorner(bl)];

  // Order corners properly and check convexity
  rawCorners = orderCorners(rawCorners);
  if (!isConvex(rawCorners)) return null;

  // Check if detected area is reasonable
  var area = Math.abs((rawCorners[1].x - rawCorners[0].x) * (rawCorners[2].y - rawCorners[0].y) -
                      (rawCorners[2].x - rawCorners[0].x) * (rawCorners[1].y - rawCorners[0].y));
  var totalArea = w * h;
  if (area < totalArea * 0.03) return null;

  return rawCorners;
}

// ---------- OpenCV-based detection ----------
function detectCornersOpenCV(canvas) {
  var src, gray, blurred, edges, dilated, thresh, kernel, contours, hierarchy;
  var matsToDelete = [];
  function m(v) { if (v) matsToDelete.push(v); return v; }

  try {
    src = m(cv.imread(canvas));
    gray = m(new cv.Mat());
    blurred = m(new cv.Mat());
    edges = m(new cv.Mat());
    dilated = m(new cv.Mat());
    thresh = m(new cv.Mat());

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

    // Strategy 1: Edge-based detection (works for most documents)
    cv.Canny(blurred, edges, 20, 80);
    kernel = m(cv.Mat.ones(3, 3, cv.CV_8U));
    cv.dilate(edges, dilated, kernel);
    cv.dilate(dilated, dilated, kernel);

    contours = m(new cv.MatVector());
    hierarchy = m(new cv.Mat());
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    var result = findBestQuadrilateral(contours, canvas.width, canvas.height);
    if (result) return result;

    // Strategy 2: Region-based detection (low-contrast / solid-background docs)
    cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
    var meanScalar = cv.mean(thresh);
    if (meanScalar && meanScalar[0] > 127) cv.bitwise_not(thresh, thresh);

    contours = m(new cv.MatVector());
    hierarchy = m(new cv.Mat());
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    result = findBestQuadrilateral(contours, canvas.width, canvas.height);
    return result;

  } finally {
    for (var i = 0; i < matsToDelete.length; i++) {
      try { matsToDelete[i].delete(); } catch(e) {}
    }
  }
}

function findBestQuadrilateral(contours, imgW, imgH) {
  var contourList = [];
  for (var i = 0; i < contours.size(); i++) {
    contourList.push({ index: i, area: cv.contourArea(contours.get(i)) });
  }
  contourList.sort(function(a, b) { return b.area - a.area; });

  for (var ci = 0; ci < Math.min(contourList.length, 30); ci++) {
    var cnt = contours.get(contourList[ci].index);
    var area = contourList[ci].area;
    if (area < imgW * imgH * 0.01) continue;

    var peri = cv.arcLength(cnt, true);
    var approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, Math.max(0.015 * peri, 8), true);

    if (approx.rows === 4) {
      var c = [];
      for (var j = 0; j < 4; j++) {
        c.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      }
      c = orderCorners(c);

      if (!isConvex(c)) { approx.delete(); continue; }

      var cw = Math.max(distance(c[0], c[1]), distance(c[3], c[2]));
      var ch = Math.max(distance(c[0], c[3]), distance(c[1], c[2]));
      if (cw > imgW * 0.04 && ch > imgH * 0.04 && cw < imgW * 1.05 && ch < imgH * 1.05) {
        approx.delete();
        return c;
      }
    }
    approx.delete();
  }
  return null;
}

// Order 4 points as TL, TR, BR, BL using centroid angle
function orderCorners(pts) {
  if (pts.length !== 4) return pts;
  var cx = 0, cy = 0;
  for (var i = 0; i < 4; i++) { cx += pts[i].x; cy += pts[i].y; }
  cx /= 4; cy /= 4;

  pts.sort(function(a, b) {
    return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
  });

  var minSum = Infinity, tlIdx = 0;
  for (var i = 0; i < 4; i++) {
    var s = pts[i].x + pts[i].y;
    if (s < minSum) { minSum = s; tlIdx = i; }
  }

  var ordered = [];
  for (var i = 0; i < 4; i++) {
    ordered.push(pts[(tlIdx + i) % 4]);
  }

  // Ensure clockwise order: TL, TR, BR, BL
  var sa = 0;
  for (var i = 0; i < 4; i++) {
    var j = (i + 1) % 4;
    sa += (ordered[i].x * ordered[j].y - ordered[j].x * ordered[i].y);
  }
  if (sa < 0) {
    var temp = ordered[1];
    ordered[1] = ordered[3];
    ordered[3] = temp;
  }
  return ordered;
}

// Check if a polygon is convex
function isConvex(pts) {
  if (pts.length < 3) return false;
  var sign = 0;
  for (var i = 0; i < pts.length; i++) {
    var j = (i + 1) % pts.length;
    var k = (i + 2) % pts.length;
    var cross = (pts[j].x - pts[i].x) * (pts[k].y - pts[j].y) -
                (pts[j].y - pts[i].y) * (pts[k].x - pts[j].x);
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1;
      else if ((cross > 0 ? 1 : -1) !== sign) return false;
    }
  }
  return true;
}

// ---------- Main detection entry point ----------
// Runs on original full-resolution image, returns corners in canvas display space
function detectCorners(callback) {
  if (!sourceImage) { callback(null); return; }
  var iw = sourceImage.width, ih = sourceImage.height;
  if (iw < 10 || ih < 10) { callback(null); return; }

  // Create temp canvas at original image resolution for accurate detection
  var tempCanvas = document.createElement('canvas');
  tempCanvas.width = iw;
  tempCanvas.height = ih;
  var tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(sourceImage, 0, 0);

  loadOpenCV(function(err) {
    var detected = null;
    if (!err && ocvReady && cv.Mat) {
      try {
        detected = detectCornersOpenCV(tempCanvas);
      } catch(e) {}
    }
    if (!detected) {
      var imageData = tempCtx.getImageData(0, 0, iw, ih);
      detected = findQuadCornersPure(imageData.data, iw, ih);
    }
    // Convert detected corners from original image space to canvas display space
    if (detected && detected.length === 4) {
      var canvasCorners = detected.map(function(c) {
        return imageToCanvas(c.x, c.y);
      });
      callback(canvasCorners);
    } else {
      callback(null);
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
      break;

    case 'grayscale':
      for (var i = 0; i < len; i += 4) {
        var g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        d[i] = g; d[i+1] = g; d[i+2] = g;
      }
      break;

    case 'bw': {
      var hist = new Int32Array(256);
      var grayArr = new Uint8Array(w * h);
      for (var i = 0; i < len; i += 4) {
        var g = Math.round(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
        grayArr[i >> 2] = g;
        hist[g]++;
      }
      var total = w * h;
      var sumAll = 0;
      for (var t = 0; t < 256; t++) sumAll += t * hist[t];
      var sumB = 0, wB = 0, maxVar = 0, threshold = 128;
      for (var t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        var wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        var mB = sumB / wB;
        var mF = (sumAll - sumB) / wF;
        var varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
      }
      for (var i = 0; i < len; i += 4) {
        var val = grayArr[i >> 2] > threshold ? 255 : 0;
        d[i] = val; d[i+1] = val; d[i+2] = val;
      }
      break;
    }

    case 'magic': {
      var grayBuf = new Float32Array(w * h);
      for (var i = 0; i < len; i += 4) {
        grayBuf[i >> 2] = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
      }
      // Separable box blur: horizontal pass then vertical pass (O(n*ks) not O(n*ks^2))
      var ks = Math.max(5, Math.round(Math.min(w, h) * 0.08));
      if (ks % 2 === 0) ks++;
      var half = Math.floor(ks / 2);
      var tmpR = new Float32Array(w * h);
      var tmpG = new Float32Array(w * h);
      var tmpB = new Float32Array(w * h);
      var tmpL = new Float32Array(w * h);
      // Horizontal pass
      for (var y = 0; y < h; y++) {
        var sR = 0, sG = 0, sB = 0, sL = 0, cnt = 0;
        for (var x = 0; x < Math.min(half, w); x++) {
          var bi = (y * w + x) * 4;
          sR += d[bi]; sG += d[bi+1]; sB += d[bi+2]; sL += grayBuf[y*w+x]; cnt++;
        }
        for (var x = 0; x < w; x++) {
          var addX = x + half;
          if (addX < w) { var ai = (y * w + addX) * 4; sR += d[ai]; sG += d[ai+1]; sB += d[ai+2]; sL += grayBuf[y*w+addX]; cnt++; }
          var ci = y * w + x;
          tmpR[ci] = sR / cnt; tmpG[ci] = sG / cnt; tmpB[ci] = sB / cnt; tmpL[ci] = sL / cnt;
          var remX = x - half;
          if (remX >= 0) { var ri = (y * w + remX) * 4; sR -= d[ri]; sG -= d[ri+1]; sB -= d[ri+2]; sL -= grayBuf[y*w+remX]; cnt--; }
        }
      }
      // Vertical pass
      var bgR = new Float32Array(w * h);
      var bgG = new Float32Array(w * h);
      var bgB = new Float32Array(w * h);
      var bg = new Float32Array(w * h);
      for (var x = 0; x < w; x++) {
        var sR = 0, sG = 0, sB = 0, sL = 0, cnt = 0;
        for (var y = 0; y < Math.min(half, h); y++) {
          var ci = y * w + x;
          sR += tmpR[ci]; sG += tmpG[ci]; sB += tmpB[ci]; sL += tmpL[ci]; cnt++;
        }
        for (var y = 0; y < h; y++) {
          var addY = y + half;
          if (addY < h) { var ai2 = addY * w + x; sR += tmpR[ai2]; sG += tmpG[ai2]; sB += tmpB[ai2]; sL += tmpL[ai2]; cnt++; }
          var ci2 = y * w + x;
          bgR[ci2] = sR / cnt; bgG[ci2] = sG / cnt; bgB[ci2] = sB / cnt; bg[ci2] = sL / cnt;
          var remY = y - half;
          if (remY >= 0) { var ri2 = remY * w + x; sR -= tmpR[ri2]; sG -= tmpG[ri2]; sB -= tmpB[ri2]; sL -= tmpL[ri2]; cnt--; }
        }
      }
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          var base = bg[idx];
          var target = 230;
          var rScale = bgR[idx] > 15 ? target / bgR[idx] : 1;
          var gScale = bgG[idx] > 15 ? target / bgG[idx] : 1;
          var bScale = bgB[idx] > 15 ? target / bgB[idx] : 1;
          var valR = d[idx*4] * rScale;
          var valG = d[idx*4+1] * gScale;
          var valB = d[idx*4+2] * bScale;
          valR = (valR - 128) * 1.4 + 128;
          valG = (valG - 128) * 1.4 + 128;
          valB = (valB - 128) * 1.4 + 128;
          valR = Math.min(255, Math.max(0, valR));
          valG = Math.min(255, Math.max(0, valG));
          valB = Math.min(255, Math.max(0, valB));
          d[idx*4] = Math.round(valR);
          d[idx*4+1] = Math.round(valG);
          d[idx*4+2] = Math.round(valB);
        }
      }
      // Sharpen (3x3)
      var shR = new Float32Array(w * h);
      var shG = new Float32Array(w * h);
      var shB = new Float32Array(w * h);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var sR2 = 0, sG2 = 0, sB2 = 0;
          for (var ky = -1; ky <= 1; ky++) {
            for (var kx = -1; kx <= 1; kx++) {
              var idx2 = ((y + ky) * w + (x + kx)) * 4;
              sR2 += d[idx2]; sG2 += d[idx2 + 1]; sB2 += d[idx2 + 2];
            }
          }
          shR[y * w + x] = sR2 / 9;
          shG[y * w + x] = sG2 / 9;
          shB[y * w + x] = sB2 / 9;
        }
      }
      var shAmount = 0.6;
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var idx = (y * w + x) * 4;
          d[idx] = Math.min(255, Math.max(0, d[idx] + (d[idx] - shR[y * w + x]) * shAmount));
          d[idx+1] = Math.min(255, Math.max(0, d[idx+1] + (d[idx+1] - shG[y * w + x]) * shAmount));
          d[idx+2] = Math.min(255, Math.max(0, d[idx+2] + (d[idx+2] - shB[y * w + x]) * shAmount));
        }
      }
      break;
    }

    case 'enhance': {
      var blurKs = Math.max(3, Math.round(Math.min(w, h) * 0.015));
      if (blurKs % 2 === 0) blurKs++;
      var blurHalf = Math.floor(blurKs / 2);
      var blurR = new Float32Array(w * h);
      var blurG = new Float32Array(w * h);
      var blurB = new Float32Array(w * h);
      var tmpR2 = new Float32Array(w * h);
      var tmpG2 = new Float32Array(w * h);
      var tmpB2 = new Float32Array(w * h);
      for (var y = 0; y < h; y++) {
        var sR = 0, sG = 0, sB = 0, cnt = 0;
        for (var x = 0; x < Math.min(blurHalf, w); x++) {
          var bi = (y * w + x) * 4;
          sR += d[bi]; sG += d[bi+1]; sB += d[bi+2]; cnt++;
        }
        for (var x = 0; x < w; x++) {
          var addX = x + blurHalf;
          if (addX < w) { var ai = (y * w + addX) * 4; sR += d[ai]; sG += d[ai+1]; sB += d[ai+2]; cnt++; }
          tmpR2[y*w+x] = sR / cnt; tmpG2[y*w+x] = sG / cnt; tmpB2[y*w+x] = sB / cnt;
          var remX = x - blurHalf;
          if (remX >= 0) { var ri = (y * w + remX) * 4; sR -= d[ri]; sG -= d[ri+1]; sB -= d[ri+2]; cnt--; }
        }
      }
      for (var x = 0; x < w; x++) {
        var sR = 0, sG = 0, sB = 0, cnt = 0;
        for (var y = 0; y < Math.min(blurHalf, h); y++) {
          sR += tmpR2[y*w+x]; sG += tmpG2[y*w+x]; sB += tmpB2[y*w+x]; cnt++;
        }
        for (var y = 0; y < h; y++) {
          var addY = y + blurHalf;
          if (addY < h) { sR += tmpR2[addY*w+x]; sG += tmpG2[addY*w+x]; sB += tmpB2[addY*w+x]; cnt++; }
          blurR[y*w+x] = sR / cnt; blurG[y*w+x] = sG / cnt; blurB[y*w+x] = sB / cnt;
          var remY = y - blurHalf;
          if (remY >= 0) { sR -= tmpR2[remY*w+x]; sG -= tmpG2[remY*w+x]; sB -= tmpB2[remY*w+x]; cnt--; }
        }
      }
      var amount = 1.2;
      var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = (y * w + x) * 4;
          var nR = Math.min(255, Math.max(0, d[idx] + (d[idx] - blurR[y * w + x]) * amount));
          var nG = Math.min(255, Math.max(0, d[idx+1] + (d[idx+1] - blurG[y * w + x]) * amount));
          var nB = Math.min(255, Math.max(0, d[idx+2] + (d[idx+2] - blurB[y * w + x]) * amount));
          d[idx] = nR; d[idx+1] = nG; d[idx+2] = nB;
          if (nR < rMin) rMin = nR; if (nR > rMax) rMax = nR;
          if (nG < gMin) gMin = nG; if (nG > gMax) gMax = nG;
          if (nB < bMin) bMin = nB; if (nB > bMax) bMax = nB;
        }
      }
      var rRange = (rMax - rMin) || 1;
      var gRange = (gMax - gMin) || 1;
      var bRange = (bMax - bMin) || 1;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = (y * w + x) * 4;
          d[idx] = Math.min(255, Math.max(0, (d[idx] - rMin) / rRange * 255));
          d[idx+1] = Math.min(255, Math.max(0, (d[idx+1] - gMin) / gRange * 255));
          d[idx+2] = Math.min(255, Math.max(0, (d[idx+2] - bMin) / bRange * 255));
        }
      }
      break;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ---------- Crop state manager ----------
var currentCrop = null;
var currentCallback = null;
var isIdCopyMode = false;
var selectedFilter = 'original';
var filteredCanvas = null; // cached filtered image
var filteredFilter = null; // which filter is cached
var _originalFileRef = null;
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

// Display parameters for object-fit:contain rendering
var displayScale = 1;
var displayOffsetX = 0;
var displayOffsetY = 0;
var displayW = 0;
var displayH = 0;

function distance(a, b) {
  return Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Compute display parameters for object-fit:contain
function computeDisplayParams() {
  var cw = canvasEl.width, ch = canvasEl.height;
  var iw = sourceImage.width, ih = sourceImage.height;
  var scaleX = cw / iw, scaleY = ch / ih;
  displayScale = Math.min(scaleX, scaleY);
  displayW = iw * displayScale;
  displayH = ih * displayScale;
  displayOffsetX = (cw - displayW) / 2;
  displayOffsetY = (ch - displayH) / 2;
}

// Convert original image coordinates to canvas display space
function imageToCanvas(ox, oy) {
  return { x: displayOffsetX + ox * displayScale, y: displayOffsetY + oy * displayScale };
}

// Convert canvas display coordinates to original image space
function canvasToImage(cx, cy) {
  return { x: (cx - displayOffsetX) / displayScale, y: (cy - displayOffsetY) / displayScale };
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

// ---------- Build filtered image cache ----------
function getFilteredImage() {
  if (!sourceImage) return null;
  if (filteredFilter === selectedFilter && filteredCanvas) return filteredCanvas;

  if (selectedFilter === 'original') {
    filteredCanvas = null;
    filteredFilter = 'original';
    return null;
  }

  var c = document.createElement('canvas');
  c.width = sourceImage.width;
  c.height = sourceImage.height;
  var ctx = c.getContext('2d');
  ctx.drawImage(sourceImage, 0, 0);
  applyFilter(ctx, c.width, c.height, selectedFilter);
  filteredCanvas = c;
  filteredFilter = selectedFilter;
  return c;
}

// ---------- Main render function ----------
function renderCrop() {
  if (!canvasEl || !sourceImage) return;
  var ctx = canvasEl.getContext('2d');
  var cw = canvasEl.width, ch = canvasEl.height;

  ctx.clearRect(0, 0, cw, ch);
  ctx.save();

  computeDisplayParams();
  ctx.translate(panX, panY);
  ctx.scale(zoomLevel, zoomLevel);

  var drawImg = getFilteredImage() || sourceImage;
  ctx.drawImage(drawImg, displayOffsetX, displayOffsetY, displayW, displayH);

  // Dim outside
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill('evenodd');

  // Green crop border
  ctx.strokeStyle = '#16A34A';
  ctx.lineWidth = 2.5 / zoomLevel;
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.stroke();

  // 8 handles: 4 corners + 4 midpoints
  var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  var cornerR = Math.max(isTouch ? 16 : 10, 18 / zoomLevel);
  var midR = Math.max(isTouch ? 10 : 7, 12 / zoomLevel);

  // Corner handles (large white circles with green border)
  for (var i = 0; i < 4; i++) {
    var hx = corners[i].x, hy = corners[i].y;
    ctx.beginPath();
    ctx.arc(hx, hy, cornerR, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = '#16A34A';
    ctx.lineWidth = 2.5 / zoomLevel;
    ctx.stroke();
  }

  // Midpoint handles (smaller white circles with green border)
  for (var i = 0; i < 4; i++) {
    var j = (i + 1) % 4;
    var mx = (corners[i].x + corners[j].x) / 2;
    var my = (corners[i].y + corners[j].y) / 2;
    ctx.beginPath();
    ctx.arc(mx, my, midR, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    ctx.strokeStyle = '#16A34A';
    ctx.lineWidth = 2 / zoomLevel;
    ctx.stroke();
  }

  ctx.restore();
}

// Get midpoint positions from corners
function getMidpoints() {
  var mids = [];
  for (var i = 0; i < 4; i++) {
    var j = (i + 1) % 4;
    mids.push({ x: (corners[i].x + corners[j].x) / 2, y: (corners[i].y + corners[j].y) / 2 });
  }
  return mids;
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

// Find which handle is near a point — returns {type:'corner'|'mid', index:number} or null
function getHandleAt(pos) {
  var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  var threshold = isTouch ? 40 : 28;

  // Check corners first
  for (var i = 0; i < corners.length; i++) {
    if (distance(pos, corners[i]) < threshold) return { type: 'corner', index: i };
  }

  // Check midpoints
  var mids = getMidpoints();
  for (var i = 0; i < mids.length; i++) {
    if (distance(pos, mids[i]) < threshold) return { type: 'mid', index: i };
  }

  return null;
}

// Legacy wrapper for backward compat
function getCornerHandle(pos, threshold) {
  var h = getHandleAt(pos);
  return h && h.type === 'corner' ? h.index : -1;
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
// Uses original full-resolution image data for highest quality
function showPreview() {
  if (!previewCanvas || !sourceImage || corners.length !== 4) return;

  var imgW = sourceImage.width, imgH = sourceImage.height;

  // Convert canvas-space corners to original image space
  var origCorners = corners.map(function(c) {
    return canvasToImage(c.x, c.y);
  });

  // Calculate output dimensions in original image space
  var cw = Math.max(distance(origCorners[0], origCorners[1]), distance(origCorners[3], origCorners[2]));
  var ch = Math.max(distance(origCorners[0], origCorners[3]), distance(origCorners[1], origCorners[2]));
  if (cw < 10 || ch < 10) return;

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
  var maxPreviewPx = 1500000;
  if (previewW * previewH > maxPreviewPx) {
    var scale = Math.sqrt(maxPreviewPx / (previewW * previewH));
    previewW = Math.round(previewW * scale);
    previewH = Math.round(previewH * scale);
  }

  // Get ORIGINAL image pixel data
  var tempCanvas = document.createElement('canvas');
  tempCanvas.width = imgW;
  tempCanvas.height = imgH;
  var tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(sourceImage, 0, 0);
  var srcData = tempCtx.getImageData(0, 0, imgW, imgH).data;

  // Apply perspective correction using original data and original-space corners
  var correctedData = applyPerspective(srcData, imgW, imgH, origCorners, previewW, previewH);

  // Store full-resolution info for commit
  previewCanvas._fullW = outW;
  previewCanvas._fullH = outH;
  previewCanvas._srcData = srcData;
  previewCanvas._imgW = imgW;
  previewCanvas._imgH = imgH;
  previewCanvas._origCorners = origCorners;
  if (!previewCanvas._savedCorners) {
    previewCanvas._savedCorners = origCorners.map(function(c) { return {x: c.x, y: c.y}; });
    previewCanvas._originalFile = _originalFileRef;
  }

  previewCanvas.width = previewW;
  previewCanvas.height = previewH;
  var pCtx = previewCanvas.getContext('2d');
  pCtx.imageSmoothingQuality = 'high';

  var imageData = pCtx.createImageData(previewW, previewH);
  imageData.data.set(correctedData);
  pCtx.putImageData(imageData, 0, 0);

  // Store unfiltered corrected data before applying filter
  previewCanvas._unfilteredData = new Uint8ClampedArray(correctedData);

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
// Exports at original full resolution with no quality loss
function commitCropResult() {
  if (!currentCallback) return;

  var fullW = previewCanvas._fullW || previewCanvas.width;
  var fullH = previewCanvas._fullH || previewCanvas.height;
  var srcData = previewCanvas._srcData;
  var origCorners = previewCanvas._origCorners;
  var imgW = previewCanvas._imgW || (sourceImage ? sourceImage.width : 0);
  var imgH = previewCanvas._imgH || (sourceImage ? sourceImage.height : 0);
  var savedCorners = previewCanvas._savedCorners;

  // Check if corners barely moved and no filter — pass original file through
  var cornersMoved = false;
  if (savedCorners && origCorners && origCorners.length === 4) {
    var thresh = Math.max(imgW, imgH) * 0.02;
    for (var ci = 0; ci < 4; ci++) {
      var dx = Math.abs(origCorners[ci].x - savedCorners[ci].x);
      var dy = Math.abs(origCorners[ci].y - savedCorners[ci].y);
      if (dx > thresh || dy > thresh) { cornersMoved = true; break; }
    }
  } else {
    cornersMoved = true;
  }

  if (!cornersMoved && selectedFilter === 'original' && previewCanvas._originalFile) {
    currentCallback(previewCanvas._originalFile, 'original');
    closeModal();
    return;
  }

  // Generate full-resolution output
  var finalCanvas = document.createElement('canvas');
  finalCanvas.width = fullW;
  finalCanvas.height = fullH;
  var fCtx = finalCanvas.getContext('2d');
  fCtx.imageSmoothingQuality = 'high';
  fCtx.imageSmoothingEnabled = true;

  if (origCorners && origCorners.length === 4 && imgW > 0 && imgH > 0) {
    var srcPixels = srcData;
    if (!srcPixels || srcPixels.length === 0) {
      var tc = document.createElement('canvas');
      tc.width = imgW;
      tc.height = imgH;
      var tctx = tc.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(sourceImage, 0, 0);
      srcPixels = tctx.getImageData(0, 0, imgW, imgH).data;
    }
    var fullData = applyPerspective(srcPixels, imgW, imgH, origCorners, fullW, fullH);
    var imageData = fCtx.createImageData(fullW, fullH);
    imageData.data.set(fullData);
    fCtx.putImageData(imageData, 0, 0);
  } else if (sourceImage) {
    fCtx.imageSmoothingEnabled = true;
    fCtx.drawImage(sourceImage, 0, 0, fullW, fullH);
  }

  // Apply filter at full resolution
  applyFilter(fCtx, fullW, fullH, selectedFilter);

  // Always export as PNG for maximum print quality
  fCtx.canvas.toBlob(function(blob) {
    if (!blob) return;
    var fileName = sourceImage && sourceImage.src ? (sourceImage.src.split('/').pop() || 'cropped.png') : 'cropped.png';
    if (fileName.startsWith('blob:')) fileName = 'cropped_' + Date.now() + '.png';
    fileName = fileName.replace(/\.[^.]+$/, '.png');
    var file = new File([blob], fileName, { type: 'image/png' });
    currentCallback(file, selectedFilter);
    closeModal();
  }, 'image/png');
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
function openModal(image, idCopy, callback, originalFile) {
  sourceImage = image;
  isIdCopyMode = idCopy || false;
  currentCallback = callback;
  _originalFileRef = originalFile || null;
  selectedFilter = isIdCopyMode ? 'magic' : 'original';
  filteredCanvas = null;
  filteredFilter = null;
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
  previewCanvas._savedCorners = null;
  previewCanvas._originalFile = null;

  // Size the canvas to fit within the modal card
  var cardWidth = Math.min(540, window.innerWidth * 0.94);
  var availW = cardWidth - 28; // 12px padding * 2 + 4px margin
  var availH = window.innerHeight * 0.7;
  var maxW = Math.min(availW, 500);
  var maxH = Math.min(availH, window.innerHeight * 0.65);
  var iw = image.width, ih = image.height;
  var dispW = iw, dispH = ih;
  if (dispW > maxW) { dispH = dispH * maxW / dispW; dispW = maxW; }
  if (dispH > maxH) { dispW = dispW * maxH / dispH; dispH = maxH; }
  var dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.round(dispW * dpr);
  canvasEl.height = Math.round(dispH * dpr);
  canvasEl.style.width = Math.round(dispW) + 'px';
  canvasEl.style.height = Math.round(dispH) + 'px';

  // Ensure container centers the canvas
  containerEl.style.display = 'flex';
  containerEl.style.alignItems = 'center';
  containerEl.style.justifyContent = 'center';
  containerEl.style.width = (availW) + 'px';
  containerEl.style.height = Math.round(dispH) + 'px';

  // Compute display parameters for object-fit:contain
  computeDisplayParams();

  // Set default corners to cover entire image
  var origInset = 0;
  corners = [
    imageToCanvas(origInset, origInset),
    imageToCanvas(iw - origInset, origInset),
    imageToCanvas(iw - origInset, ih - origInset),
    imageToCanvas(origInset, ih - origInset)
  ];

  modalEl.classList.remove('hidden');
  modalEl.style.display = 'flex';

  renderCrop();

  var filterBar = document.getElementById('ocvFilterBar');
  if (filterBar) filterBar.style.display = 'flex';

  var filterBtns = document.querySelectorAll('.ocv-filter-btn');
  filterBtns.forEach(function(b) {
    b.classList.remove('active');
    if (b.getAttribute('data-filter') === selectedFilter) b.classList.add('active');
  });

  // Auto-detect edges on open
  setTimeout(function() {
    renderFilterThumbnails();
    OCV_CROP.autoDetect();
  }, 300);
}

// ---------- Create modal HTML ----------
function createModalHTML() {
  var div = document.createElement('div');
  div.id = 'ocvCropModal';
  div.className = 'hidden';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:100;display:none;align-items:center;justify-content:center;overscroll-behavior:none;';
  var isId = isIdCopyMode;
  div.innerHTML =
    '<div style="background:#1a1a2e;border-radius:16px;padding:10px;max-width:540px;width:96%;color:white;max-height:98vh;overflow-y:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding:0 4px;">' +
        '<span id="ocvLoading" style="display:none;font-size:0.75em;color:#FFD700;">Detecting...</span>' +
        '<div style="display:flex;gap:4px;">' +
          '<button onclick="OCV_CROP.rotate(-90)" class="ocv-btn" style="background:#2a2a3e;padding:8px 12px;">↺ Left</button>' +
          '<button onclick="OCV_CROP.rotate(90)" class="ocv-btn" style="background:#2a2a3e;padding:8px 12px;">↻ Right</button>' +
          '<button onclick="OCV_CROP.autoDetect()" class="ocv-btn" style="background:#2a2a3e;padding:8px 12px;">Auto</button>' +
        '</div>' +
      '</div>' +
      '<div id="ocvCropContainer" style="border-radius:8px;overflow:hidden;background:#000;position:relative;touch-action:none;display:flex;justify-content:center;min-height:200px;">' +
        '<canvas id="ocvCropCanvas" style="display:block;touch-action:none;"></canvas>' +
      '</div>' +
      '<div id="ocvFilterBar" class="ocv-filter-bar"></div>' +
      '<div style="display:flex;gap:8px;padding:8px 4px 4px;">' +
        '<button onclick="OCV_CROP.cancel()" class="ocv-btn ocv-cancel" style="flex:0.5;">Cancel</button>' +
        '<button onclick="OCV_CROP.cropDirect()" class="ocv-btn ocv-crop-btn" style="flex:1;background:#16A34A;">Done ✓</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(div);

  var pCanvas = document.createElement('canvas');
  pCanvas.id = 'ocvPreviewResult';
  pCanvas.style.display = 'none';
  document.body.appendChild(pCanvas);

  setupEvents();
  buildFilterThumbnails();
}

// ---------- Build filter thumbnails (CamScanner style) ----------
var FILTER_DEFS = [
  { id: 'original', label: 'Original' },
  { id: 'magic', label: 'Magic Color' },
  { id: 'grayscale', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
  { id: 'enhance', label: 'Enhance' }
];

function buildFilterThumbnails() {
  var bar = document.getElementById('ocvFilterBar');
  if (!bar) return;
  bar.innerHTML = '';

  var thumbW = 56, thumbH = 72;
  FILTER_DEFS.forEach(function(f) {
    var wrap = document.createElement('div');
    wrap.className = 'ocv-filter-thumb';
    wrap.setAttribute('data-filter', f.id);
    wrap.onclick = function() { OCV_CROP.setFilter(f.id); };

    var cvs = document.createElement('canvas');
    cvs.width = thumbW;
    cvs.height = thumbH;
    cvs.style.cssText = 'width:' + thumbW + 'px;height:' + thumbH + 'px;border-radius:6px;display:block;';

    var label = document.createElement('div');
    label.className = 'ocv-filter-label';
    label.textContent = f.label;

    wrap.appendChild(cvs);
    wrap.appendChild(label);
    bar.appendChild(wrap);
  });
}

function renderFilterThumbnails() {
  if (!sourceImage) return;
  var thumbW = 56, thumbH = 72;
  var thumbs = document.querySelectorAll('.ocv-filter-thumb canvas');
  thumbs.forEach(function(cvs) {
    var fId = cvs.parentElement.getAttribute('data-filter');
    var ctx = cvs.getContext('2d');
    var iw = sourceImage.width, ih = sourceImage.height;
    var scale = Math.min(thumbW / iw, thumbH / ih);
    var dw = iw * scale, dh = ih * scale;
    var dx = (thumbW - dw) / 2, dy = (thumbH - dh) / 2;
    ctx.clearRect(0, 0, thumbW, thumbH);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, thumbW, thumbH);
    ctx.drawImage(sourceImage, dx, dy, dw, dh);
    if (fId !== 'original') {
      applyFilter(ctx, thumbW, thumbH, fId);
    }
  });
  updateFilterSelection();
}

function updateFilterSelection() {
  var thumbs = document.querySelectorAll('.ocv-filter-thumb');
  thumbs.forEach(function(el) {
    if (el.getAttribute('data-filter') === selectedFilter) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
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

var pointerState = { dragging: false, handleType: '', handleIdx: -1, moving: false, startX: 0, startY: 0, startCorners: [] };

function onPointerDown(e) {
  if (!canvasEl || corners.length !== 4) return;
  var pos = getCanvasPos(e);
  var handle = getHandleAt(pos);

  if (handle) {
    pointerState.dragging = true;
    pointerState.handleType = handle.type;
    pointerState.handleIdx = handle.index;
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

    if (pointerState.handleType === 'corner') {
      var idx = pointerState.handleIdx;
      corners[idx] = {
        x: clamp(pointerState.startCorners[idx].x + dx, 0, w),
        y: clamp(pointerState.startCorners[idx].y + dy, 0, h)
      };
    } else if (pointerState.handleType === 'mid') {
      var mi = pointerState.handleIdx;
      var ci = mi;
      var cj = (mi + 1) % 4;
      corners[ci] = {
        x: clamp(pointerState.startCorners[ci].x + dx, 0, w),
        y: clamp(pointerState.startCorners[ci].y + dy, 0, h)
      };
      corners[cj] = {
        x: clamp(pointerState.startCorners[cj].x + dx, 0, w),
        y: clamp(pointerState.startCorners[cj].y + dy, 0, h)
      };
    }
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

  var h2 = getHandleAt(pos);
  canvasEl.style.cursor = h2 ? 'grab' : (isInsideQuad(pos) ? 'move' : 'default');
}

function onPointerUp(e) {
  if (pointerState.dragging && corners.length === 4 && snapEnabled) {
    var edgeData = getEdgeData(canvasEl);
    if (pointerState.handleType === 'corner') {
      var snapped = snapToEdge(corners[pointerState.handleIdx], edgeData, canvasEl.width, canvasEl.height);
      corners[pointerState.handleIdx] = snapped;
    } else if (pointerState.handleType === 'mid') {
      var mi = pointerState.handleIdx;
      corners[mi] = snapToEdge(corners[mi], edgeData, canvasEl.width, canvasEl.height);
      corners[(mi + 1) % 4] = snapToEdge(corners[(mi + 1) % 4], edgeData, canvasEl.width, canvasEl.height);
    }
    renderCrop();
  }
  pointerState.dragging = false;
  pointerState.moving = false;
}

// Touch events with pinch-to-zoom
var touchState = { dragging: false, handleType: '', handleIdx: -1, moving: false, pinching: false, lastDist: 0, startPanX: 0, startPanY: 0, startZoom: 1, startX: 0, startY: 0, startCorners: [] };

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
    var handle = getHandleAt(pos);

    if (handle) {
      touchState.dragging = true;
      touchState.handleType = handle.type;
      touchState.handleIdx = handle.index;
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

    if (touchState.handleType === 'corner') {
      var idx = touchState.handleIdx;
      corners[idx] = {
        x: clamp(touchState.startCorners[idx].x + dx, 0, w),
        y: clamp(touchState.startCorners[idx].y + dy, 0, h)
      };
    } else if (touchState.handleType === 'mid') {
      var mi = touchState.handleIdx;
      corners[mi] = {
        x: clamp(touchState.startCorners[mi].x + dx, 0, w),
        y: clamp(touchState.startCorners[mi].y + dy, 0, h)
      };
      corners[(mi + 1) % 4] = {
        x: clamp(touchState.startCorners[(mi + 1) % 4].x + dx, 0, w),
        y: clamp(touchState.startCorners[(mi + 1) % 4].y + dy, 0, h)
      };
    }
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
    if (touchState.handleType === 'corner') {
      var snapped = snapToEdge(corners[touchState.handleIdx], edgeData, canvasEl.width, canvasEl.height);
      corners[touchState.handleIdx] = snapped;
    } else if (touchState.handleType === 'mid') {
      var mi = touchState.handleIdx;
      corners[mi] = snapToEdge(corners[mi], edgeData, canvasEl.width, canvasEl.height);
      corners[(mi + 1) % 4] = snapToEdge(corners[(mi + 1) % 4], edgeData, canvasEl.width, canvasEl.height);
    }
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

// ---------- Direct crop (no preview modal) ----------
function cropDirect() {
  if (!sourceImage || !currentCallback || corners.length !== 4) return;

  var imgW = sourceImage.width, imgH = sourceImage.height;

  // Convert canvas-space corners to original image space
  var origCorners = corners.map(function(c) {
    return canvasToImage(c.x, c.y);
  });

  // Calculate output dimensions in original image space
  var cw = Math.max(distance(origCorners[0], origCorners[1]), distance(origCorners[3], origCorners[2]));
  var ch = Math.max(distance(origCorners[0], origCorners[3]), distance(origCorners[1], origCorners[2]));
  if (cw < 10 || ch < 10) return;

  if (isIdCopyMode) {
    ch = cw / (86/54);
  }
  var outW = Math.round(cw);
  var outH = Math.round(ch);
  if (isIdCopyMode) {
    outW = 1016;
    outH = 638;
  }

  // Get original image pixel data
  var tempCanvas = document.createElement('canvas');
  tempCanvas.width = imgW;
  tempCanvas.height = imgH;
  var tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(sourceImage, 0, 0);
  var srcData = tempCtx.getImageData(0, 0, imgW, imgH).data;

  // Apply perspective correction at full resolution
  var fullData = applyPerspective(srcData, imgW, imgH, origCorners, outW, outH);

  // Create output canvas
  var finalCanvas = document.createElement('canvas');
  finalCanvas.width = outW;
  finalCanvas.height = outH;
  var fCtx = finalCanvas.getContext('2d');
  fCtx.imageSmoothingQuality = 'high';

  var imageData = fCtx.createImageData(outW, outH);
  imageData.data.set(fullData);
  fCtx.putImageData(imageData, 0, 0);

  // Apply selected filter
  applyFilter(fCtx, outW, outH, selectedFilter);

  // Export
  var outType = 'image/png';
  var outQuality2 = undefined;
  var srcName = sourceImage && sourceImage.src ? sourceImage.src.split('/').pop() : 'cropped.png';
  var srcExt = srcName.split('.').pop().toLowerCase();
  if (srcExt === 'jpg' || srcExt === 'jpeg') { outType = 'image/jpeg'; outQuality2 = 0.98; }

  fCtx.canvas.toBlob(function(blob) {
    if (!blob) return;
    var fileName = sourceImage && sourceImage.src ? (sourceImage.src.split('/').pop() || 'cropped.png') : 'cropped.png';
    if (fileName.startsWith('blob:')) fileName = 'cropped_' + Date.now() + '.png';
    var file = new File([blob], fileName, { type: outType });
    currentCallback(file, selectedFilter);
    closeModal();
  }, outType, outQuality2);
}

// ---------- Refresh preview when filter changes ----------
function refreshPreview() {
  if (!previewCanvas || !previewCanvas._unfilteredData) return;
  var previewModal = document.getElementById('ocvPreviewModal');
  if (!previewModal || previewModal.style.display === 'none') return;

  var w = previewCanvas.width, h = previewCanvas.height;
  if (w === 0 || h === 0) return;

  var pCtx = previewCanvas.getContext('2d');

  // Restore unfiltered data
  var imageData = pCtx.createImageData(w, h);
  imageData.data.set(previewCanvas._unfilteredData);
  pCtx.putImageData(imageData, 0, 0);

  // Re-apply current filter
  applyFilter(pCtx, w, h, selectedFilter);
}

// ---------- Public API ----------
return {
  loadOpenCV: loadOpenCV,

  openModal: function(image, idCopy, callback) {
    openModal(image, idCopy, callback);
  },

  setFilter: function(mode) {
    selectedFilter = mode;
    filteredFilter = null; // invalidate cache
    filteredCanvas = null;
    updateFilterSelection();
    renderCrop();
  },

  autoDetect: function() {
    if (!sourceImage) return;
    var loadingEl = document.getElementById('ocvLoading');
    if (loadingEl) loadingEl.style.display = 'block';
    detectCorners(function(detected) {
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

  cropDirect: function() {
    cropDirect();
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
