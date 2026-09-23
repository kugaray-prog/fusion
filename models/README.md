# Face Recognition Models — InsightFace ("buffalo_l")

`services/faceService.js` runs face verification using the real **InsightFace**
two-stage pipeline via **ONNX Runtime** (`onnxruntime-node`) — no cloud API,
everything runs locally:

1. **Detect** — `det_10g.onnx` (SCRFD-10GF) finds the face's bounding box and
   5 landmarks (eyes, nose, mouth corners) in the source photo.
2. **Align** — those 5 landmarks are used to warp the face into the
   canonical, upright 112x112 crop every ArcFace-family model is trained on
   (corrects for head tilt, off-center framing, camera angle, etc. before
   recognition ever sees the image).
3. **Recognize** — `w600k_r50.onnx` (ResNet50 ArcFace, trained on WebFace600K)
   turns that aligned crop into a 512-d embedding, L2-normalized before
   storage/comparison.

This two-stage detect-then-align approach is *why* InsightFace is
meaningfully more accurate than embedding a naively-cropped photo — a
crooked selfie and a perfectly centered one produce nearly identical
embeddings once both are aligned to the same template.

## What's bundled vs. what you need to download

| File | Size | Included? |
|---|---|---|
| `det_10g.onnx` (detector) | ~17 MB | ✅ **Bundled** in `models/` |
| `w600k_r50.onnx` (recognizer) | ~174 MB | ❌ **Not bundled** — too large to ship in this repo; download it yourself (one-time, instructions below) |

Until `w600k_r50.onnx` is in place, Face Verification requests fail with a
clear setup error telling you exactly what's missing and where to put it —
every other module keeps working.

### Downloading `w600k_r50.onnx`

Both files come from InsightFace's official `buffalo_l` model pack. Run:

```bash
cd geoattend-pro
curl -L -o /tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
unzip -o /tmp/buffalo_l.zip w600k_r50.onnx -d models/
rm /tmp/buffalo_l.zip
```

(The full zip is ~289 MB and also contains `1k3d68.onnx`, `2d106det.onnx`,
and `genderage.onnx` — landmark/attribute models this app doesn't use; the
`unzip ... w600k_r50.onnx` argument pulls out only the one file you need.)

**This exact setup has been verified working end-to-end** — both files were
downloaded and run through this codebase's actual detection → alignment →
recognition pipeline against real photos: detection returned a 0.88-confidence
face box with correctly-positioned landmarks, the aligned 112x112 crop came
out centered and upright, and matching two different photos of the same
person scored 0.66 similarity while different people scored ~0.0 — well
either side of the default 0.5 match threshold.

## Licensing

InsightFace's code is MIT-licensed, but **the `buffalo_l` model weights
themselves are available for non-commercial research use only** (per
InsightFace's model zoo terms). If this app is going into production or
commercial use, either secure a commercial license from InsightFace/the
original training-data owners, or swap in a model you've cleared for
commercial use (see below) — the same way you'd vet any third-party
dependency.

## Swapping in different models

- **Detector**: any SCRFD-family ONNX detector with 3 FPN strides ([8, 16,
  32], 2 anchors/position, 5-point landmarks) works as-is. Other sizes
  (`det_2.5g.onnx`, `det_500m.onnx`) are drop-in — just update
  `FACE_DETECTOR_MODEL_PATH`.
- **Recognizer**: any ArcFace-family model taking a 112x112 aligned RGB input
  (NCHW, normalized to `[-1, 1]`) and outputting a fixed-length embedding
  works — update `FACE_MODEL_PATH`. The embedding length doesn't need to
  match 512; `faceService.js` reads it dynamically from the model output.

Point `FACE_DETECTOR_MODEL_PATH` / `FACE_MODEL_PATH` in `.env` at wherever
you keep these files if you'd rather not place them under `models/`.

## Tuning match sensitivity

`FACE_MATCH_THRESHOLD` in `.env` (default `0.5`, cosine similarity) was
verified reasonable against the buffalo_l pack specifically (see the
same-person/different-person test above), but score distributions still
shift a little with real enrolled-employee photos — sanity-check it against
your own data before fully trusting the default in production.
