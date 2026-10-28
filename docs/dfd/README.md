# Data Flow Diagrams — maintenance guide

This directory holds the GeoAttend DFD set. **The SVGs are generated, never hand-edited.**
All four diagrams come from one script, `scripts/generate-dfds.js`.

## Files

| File | Contents |
| --- | --- |
| `GeoAttend-DFD-Level0-Context.*` | Whole system as one process `0`, the 5 external entities |
| `GeoAttend-DFD-Level1.*` | Processes `1.0`–`8.0` against data stores `D1`–`D14` |
| `GeoAttend-DFD-Level2-RecordAttendance.*` | Process `4.0` decomposed into `4.1`–`4.10` |
| `GeoAttend-DFD-Level2-VerifyIdentity.*` | Process `5.0` decomposed into `5.1`–`5.10` |

Each name exists as `.svg` (source of truth) and `.png` (rasterised copy for embedding in docs).

## Regenerate

```bash
node scripts/generate-dfds.js    # rewrite all 8 files
node scripts/lint-dfds.js        # then check them (exit 1 = problems, printed with coordinates)
```

The generator needs no arguments, no network, no database — `sharp` is already a project
dependency. Output is deterministic, so a diff after regenerating should only show changes you
actually made.

`lint-dfds.js` parses the finished SVGs and reports, with bounding boxes and label text:

| Tag | Meaning |
| --- | --- |
| `DIAG` | a flow with a diagonal (non-orthogonal) segment |
| `OVL` | two flow labels overlapping each other |
| `BOX` | a flow label sitting on top of a shape |
| `CROSS` | a line running through the interior of a shape |
| `ARRW` | an arrowhead buried inside a shape (invisible arrow) |
| `MERGE` | two flows sharing one lane over an overlapping stretch |

## File anatomy

```
scripts/generate-dfds.js
├── palette C, FONT, HEADER_H      visual identity — do not change casually
├── primitives                     esc, wrap, text, block, rect
├── LABELS / LABEL_RECTS / BOXES   placement bookkeeping, reset by document_()
├── canvas(w,h) / reserve(b)       canvas bounds + shape area labels must steer clear of
├── channel(x0,x1,step)            lane allocator: take(y1,y2) hands out a lane that is
│                                  free over that whole y-range (no two flows share one)
├── shapes                         processBox, storeBox, entityBox, noteBox
├── label()                        halo label — nudges itself off shapes and other labels
├── flow()                         polyline + arrowhead + optional label (label drawn last)
├── connectors                     east, west, entProc, procEnt, entProcR, procEntR,
│                                  vert, across
├── document_()                    svg root, arrow marker, title + subtitle, flushes labels
├── emit(name, svg, pngWidth)      writes .svg, rasterises .png via sharp
├── B(x,y,w,h)                     box helper → { x, y, x1, x2, y1, y2 }, also reserves it
└── level0() / level1() /
    level2Attendance() /
    level2Identity()               one function per diagram; returns SVG string
```

The runner at the bottom calls `emit()` once per diagram. **Add new diagrams there.**
Every level function starts with `canvas(W, H)` and creates its boxes with `B()` before it
draws any flow — that is what lets labels avoid shapes and the header automatically.

## Layout rules

These are the rules that keep the diagrams readable. `lint-dfds.js` enforces 1–4 for you.

1. **Orthogonal only.** Every flow is a horizontal/vertical polyline. No diagonals between boxes.
2. **One port per flow.** Each flow leaves a box at its own `y` and lands on its own `y` on the
   target. `fan()` (Level 1) spreads a process's flows over its height, `sPort()` keeps a store's
   incoming ports distinct, and the Level 2 diagrams pass explicit port `y` values.
3. **One lane per flow.** A flow owns an `x` column for its vertical leg, taken from a
   `channel(x0, x1, step)` — `ch.take(y1, y2)` only hands out a lane that is free over that whole
   range, so two flows can never run on top of each other. Need more room? Widen the channel (and
   the gap between the two columns it sits in) rather than reusing a lane.
   Lanes: `CH_L`/`CH_R`/`CH_E`/`CH_F` in `level1()`, `CH_A`/`CH_B` in both Level 2 diagrams.
4. **Labels sit on their own lane**, in a white halo box, at the midpoint of the run. `label()`
   nudges a label off any shape or neighbouring label it would otherwise touch (7 px clearance),
   so a hand-picked `at:` is a *preference*, not a promise.
