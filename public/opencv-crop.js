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

// ---------- OpenCV-based Multi-Stage Document Detection Pipeline ----------
// Inspired by Adobe Scan / CamScanner / Microsoft Lens / Google Drive Scanner algorithms

function detectCornersOpenCV(canvas) {
  var origW = canvas.width, origH = canvas.height;
  if (origW < 10 || origH < 10) return null;

  // Downscale image to target working size (max dim 600px) for fast, robust multi-pass analysis
  var scale = Math.min(1.0, 600 / Math.max(origW, origH));
  var procW = Math.round(origW * scale);
  var procH = Math.round(origH * scale);

  var procCanvas = document.createElement('canvas');
  procCanvas.width = procW;
  procCanvas.height = procH;
  var pCtx = procCanvas.getContext('2d');
  pCtx.drawImage(canvas, 0, 0, procW, procH);

  var matsToDelete = [];
  function m(v) { if (v) matsToDelete.push(v); return v; }

  try {
    var src = m(cv.imread(procCanvas));
    var gray = m(new cv.Mat());
    var blurred = m(new cv.Mat());

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Bilateral filter preserves sharp document edges while smoothing paper texture and noise
    try {
      cv.bilateralFilter(gray, blurred, 5, 40, 40);
    } catch(e) {
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    }

    var candidates = [];

    // --- STAGE 0: Paper Sheet Color-Saliency Mask (White/Light Document Sheet) ---
    try {
      var hsv = m(new cv.Mat());
      var rgbMat = m(new cv.Mat());
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgbMat, hsv, cv.COLOR_RGB2HSV);

      var hsvPlanes = m(new cv.MatVector());
      cv.split(hsv, hsvPlanes);
      var satMat = hsvPlanes.get(1);
      var valMat = hsvPlanes.get(2);

      var valThresh = m(new cv.Mat());
      var satThresh = m(new cv.Mat());
      var paperMask = m(new cv.Mat());

      cv.threshold(valMat, valThresh, 115, 255, cv.THRESH_BINARY);
      cv.threshold(satMat, satThresh, 75, 255, cv.THRESH_BINARY_INV);
      cv.bitwise_and(valThresh, satThresh, paperMask);

      var kernel9 = m(cv.Mat.ones(9, 9, cv.CV_8U));
      cv.morphologyEx(paperMask, paperMask, cv.MORPH_CLOSE, kernel9);
      extractContourCandidates(paperMask, candidates, procW, procH);
    } catch(e) {}

    // --- STAGE 1: Multi-Scale Adaptive Canny Edge Detection & Morphological Page Merging ---
    var meanVal = cv.mean(blurred)[0] || 128;
    var cannyConfigs = [
      { low: Math.max(10, meanVal * 0.35), high: Math.min(230, meanVal * 1.1) },
      { low: 25, high: 95 },
      { low: 45, high: 150 }
    ];

    var kernel3 = m(cv.Mat.ones(3, 3, cv.CV_8U));
    var kernel7 = m(cv.Mat.ones(7, 7, cv.CV_8U));
    var kernel11 = m(cv.Mat.ones(11, 11, cv.CV_8U));

    for (var cIdx = 0; cIdx < cannyConfigs.length; cIdx++) {
      var cfg = cannyConfigs[cIdx];
      var edges = m(new cv.Mat());
      var morphed = m(new cv.Mat());

      cv.Canny(blurred, edges, cfg.low, cfg.high);

      // Morphological Closing with larger kernels merges inner table cells/text into full outer page mask
      cv.morphologyEx(edges, morphed, cv.MORPH_CLOSE, kernel7);
      cv.dilate(morphed, morphed, kernel3);

      extractContourCandidates(morphed, candidates, procW, procH);

      // Heavy morphological closing pass specifically to isolate outer document boundary
      var heavyMorphed = m(new cv.Mat());
      cv.morphologyEx(edges, heavyMorphed, cv.MORPH_CLOSE, kernel11);
      extractContourCandidates(heavyMorphed, candidates, procW, procH);
    }

    // --- STAGE 2: Multi-Threshold Binarization (Otsu & Adaptive Gaussian) ---
    var threshOtsu = m(new cv.Mat());
    cv.threshold(blurred, threshOtsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    extractContourCandidates(threshOtsu, candidates, procW, procH);

    var threshInv = m(new cv.Mat());
    cv.bitwise_not(threshOtsu, threshInv);
    extractContourCandidates(threshInv, candidates, procW, procH);

    var threshAdap = m(new cv.Mat());
    cv.adaptiveThreshold(blurred, threshAdap, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 4);
    extractContourCandidates(threshAdap, candidates, procW, procH);

    // --- STAGE 3: Hough Line Intersection Assembly (Handles shadowed/clipped edges) ---
    try {
      var houghEdges = m(new cv.Mat());
      cv.Canny(blurred, houghEdges, 35, 110);
      var houghQuads = extractHoughLineQuads(houghEdges, procW, procH);
      for (var hq = 0; hq < houghQuads.length; hq++) {
        candidates.push(houghQuads[hq]);
      }
    } catch(e) {}

    if (candidates.length === 0) return null;

    // Deduplicate candidates
    candidates = deduplicateCandidates(candidates, procW, procH);

    // --- STAGE 4: Edge Gradient Saliency Map & Multi-Factor Confidence Scoring Engine ---
    var gradX = m(new cv.Mat());
    var gradY = m(new cv.Mat());
    var gradMag = m(new cv.Mat());
    cv.Sobel(gray, gradX, cv.CV_32F, 1, 0, 3);
    cv.Sobel(gray, gradY, cv.CV_32F, 0, 1, 3);
    cv.magnitude(gradX, gradY, gradMag);

    var bestQuad = null;
    var bestScore = -1;

    for (var i = 0; i < candidates.length; i++) {
      var quad = candidates[i];
      var score = scoreCandidateQuad(quad, procW, procH, gradMag, gray, candidates);
      if (score > bestScore) {
        bestScore = score;
        bestQuad = quad;
      }
    }

    // High-confidence match (score >= 0.35)
    if (bestQuad && bestScore >= 0.35) {
      // Upscale corners back to original image space
      return bestQuad.map(function(pt) {
        return {
          x: Math.round(Math.max(0, Math.min(origW, pt.x / scale))),
          y: Math.round(Math.max(0, Math.min(origH, pt.y / scale)))
        };
      });
    }

    return null;

  } finally {
    for (var i = 0; i < matsToDelete.length; i++) {
      try { matsToDelete[i].delete(); } catch(e) {}
    }
  }
}

