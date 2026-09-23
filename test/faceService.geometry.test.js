// Verifies the pure-math geometry helpers behind the InsightFace pipeline in
// services/faceService.js: the 5-point similarity-transform solver used for
// face alignment, the inverse-mapped bilinear affine warp, and NMS. These
// don't touch the ONNX models at all, so this runs even without the
// det_10g.onnx / w600k_r50.onnx model files in place.
//
// No test framework required -- run directly with:
//   node test/faceService.geometry.test.js

const { _internal } = require('../services/faceService');
const { solveSimilarityTransform, warpAffine, nms } = _internal;

let failures = 0;
function assertClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok   ${label}`);
  }
}

// ---- similarity transform recovers a known rotation+scale+translation ----
{
  const theta = (15 * Math.PI) / 180;
  const scale = 1.5;
  const trueA = scale * Math.cos(theta);
  const trueB = scale * Math.sin(theta);
  const trueTx = 10;
  const trueTy = -5;

  // The actual InsightFace 112x112 alignment template -- exercising the
  // solver against the real points it will be called with in production.
  const src = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
  const dst = src.map(([x, y]) => [trueA * x - trueB * y + trueTx, trueB * x + trueA * y + trueTy]);

  const { a, b, tx, ty } = solveSimilarityTransform(src, dst);
  assertClose(a, trueA, 1e-6, 'similarity transform: a (scale*cos)');
  assertClose(b, trueB, 1e-6, 'similarity transform: b (scale*sin)');
  assertClose(tx, trueTx, 1e-6, 'similarity transform: tx');
  assertClose(ty, trueTy, 1e-6, 'similarity transform: ty');
}

// ---- identity transform via warpAffine reproduces the source exactly ----
{
  const w = 8, h = 8;
  const src = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    src[i * 3] = (i * 7) % 256;
    src[i * 3 + 1] = (i * 13) % 256;
    src[i * 3 + 2] = (i * 29) % 256;
  }
  const out = warpAffine(src, w, h, { a: 1, b: 0, tx: 0, ty: 0 }, w, h);
  let maxDiff = 0;
  for (let i = 0; i < src.length; i++) maxDiff = Math.max(maxDiff, Math.abs(src[i] - out[i]));
  assertClose(maxDiff, 0, 0, 'warpAffine identity: pixel-perfect reproduction');
}

// ---- warpAffine correctly inverts a known scale+translation ----
{
  const w = 4, h = 4;
  const src = new Uint8ClampedArray(w * h * 3);
  src[0] = 255; // pixel (0,0) = pure red

  // dst = 2*src + (4,0) -- so dst pixel (4,0) should sample src pixel (0,0).
  const out = warpAffine(src, w, h, { a: 2, b: 0, tx: 4, ty: 0 }, 8, 4);
  const idx = (0 * 8 + 4) * 3;
  assertClose(out[idx], 255, 1, 'warpAffine scale+translate: red channel at mapped pixel');
  assertClose(out[idx + 1], 0, 1, 'warpAffine scale+translate: green channel at mapped pixel');
}

// ---- NMS suppresses heavily-overlapping lower-score boxes ----
{
  const boxes = [[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]];
  const scores = [0.9, 0.95, 0.8];
  const kept = nms(boxes, scores, [null, null, null], 0.5).map((d) => boxes.indexOf(d.box));
  assertClose(kept.length, 2, 0, 'nms: keeps 2 of 3 boxes (one overlapping pair + one separate)');
  assertClose(kept.includes(1) ? 1 : 0, 1, 0, 'nms: keeps the higher-scoring box of the overlapping pair');
  assertClose(kept.includes(0) ? 1 : 0, 0, 0, 'nms: suppresses the lower-scoring overlapping box');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