5. **Keep clear of the header.** Title is at `y = 46`, subtitle at `y = 76`. Nothing may start
   above roughly `y = 110`.
6. **Notes box goes last** in the drawing order but is *created first* in the function, so
   `reserve()` protects the space before any label is placed. It returns `{ svg, h }` — add `n.h`
   to the canvas height (see `level1()`'s `W, H + n.h + 30`).
7. **Labels and all lines are flushed after every shape** by `document_()`, so no later element
   can be painted over label text.
8. **Gaps:** ≥ 60 px between boxes for a lane, ≥ 40 px between a box edge and a crossing lane.

## Common edits

| Task | Where |
| --- | --- |
| Rename / reword a flow | its `g.push(flow(...))` or the label argument of `east/west/...` |
| Add a process to Level 1 | `B(...)` for its box, `processBox(...)`, then add entries to the `fan([...])` arrays |
| Add a data store | append to the `defs` array in `level1()` (spacing is `230 + i * 108`) |
| Add a process→store flow | add `[Pn, 'Dx', 'label']` to the matching `fan([...], CH_L/CH_R, east/west)` |
| Add a flow in a Level 2 diagram | give it a lane with `CH_A.take(y1, y2)` / `CH_B.take(y1, y2)` and an explicit port `y` |
| Change a process's ports | handled by `fan()`; only touch if the flow is hand-placed |
| Add a Level 2 step | box via `B()` + `processBox('4.x', ...)`, connect with `east/west/vert/across` |
| Change colours / fonts | the `C` palette at the top — applies to all four diagrams |
| Change PNG sharpness | 2nd arg of `emit(...)` (width in px). Current: 2200 / 2700 / 2600 / 2600 |
| Add a diagram | new `function myDiagram()` calling `canvas(W, H)` first, then a new `emit(...)` line |

## Verification checklist

After any edit:

1. `node scripts/generate-dfds.js` — note the printed PNG sizes.
2. `node scripts/lint-dfds.js` — must print `all clean`. Each finding carries the offending
   coordinates and label text, so you can jump straight to it in the generator.
3. `east()` vs `west()` sanity: `east` leaves `a.x2` and enters `b.x` (source left of the store),
   `west` leaves `a.x` and enters `b.x2` (source right of it). Getting this backwards buries the
   arrowhead inside a box or drives the line straight through the store — the linter's `ARRW` and
   `CROSS` catch both.
4. Spot-check the PNGs visually: nothing hidden behind the subtitle or notes box, canvas edge has
   ≥ 40 px margin, and no label has been nudged so far from its flow that it reads as another one.
5. Commit the script, the linter **and** all 8 outputs together — they must stay in sync.

## When to update the diagrams

| Code change | Diagram(s) affected |
| --- | --- |
| New API route / endpoint group | Level 1, plus Level 2 if it belongs to 4.0 or 5.0 |
| New table in `database/schema.sql` | Level 1 (`defs` array) + whichever Level 2 touches it |
| New external service (API, provider) | Level 0 entity + its flows, Level 1 |
| Changed attendance rules (grace, ratio, accuracy) | Level 2 `RecordAttendance` note box |
| Changed verification / liveness flow | Level 2 `VerifyIdentity` note box |
| Renamed or split/merged a process | Level 1 and any Level 2 that decomposes it |

## Store ↔ table reference

| Store | Tables (`database/schema.sql`) |
| --- | --- |
| D1 | `admin_accounts`, `tokens`, `admin_email_otps` |
| D2 | `employees`, `departments` |
| D3 | `mobile_devices`, `device_verification_attempts` (partial, see D13) |
| D4 | `employee_faces`, `face_records`, `ocr_records` |
| D5 | `events`, `geofences`, `geofence_points` |
| D6 | `settings` |
| D7 | `audit_logs` |
| D8 | `attendance`, `attendance_sessions`, `attendance_logs` |
| D9 | `geo_anomalies` |
| D10 | `notifications`, `admin_notifications` |
| D11 | `employee_ratings` |
| D12 | `certificates` |
| D13 | `device_verification_attempts` |
| D14 | `stored_uploads` |

## Conventions kept from the original set

- Names: `GeoAttend-DFD-Level<n>[-<Topic>].svg`, always paired with a `.png`.
- Level 1 omits the `D7` audit-log edge from every process, and the `D14` upload edge — stated in
  the on-diagram Notes box instead. Keep doing this for edges that would repeat 8 times.
- Gane & Yourdon shapes: rounded rect = process, rect with ID tab = data store, shadowed rect =
  external entity.