// Extract quad candidates from contour matrices
function extractContourCandidates(mat, candidateList, imgW, imgH) {
  var contours = new cv.MatVector();
  var hierarchy = new cv.Mat();
  try {
    cv.findContours(mat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var totalArea = imgW * imgH;

    for (var i = 0; i < contours.size(); i++) {
      var cnt = contours.get(i);
      var area = cv.contourArea(cnt);
      if (area < totalArea * 0.04) continue;

      var peri = cv.arcLength(cnt, true);
      var epsilons = [0.01 * peri, 0.02 * peri, 0.035 * peri, 0.05 * peri];

      for (var epIdx = 0; epIdx < epsilons.length; epIdx++) {
        var approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, Math.max(epsilons[epIdx], 5), true);

        var pts = [];
        if (approx.rows === 4) {
          for (var j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
        } else if (approx.rows > 4 && approx.rows <= 16) {
          // Extract 4-extremal bounding quad for rounded/complex corners
          var rawPts = [];
          for (var k = 0; k < approx.rows; k++) {
            rawPts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
          }
          pts = extract4ExtremalCorners(rawPts);
        }
        approx.delete();

        if (pts.length === 4) {
          pts = orderCorners(pts);
          if (isConvex(pts)) {
            candidateList.push(pts);
          }
        }
      }
    }
  } catch(e) {
  } finally {
    try { contours.delete(); } catch(e) {}
    try { hierarchy.delete(); } catch(e) {}
  }
}

// Extract 4 extremal corners from a multi-vertex polygon
function extract4ExtremalCorners(pts) {
  if (pts.length < 4) return [];
  var tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  var minTL = Infinity, maxTR = -Infinity, maxBR = -Infinity, minBL = Infinity;

  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var sumSum = p.x + p.y;
    var sumDiff = p.x - p.y;

    if (sumSum < minTL) { minTL = sumSum; tl = p; }
    if (sumDiff > maxTR) { maxTR = sumDiff; tr = p; }
    if (sumSum > maxBR) { maxBR = sumSum; br = p; }
    if (sumDiff < minBL) { minBL = sumDiff; bl = p; }
  }

  return [tl, tr, br, bl];
}

// Hough Line intersection assembly for partially visible/obscured edges
function extractHoughLineQuads(edgesMat, imgW, imgH) {
  var quads = [];
  var linesMat = new cv.Mat();
  try {
    cv.HoughLinesP(edgesMat, linesMat, 1, Math.PI / 180, 35, Math.min(imgW, imgH) * 0.15, 15);
    if (linesMat.rows < 4) return quads;

    var horizLines = [];
    var vertLines = [];

    for (var i = 0; i < linesMat.rows; i++) {
      var x1 = linesMat.data32S[i * 4];
      var y1 = linesMat.data32S[i * 4 + 1];
      var x2 = linesMat.data32S[i * 4 + 2];
      var y2 = linesMat.data32S[i * 4 + 3];

      var angle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
      if (angle < 35 || angle > 145) {
        horizLines.push({ x1: x1, y1: y1, x2: x2, y2: y2, avgY: (y1 + y2) / 2 });
      } else if (angle > 55 && angle < 125) {
        vertLines.push({ x1: x1, y1: y1, x2: x2, y2: y2, avgX: (x1 + x2) / 2 });
      }
    }

    if (horizLines.length < 2 || vertLines.length < 2) return quads;

    horizLines.sort(function(a, b) { return a.avgY - b.avgY; });
    vertLines.sort(function(a, b) { return a.avgX - b.avgX; });

    var topL = horizLines[0];
    var botL = horizLines[horizLines.length - 1];
    var leftL = vertLines[0];
    var rightL = vertLines[vertLines.length - 1];

    function lineIntersect(l1, l2) {
      var A1 = l1.y2 - l1.y1, B1 = l1.x1 - l1.x2, C1 = A1 * l1.x1 + B1 * l1.y1;
      var A2 = l2.y2 - l2.y1, B2 = l2.x1 - l2.x2, C2 = A2 * l2.x1 + B2 * l2.y1;
      var det = A1 * B2 - A2 * B1;
      if (Math.abs(det) < 1e-5) return null;
      return { x: (B2 * C1 - B1 * C2) / det, y: (A1 * C2 - A2 * C1) / det };
    }

    var pTL = lineIntersect(topL, leftL);
    var pTR = lineIntersect(topL, rightL);
    var pBR = lineIntersect(botL, rightL);
    var pBL = lineIntersect(botL, leftL);

    if (pTL && pTR && pBR && pBL) {
      var quad = orderCorners([pTL, pTR, pBR, pBL]);
      var margin = 20;
      var valid = quad.every(function(pt) {
        return pt.x >= -margin && pt.x <= imgW + margin && pt.y >= -margin && pt.y <= imgH + margin;
      });
      if (valid && isConvex(quad)) quads.push(quad);
    }
  } catch(e) {
  } finally {
    try { linesMat.delete(); } catch(e) {}
  }
  return quads;
}

// Deduplicate nearly identical candidate quads
function deduplicateCandidates(candidates, imgW, imgH) {
  var unique = [];
  var threshold = Math.min(imgW, imgH) * 0.05;

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var isDup = false;
    for (var u = 0; u < unique.length; u++) {
      var prev = unique[u];
      var distSum = distance(c[0], prev[0]) + distance(c[1], prev[1]) +
                    distance(c[2], prev[2]) + distance(c[3], prev[3]);
      if (distSum / 4 < threshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(c);
  }
  return unique;
}

// Multi-Factor Confidence Scoring Engine (prioritizes OUTER paper boundaries)
function scoreCandidateQuad(quad, imgW, imgH, gradMag, grayMat, allCandidates) {
  // Reject camera frame boundaries (if 2 or more points hit the canvas margin within 8px)
  var frameTouchCount = 0;
  for (var ptIdx = 0; ptIdx < 4; ptIdx++) {
    var p = quad[ptIdx];
    if (p.x <= 8 || p.x >= imgW - 8 || p.y <= 8 || p.y >= imgH - 8) {
      frameTouchCount++;
    }
  }
  if (frameTouchCount >= 2) return 0.05;

  // 1. Area Ratio Score (ideal: 25% to 90% of total camera frame area)
  var area = calculateQuadArea(quad);
  var totalArea = imgW * imgH;
  var areaRatio = area / totalArea;

  if (areaRatio < 0.05 || areaRatio > 0.98) return 0;

  var sArea = 1.0;
  if (areaRatio < 0.25) sArea = areaRatio / 0.25;
  else if (areaRatio > 0.90) sArea = (0.98 - areaRatio) / 0.08;

  // 2. Angle Regularity Score (ideal interior angle = 90 deg)
  var angles = [
    calculateAngle(quad[3], quad[0], quad[1]),
    calculateAngle(quad[0], quad[1], quad[2]),
    calculateAngle(quad[1], quad[2], quad[3]),
    calculateAngle(quad[2], quad[3], quad[0])
  ];

  var angleDevSum = 0;
  for (var a = 0; a < 4; a++) {
    var dev = Math.abs(angles[a] - 90);
    if (dev > 50) return 0;
    angleDevSum += dev;
  }
  var sAngle = Math.max(0, 1.0 - (angleDevSum / 4) / 45.0);

  // 3. Parallelism & Edge Symmetry Score
  var topW = distance(quad[0], quad[1]);
  var botW = distance(quad[3], quad[2]);
  var leftH = distance(quad[0], quad[3]);
  var rightH = distance(quad[1], quad[2]);

  var wRatio = Math.min(topW, botW) / Math.max(topW, botW, 1e-5);
  var hRatio = Math.min(leftH, rightH) / Math.max(leftH, rightH, 1e-5);
  var sParallel = (wRatio + hRatio) / 2.0;

  // 4. Aspect Ratio Score (standard documents range from 1.1 to 2.2)
  var meanW = (topW + botW) / 2.0;
  var meanH = (leftH + rightH) / 2.0;
  var aspect = Math.max(meanW / Math.max(meanH, 1e-5), meanH / Math.max(meanW, 1e-5));
  var sAspect = 1.0;
  if (aspect < 1.1) sAspect = aspect / 1.1;
  else if (aspect > 2.5) sAspect = Math.max(0, (4.0 - aspect) / 1.5);

  // 5. Paper-to-Background Luminance Step (Differentiates outer white paper border from inner black table lines)
  var sContrastStep = sampleBorderContrastStep(quad, imgW, imgH, grayMat);

  // 6. Boundary Edge Gradient Score
  var sGradient = sampleEdgeGradient(quad, imgW, imgH, gradMag);

  // 7. Outer Enclosing Quad Preference (boost outer quads that enclose smaller inner candidate quads)
  var sEnclosing = 0;
  if (allCandidates && allCandidates.length > 1) {
    var enclosesCount = 0;
    for (var cIdx = 0; cIdx < allCandidates.length; cIdx++) {
      var other = allCandidates[cIdx];
      var otherArea = calculateQuadArea(other);
      if (otherArea < area * 0.85) {
        // Check if other quad centroid is inside this quad
        var oCx = (other[0].x + other[1].x + other[2].x + other[3].x) / 4;
        var oCy = (other[0].y + other[1].y + other[2].y + other[3].y) / 4;
        if (isPointInsideQuad({ x: oCx, y: oCy }, quad)) {
          enclosesCount++;
        }
      }
    }
    if (enclosesCount > 0) sEnclosing = Math.min(1.0, enclosesCount * 0.25);
  }

  // Composite Weighted Score (Heavy weight on sContrastStep and sEnclosing to lock onto OUTER paper boundary)
  var compositeScore = (0.30 * sContrastStep) + (0.20 * sEnclosing) + (0.20 * sGradient) + (0.15 * sAngle) + (0.10 * sArea) + (0.05 * sParallel);
  return compositeScore;
}

function sampleBorderContrastStep(quad, imgW, imgH, grayMat) {
  if (!grayMat || !grayMat.data) return 0.5;
  var data = grayMat.data;
  var insideSum = 0, outsideSum = 0, count = 0;

  var cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  var cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  for (var side = 0; side < 4; side++) {
    var p1 = quad[side];
    var p2 = quad[(side + 1) % 4];
    var steps = 12;
    for (var k = 1; k < steps; k++) {
      var t = k / steps;
      var mx = p1.x + t * (p2.x - p1.x);
      var my = p1.y + t * (p2.y - p1.y);

      var dx = cx - mx;
      var dy = cy - my;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-3) continue;
      var nx = (dx / dist) * 7; // 7px inset/outset test
      var ny = (dy / dist) * 7;

      var inX = Math.round(mx + nx);
      var inY = Math.round(my + ny);
      var outX = Math.round(mx - nx);
      var outY = Math.round(my - ny);

      if (inX >= 0 && inX < imgW && inY >= 0 && inY < imgH &&
          outX >= 0 && outX < imgW && outY >= 0 && outY < imgH) {
        var valIn = data[inY * imgW + inX];
        var valOut = data[outY * imgW + outX];
        insideSum += valIn;
        outsideSum += valOut;
        count++;
      }
    }
  }

  if (count === 0) return 0.5;
  var avgIn = insideSum / count;
  var avgOut = outsideSum / count;
  var diff = Math.abs(avgIn - avgOut);
  return Math.min(1.0, diff / 70.0);
}

function isPointInsideQuad(pt, quad) {
  var inside = false;
  for (var i = 0, j = 3; i < 4; j = i++) {
    var xi = quad[i].x, yi = quad[i].y;
    var xj = quad[j].x, yj = quad[j].y;
    var intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-5) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function calculateQuadArea(pts) {
  var a = 0;
  for (var i = 0; i < 4; i++) {
    var j = (i + 1) % 4;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2.0;
}

function calculateAngle(p1, vertex, p2) {
  var v1x = p1.x - vertex.x, v1y = p1.y - vertex.y;
  var v2x = p2.x - vertex.x, v2y = p2.y - vertex.y;
  var dot = v1x * v2x + v1y * v2y;
  var mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
  var mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
  if (mag1 < 1e-5 || mag2 < 1e-5) return 90;
  var cos = Math.max(-1.0, Math.min(1.0, dot / (mag1 * mag2)));
  return Math.acos(cos) * 180.0 / Math.PI;
}

function sampleEdgeGradient(quad, imgW, imgH, gradMag) {
  if (!gradMag || !gradMag.data32F) return 0.5;
  var totalSum = 0;
  var count = 0;

  for (var side = 0; side < 4; side++) {
    var p1 = quad[side];
    var p2 = quad[(side + 1) % 4];
    var steps = 15;
    for (var k = 0; k <= steps; k++) {
      var t = k / steps;
      var x = Math.round(p1.x + t * (p2.x - p1.x));
      var y = Math.round(p1.y + t * (p2.y - p1.y));
      if (x >= 0 && x < imgW && y >= 0 && y < imgH) {
        var val = gradMag.data32F[y * imgW + x];
        totalSum += val;
        count++;
      }
    }
  }

  if (count === 0) return 0.5;
  var avgGrad = totalSum / count;
  return Math.min(1.0, avgGrad / 120.0);
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
    // Full-frame document fallback: if no sub-document on a table background is detected, default to FULL PAGE (100% bounds)
    if (!detected || detected.length !== 4) {
      detected = [
        { x: 0, y: 0 },
        { x: iw, y: 0 },
        { x: iw, y: ih },
        { x: 0, y: ih }
      ];
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
      // White balance + shadow removal + ink black
      var target = 185;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          var bL = bg[idx];
          var bR2 = bgR[idx], bG2 = bgG[idx], bB2 = bgB[idx];
          // White balance: scale so background becomes target
          var rScale = bR2 > 15 ? target / bR2 : 1;
          var gScale = bG2 > 15 ? target / bG2 : 1;
          var bScale = bB2 > 15 ? target / bB2 : 1;
          var valR = d[idx*4] * rScale;
          var valG = d[idx*4+1] * gScale;
          var valB = d[idx*4+2] * bScale;
          // Natural contrast boost (1.15x instead of 1.4x)
          valR = (valR - 128) * 1.15 + 128;
          valG = (valG - 128) * 1.15 + 128;
          valB = (valB - 128) * 1.15 + 128;
          valR = Math.min(255, Math.max(0, valR));
          valG = Math.min(255, Math.max(0, valG));
          valB = Math.min(255, Math.max(0, valB));
          // Compute luminance after white balance
          var lum = valR * 0.299 + valG * 0.587 + valB * 0.114;
          // Detect color saturation (photo, stamp, logo)
          var isColor = Math.abs(valR - valG) > 15 || Math.abs(valG - valB) > 15 || Math.abs(valR - valB) > 15;
          // Shadow removal: anything darker than bg*0.55 is text/ink
          var shadowThresh = bL * 0.55;
          if (lum < shadowThresh && !isColor) {
            // Push text to crisp ink black
            var darkness = 1 - (lum / shadowThresh); // 0..1
            darkness = darkness * darkness;
            var blackAmount = 0.80 + 0.15 * darkness;
            valR = valR * (1 - blackAmount);
            valG = valG * (1 - blackAmount);
            valB = valB * (1 - blackAmount);
          }
          // Background cleanup: gentle white push only on non-color paper
          if (lum > bL * 0.75 && lum > 175 && !isColor) {
            var whiteness = Math.min(1, (lum - 175) / 70);
            valR = valR + (255 - valR) * whiteness * 0.25;
            valG = valG + (255 - valG) * whiteness * 0.25;
            valB = valB + (255 - valB) * whiteness * 0.25;
          }
          d[idx*4] = Math.round(Math.min(255, Math.max(0, valR)));
          d[idx*4+1] = Math.round(Math.min(255, Math.max(0, valG)));
          d[idx*4+2] = Math.round(Math.min(255, Math.max(0, valB)));
        }
      }
      // Sharpen (3x3 unsharp mask)
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
      var shAmount = 1.5;
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
  var threshold = isTouch ? 48 : 32;

  // Check corners first
  for (var i = 0; i < corners.length; i++) {
    if (distance(pos, corners[i]) < threshold) return { type: 'corner', index: i };
  }

  // Check midpoints
  var mids = getMidpoints();
  for (var i = 0; i < mids.length; i++) {
    if (distance(pos, mids[i]) < threshold) return { type: 'mid', index: i };
  }

  // Proximity grab for touch: if touch is within 75px of a corner, grab closest corner
  if (isTouch && corners.length === 4) {
    var minDist = Infinity, bestIdx = -1;
    for (var j = 0; j < 4; j++) {
      var d = distance(pos, corners[j]);
      if (d < minDist) { minDist = d; bestIdx = j; }
    }
    if (bestIdx !== -1 && minDist < 75) {
      return { type: 'corner', index: bestIdx };
    }
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
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:16px;box-sizing:border-box;backdrop-filter:blur(8px);';
    div.innerHTML =
      '<div style="width:100%;max-width:540px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding:0 4px;">' +
        '<span style="color:white;font-weight:700;font-size:1.05em;">Step 2: Select Color & Filter</span>' +
        '<span style="color:#FFD700;font-size:0.82em;font-weight:600;">✨ Color Filters</span>' +
      '</div>' +
      '<div id="ocvPreviewContainer" style="max-width:100%;max-height:54vh;overflow:hidden;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;background:#000;"></div>' +
      '<div style="background:rgba(22,163,74,0.18);border:1.5px solid #16a34a;border-radius:10px;padding:8px 12px;margin:8px 0;width:100%;max-width:540px;display:flex;align-items:center;justify-content:space-between;color:#22c55e;font-size:0.8rem;font-weight:700;box-sizing:border-box;box-shadow:0 0 10px rgba(22,163,74,0.25);">' +
        '<span>⭐ Recommended: <strong>Magic Color</strong> (Removes shadows & 100% HD Text)</span>' +
        '<span style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:6px;font-size:0.68rem;font-weight:800;white-space:nowrap;">BEST PRINT</span>' +
      '</div>' +
      '<div id="ocvPreviewFilterBar" class="ocv-filter-bar" style="margin:12px 0 10px;width:100%;max-width:540px;justify-content:center;display:flex;gap:12px;overflow:visible;padding-top:8px;"></div>' +
      '<div style="display:flex;gap:12px;width:100%;max-width:540px;">' +
        '<button id="ocvPreviewBack" class="ocv-btn ocv-cancel" style="flex:0.4;background:#4b5563;padding:12px 16px;font-size:0.95em;">↺ Re-crop</button>' +
        '<button id="ocvPreviewConfirm" class="ocv-btn ocv-crop-btn" style="flex:1;background:#16A34A;padding:12px 16px;font-weight:700;font-size:1.05em;">✓ Save & Print</button>' +
      '</div>';
    document.body.appendChild(div);

    document.getElementById('ocvPreviewBack').onclick = function() {
      document.getElementById('ocvPreviewModal').style.display = 'none';
      var cropM = document.getElementById('ocvCropModal');
      if (cropM) cropM.style.display = 'flex';
    };
    document.getElementById('ocvPreviewConfirm').onclick = function() {
      document.getElementById('ocvPreviewModal').style.display = 'none';
      commitCropResult();
    };
    existing = div;
  }

  // Hide crop modal when preview opens
  var cropM = document.getElementById('ocvCropModal');
  if (cropM) cropM.style.display = 'none';

  existing.style.display = 'flex';
  var container = document.getElementById('ocvPreviewContainer');
  container.innerHTML = '';
  container.appendChild(previewCanvas);
  previewCanvas.style.cssText = 'max-width:100%;max-height:58vh;display:block;border-radius:4px;';

  renderPreviewFilterBar();
}

function renderPreviewFilterBar() {
  var bar = document.getElementById('ocvPreviewFilterBar');
  if (!bar) return;
  bar.innerHTML = '';

  var thumbW = 56, thumbH = 72;
  FILTER_DEFS.forEach(function(f) {
    var wrap = document.createElement('div');
    wrap.className = 'ocv-filter-thumb';
    wrap.style.position = 'relative';
    wrap.style.overflow = 'visible';
    if (f.id === selectedFilter) wrap.classList.add('active');
    wrap.setAttribute('data-filter', f.id);
    wrap.onclick = function() {
      selectedFilter = f.id;
      updatePreviewFilterSelection();
      if (previewCanvas && previewCanvas._unfilteredData) {
        var pCtx = previewCanvas.getContext('2d');
        var imageData = pCtx.createImageData(previewCanvas.width, previewCanvas.height);
        imageData.data.set(previewCanvas._unfilteredData);
        pCtx.putImageData(imageData, 0, 0);
        applyFilter(pCtx, previewCanvas.width, previewCanvas.height, selectedFilter);
      }
    };

    if (f.id === 'magic') {
      var badge = document.createElement('span');
      badge.className = 'ocv-best-badge';
      badge.style.cssText = 'position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg, #16a34a 0%, #15803d 100%);color:#fff;font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:10px;box-shadow:0 3px 8px rgba(0,0,0,0.6);z-index:99;letter-spacing:0.4px;white-space:nowrap;border:1px solid rgba(255,255,255,0.4);';
      badge.innerHTML = '⭐ BEST';
      wrap.appendChild(badge);
    }

    var cvs = document.createElement('canvas');
    cvs.width = thumbW;
    cvs.height = thumbH;
    cvs.style.cssText = 'width:' + thumbW + 'px;height:' + thumbH + 'px;border-radius:6px;display:block;';

    if (previewCanvas) {
      var ctx = cvs.getContext('2d');
      var pw = previewCanvas.width, ph = previewCanvas.height;
      var scale = Math.min(thumbW / pw, thumbH / ph);
      var dw = pw * scale, dh = ph * scale;
      var dx = (thumbW - dw) / 2, dy = (thumbH - dh) / 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, thumbW, thumbH);
      ctx.drawImage(previewCanvas, dx, dy, dw, dh);
      if (f.id !== 'original') {
        applyFilter(ctx, thumbW, thumbH, f.id);
      }
    }

    var label = document.createElement('div');
    label.className = 'ocv-filter-label';
    label.textContent = f.label;
    if (f.id === 'magic') {
      label.style.color = '#22c55e';
      label.style.fontWeight = '800';
    }

    wrap.appendChild(cvs);
    wrap.appendChild(label);
    bar.appendChild(wrap);
  });
}

function updatePreviewFilterSelection() {
  var thumbs = document.querySelectorAll('#ocvPreviewFilterBar .ocv-filter-thumb');
  thumbs.forEach(function(el) {
    if (el.getAttribute('data-filter') === selectedFilter) {
      el.classList.add('active');
      if (selectedFilter === 'magic') {
        el.style.border = '2px solid #16a34a';
        el.style.boxShadow = '0 0 10px rgba(22,163,74,0.4)';
      }
    } else {
      el.classList.remove('active');
      el.style.border = 'none';
      el.style.boxShadow = 'none';
    }
  });
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
  
  // Check if corners cover the FULL image (near all 4 boundaries) — only then skip crop
  // Do NOT use savedCorners comparison: auto-detected crop corners would incorrectly appear "unmoved"
  var coversFullImage = false;
  if (origCorners && origCorners.length === 4 && imgW > 0 && imgH > 0 && selectedFilter === 'original') {
    var edgeThresh = Math.max(imgW, imgH) * 0.03; // 3% of image
    // Corners should be close to (0,0), (W,0), (W,H), (0,H)
    var fullPts = [{x:0,y:0},{x:imgW,y:0},{x:imgW,y:imgH},{x:0,y:imgH}];
    coversFullImage = origCorners.every(function(c, i) {
      return Math.abs(c.x - fullPts[i].x) <= edgeThresh && Math.abs(c.y - fullPts[i].y) <= edgeThresh;
    });
  }

  if (coversFullImage && previewCanvas._originalFile) {
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
    // Derive filename from original file reference (same as cropDirect)
    var ext = '.png';
    var outType = 'image/png';
    var baseName = 'cropped_' + Date.now();
    if (_originalFileRef && _originalFileRef.name) {
      var lastDot = _originalFileRef.name.lastIndexOf('.');
      if (lastDot !== -1) {
        baseName = _originalFileRef.name.substring(0, lastDot);
      } else {
        baseName = _originalFileRef.name;
      }
    }
    var fileName = baseName + ext;
    var file = new File([blob], fileName, { type: outType });
    currentCallback(file, selectedFilter);
    closeModal();
  }, 'image/png');
}

// ---------- Close modal ----------
function closeModal() {
  hideLoupe();
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

  // Ensure container fits exact image dimensions with no black side bars
  containerEl.style.display = 'flex';
  containerEl.style.alignItems = 'center';
  containerEl.style.justifyContent = 'center';
  containerEl.style.width = Math.round(dispW) + 'px';
  containerEl.style.height = Math.round(dispH) + 'px';
  containerEl.style.background = 'transparent';

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
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:100;display:none;align-items:center;justify-content:center;overscroll-behavior:none;';
  var isId = isIdCopyMode;
  div.innerHTML =
    '<div style="background:#1e293b;border-radius:16px;padding:12px;max-width:540px;width:96%;color:white;max-height:98vh;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:0 4px;">' +
        '<span id="ocvLoading" style="display:none;font-size:0.75em;color:#FFD700;">Detecting...</span>' +
        '<div style="display:flex;gap:6px;">' +
          '<button onclick="OCV_CROP.rotate(-90)" class="ocv-btn" style="background:#334155;padding:8px 12px;border-radius:8px;">↺ Left</button>' +
          '<button onclick="OCV_CROP.rotate(90)" class="ocv-btn" style="background:#334155;padding:8px 12px;border-radius:8px;">↻ Right</button>' +
          '<button onclick="OCV_CROP.autoDetect()" class="ocv-btn" style="background:#2563eb;padding:8px 12px;font-weight:600;border-radius:8px;">Auto</button>' +
          '<button onclick="OCV_CROP.noCrop()" class="ocv-btn" style="background:#475569;padding:8px 12px;font-weight:600;border-radius:8px;">No Crop</button>' +
        '</div>' +
      '</div>' +
      '<div id="ocvCropContainer" style="border-radius:10px;overflow:hidden;background:transparent;position:relative;touch-action:none;display:flex;justify-content:center;align-items:center;margin:0 auto;">' +
        '<canvas id="ocvCropCanvas" style="display:block;touch-action:none;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);"></canvas>' +
      '</div>' +
      '<div style="display:flex;gap:10px;padding:12px 4px 4px;">' +
        '<button onclick="OCV_CROP.cancel()" class="ocv-btn ocv-cancel" style="flex:0.4;background:#475569;padding:10px 14px;border-radius:10px;">Cancel</button>' +
        '<button onclick="OCV_CROP.showPreview()" class="ocv-btn ocv-crop-btn" style="flex:1;background:#2563eb;padding:10px 14px;font-weight:700;font-size:1.05em;border-radius:10px;">Next: Color Change ➔</button>' +
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
    wrap.style.position = 'relative';
    wrap.setAttribute('data-filter', f.id);
    wrap.onclick = function() { OCV_CROP.setFilter(f.id); };

    if (f.id === 'magic') {
      var badge = document.createElement('span');
      badge.className = 'ocv-best-badge';
      badge.style.cssText = 'position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg, #16a34a 0%, #15803d 100%);color:#fff;font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:10px;box-shadow:0 3px 8px rgba(0,0,0,0.6);z-index:99;letter-spacing:0.4px;white-space:nowrap;border:1px solid rgba(255,255,255,0.4);';
      badge.innerHTML = '⭐ BEST';
      wrap.style.position = 'relative';
      wrap.style.overflow = 'visible';
      wrap.appendChild(badge);
    }

    var cvs = document.createElement('canvas');
    cvs.width = thumbW;
    cvs.height = thumbH;
    cvs.style.cssText = 'width:' + thumbW + 'px;height:' + thumbH + 'px;border-radius:6px;display:block;';

    var label = document.createElement('div');
    label.className = 'ocv-filter-label';
    label.textContent = (f.id === 'magic') ? 'Magic Color' : f.label;
    if (f.id === 'magic') {
      label.style.color = '#22c55e';
      label.style.fontWeight = '800';
    }

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
      if (selectedFilter === 'magic') {
        el.style.border = '2px solid #16a34a';
        el.style.boxShadow = '0 0 10px rgba(22,163,74,0.4)';
      }
    } else {
      el.classList.remove('active');
      el.style.border = 'none';
      el.style.boxShadow = 'none';
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
}

// ---------- Magnifying Loupe (Lens) Manager ----------
var loupeEl = null;
var loupeCtx = null;
var loupeActive = false;

function ensureLoupeElement() {
  if (loupeEl) return;
  loupeEl = document.createElement('div');
  loupeEl.id = 'ocvLoupe';
  loupeEl.style.cssText = 'position:fixed;width:110px;height:110px;border-radius:50%;border:3px solid #ffffff;box-shadow:0 6px 20px rgba(0,0,0,0.55),0 0 0 1.5px #16A34A;overflow:hidden;pointer-events:none;z-index:99999;display:none;opacity:0;transition:opacity 0.18s ease;background:#000;box-sizing:border-box;';
  
  var cvs = document.createElement('canvas');
  cvs.id = 'ocvLoupeCanvas';
  cvs.width = 110;
  cvs.height = 110;
  cvs.style.cssText = 'display:block;width:100%;height:100%;border-radius:50%;';
  
  var cross = document.createElement('div');
  cross.style.cssText = 'position:absolute;top:50%;left:50%;width:16px;height:16px;transform:translate(-50%,-50%);pointer-events:none;';
  cross.innerHTML = '<div style="position:absolute;top:7px;left:0;right:0;height:2px;background:#16A34A;box-shadow:0 0 2px #fff;"></div>' +
                    '<div style="position:absolute;left:7px;top:0;bottom:0;width:2px;background:#16A34A;box-shadow:0 0 2px #fff;"></div>';
  
  loupeEl.appendChild(cvs);
  loupeEl.appendChild(cross);
  document.body.appendChild(loupeEl);
  loupeCtx = cvs.getContext('2d');
}

function updateLoupe(targetPos, clientX, clientY) {
  if (!canvasEl || !sourceImage || !targetPos) { hideLoupe(); return; }
  ensureLoupeElement();

  var lSize = 110;
  var zoomFactor = 4; // 4x magnification

  // 1. Smart edge detection position relative to touch/cursor
  var lLeft = clientX - lSize / 2;
  var lTop = clientY - lSize - 20; // 20px above touch
  if (lTop < 10) {
    lTop = clientY + 30; // flip below if near top screen edge
  }
  lLeft = Math.max(10, Math.min(window.innerWidth - lSize - 10, lLeft));
  lTop = Math.max(10, Math.min(window.innerHeight - lSize - 10, lTop));

  loupeEl.style.left = lLeft + 'px';
  loupeEl.style.top = lTop + 'px';

  if (!loupeActive) {
    loupeActive = true;
    loupeEl.style.display = 'block';
    void loupeEl.offsetWidth;
    loupeEl.style.opacity = '1';
  }

  // 2. Render 4x zoomed image onto loupeCtx
  var lCtx = loupeCtx;
  lCtx.clearRect(0, 0, lSize, lSize);
  lCtx.save();
  lCtx.imageSmoothingQuality = 'high';
  lCtx.imageSmoothingEnabled = true;

  lCtx.beginPath();
  lCtx.arc(lSize / 2, lSize / 2, lSize / 2, 0, Math.PI * 2);
  lCtx.clip();

  var imgPt = canvasToImage(targetPos.x, targetPos.y);
  var cropW = (lSize / zoomFactor) / displayScale;
  var cropH = (lSize / zoomFactor) / displayScale;

  var sx = imgPt.x - cropW / 2;
  var sy = imgPt.y - cropH / 2;

  var drawImg = getFilteredImage() || sourceImage;
  lCtx.drawImage(drawImg, sx, sy, cropW, cropH, 0, 0, lSize, lSize);

  // 3. Overlay zoomed green crop border inside loupe
  var zoomOffsetX = lSize / 2 - targetPos.x * zoomFactor;
  var zoomOffsetY = lSize / 2 - targetPos.y * zoomFactor;

  lCtx.strokeStyle = '#16A34A';
  lCtx.lineWidth = 2.5;
  lCtx.beginPath();
  for (var i = 0; i < corners.length; i++) {
    var cx = corners[i].x * zoomFactor + zoomOffsetX;
    var cy = corners[i].y * zoomFactor + zoomOffsetY;
    if (i === 0) lCtx.moveTo(cx, cy);
    else lCtx.lineTo(cx, cy);
  }
  lCtx.closePath();
  lCtx.stroke();

  // White & green target handle dot
  var handleX = targetPos.x * zoomFactor + zoomOffsetX;
  var handleY = targetPos.y * zoomFactor + zoomOffsetY;
  lCtx.beginPath();
  lCtx.arc(handleX, handleY, 7, 0, Math.PI * 2);
  lCtx.fillStyle = '#ffffff';
  lCtx.fill();
  lCtx.strokeStyle = '#16A34A';
  lCtx.lineWidth = 2.5;
  lCtx.stroke();

  lCtx.restore();
}

function hideLoupe() {
  if (!loupeEl || !loupeActive) return;
  loupeActive = false;
  loupeEl.style.opacity = '0';
  setTimeout(function() {
    if (!loupeActive && loupeEl) {
      loupeEl.style.display = 'none';
    }
  }, 180);
}

function onPointerMove(e) {
  if (!canvasEl || corners.length !== 4) return;
  var pos = getCanvasPos(e);
  var w = canvasEl.width, h = canvasEl.height;

  if (pointerState.dragging) {
    var dx = pos.x - pointerState.startX;
    var dy = pos.y - pointerState.startY;
    var activePos = pos;

    if (pointerState.handleType === 'corner') {
      var idx = pointerState.handleIdx;
      corners[idx] = {
        x: clamp(pointerState.startCorners[idx].x + dx, 0, w),
        y: clamp(pointerState.startCorners[idx].y + dy, 0, h)
      };
      activePos = corners[idx];
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
      activePos = { x: (corners[ci].x + corners[cj].x) / 2, y: (corners[ci].y + corners[cj].y) / 2 };
    }
    renderCrop();
    updateLoupe(activePos, e.clientX, e.clientY);
    return;
  }

  var h2 = getHandleAt(pos);
  canvasEl.style.cursor = h2 ? 'grab' : 'default';
}

function onPointerUp(e) {
  hideLoupe();
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
    hideLoupe();
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
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (!canvasEl || corners.length !== 4) return;
  var w = canvasEl.width, h = canvasEl.height;

  if (touchState.pinching && e.touches.length === 2) {
    hideLoupe();
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
    var touchClientX = e.touches[0].clientX;
    var touchClientY = e.touches[0].clientY;
    var activePos = pos;

    if (touchState.handleType === 'corner') {
      var idx = touchState.handleIdx;
      corners[idx] = {
        x: clamp(touchState.startCorners[idx].x + dx, 0, w),
        y: clamp(touchState.startCorners[idx].y + dy, 0, h)
      };
      activePos = corners[idx];
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
      activePos = { x: (corners[mi].x + corners[(mi + 1) % 4].x) / 2, y: (corners[mi].y + corners[(mi + 1) % 4].y) / 2 };
    }
    renderCrop();
    updateLoupe(activePos, touchClientX, touchClientY);
    return;
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  hideLoupe();
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
  var ext = '.png';
  if (_originalFileRef && _originalFileRef.name) {
    var origExt = _originalFileRef.name.split('.').pop().toLowerCase();
    if (origExt === 'jpg' || origExt === 'jpeg') {
      outType = 'image/jpeg';
      outQuality2 = 0.98;
      ext = '.jpg';
    }
  }

  fCtx.canvas.toBlob(function(blob) {
    if (!blob) return;
    var baseName = 'cropped_' + Date.now();
    if (_originalFileRef && _originalFileRef.name) {
      var lastDot = _originalFileRef.name.lastIndexOf('.');
      if (lastDot !== -1) {
        baseName = 'cropped_' + _originalFileRef.name.substring(0, lastDot);
      } else {
        baseName = 'cropped_' + _originalFileRef.name;
      }
    }
    var fileName = baseName + ext;
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

  openModal: function(image, idCopy, callback, originalFile) {
    openModal(image, idCopy, callback, originalFile);
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
        if (!isIdCopyMode && typeof window.checkAndNotifyIdCard === 'function') {
          window.checkAndNotifyIdCard(corners, canvasEl.width, canvasEl.height, _originalFileRef);
        }
      }
      if (loadingEl) loadingEl.style.display = 'none';
    });
  },

  noCrop: function() {
    if (!canvasEl) return;
    corners = [
      { x: 0, y: 0 },
      { x: canvasEl.width, y: 0 },
      { x: canvasEl.width, y: canvasEl.height },
      { x: 0, y: canvasEl.height }
    ];
    renderCrop();
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
