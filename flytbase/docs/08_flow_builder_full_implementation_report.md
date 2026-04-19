# 08 — Flow builder full implementation report (phases B–G)

**Status**: all scoped features landed on branch `phase-1-spike`, built
and deployed live on the running `flytbase-infer-v122` container at
2026-04-18.

The user explicitly waived per-phase gate reviews for this scope, so
phases B–G shipped in one pass. This document replaces the usual
per-phase reports.

## Decisions honoured (from conversation 2026-04-18)

| # | Decision | Applied how |
| --- | --- | --- |
| 1 | Publish = local version bump | New `<sha>/<vN>.json` storage, `POST /flybuild/api/{id}/publish` bumps, `/restore` forks a prior version forward |
| 2 | Suggestive block dropdown in place | `InlineBlockPicker` on every edge's `+` button; ranked by kind compatibility + `ui_manifest.popular` + `blockPriority` |
| 3 | Real `InferencePipeline` for streaming | `/inference_pipelines/initialise` for File/URL/RTSP/USB; `/inference_pipelines/initialise_webrtc` for browser webcam; poll `/consume` @ 500 ms |
| 4 | Vertical canvas layout | Flipped handles to Top/Bottom, Dagre `rankdir: TB` auto-layout on hydration and demand |
| 5 | No per-phase report | Gate reviews skipped; this doc is the single deliverable |

## Decisions applied by default (flagged in plan)

- **AI composer / Workflow Agent**: out of scope. No LLM backend in place;
  left as a future surface.
- **Theme**: stayed dark.
- **Webcam capture**: browser WebRTC rather than server-side
  `cv2.VideoCapture` — keeps the inference container airgap-clean and
  works in any browser without `--device=/dev/video*` mounts.

## What shipped

### Backend (`inference/core/interfaces/http/flyt_builder/`)

- **`routes.py` — rewritten.**
  - Version-aware storage: `<sha>/meta.json` + `<sha>/v<N>.json`.
    Migration of phase-A flat `<sha>.json` files is idempotent and
    triggered lazily on any read.
  - New endpoints: `POST /api/{id}/publish`, `GET /api/{id}/versions`,
    `POST /api/{id}/restore?version=N`, `GET /api/templates`,
    `GET /api/devices`, `GET /api/local_models`.
  - Kept phase-A CRUD intact: `GET /api`, `GET/POST/DELETE /api/{id}`.
  - Explicit route-ordering comment: specific paths (`/templates`,
    `/devices`, `/local_models`) must sit above `/api/{workflow_id}`
    because FastAPI treats path args greedily.
- **`templates/*.json` — four seeds.** Detect + Visualize, SAM3 with
  Prompts, Detect→Crop→Classify, People Tracker.

### Frontend (`flyt_builder/frontend/src/`)

New files:
- **`layout.ts`** — Dagre TB layout (`@dagrejs/dagre` added to
  `package.json`).
- **`BlockPicker.tsx`** — two pickers in one file:
  - `BlockPickerModal`: centered Add Block modal with search, category
    accordion (driven by `ui_manifest.section`), popular badges, Enter
    picks top result.
  - `InlineBlockPicker`: floating popover anchored to an edge's `+`
    button. Filters blocks by whether they accept any of the upstream
    output kinds (intersection of `kinds_connections`).
- **`ModelPicker.tsx`** — Your/Public tabs. *Your* tab lists
  `$MODEL_CACHE_DIR` contents; *Public* tab is a curated list
  (RF-DETR, YOLOv8, YOLO-NAS, COCO, vehicle classification).
- **`RunPanel.tsx`** — right-rail run UX. Per-input tab strip
  File/URL/Webcam/RTSP/USB, Image vs Stream mode auto-select,
  config-changed pill, Run/New Run/Stop, JSON/Visual output tabs,
  fullscreen image modal, live WebRTC `<video>` render for webcam.
- **`WebRTCStream.ts`** — thin `getUserMedia` + `RTCPeerConnection` +
  `initialise_webrtc` helper. Returns a handle with `localStream`,
  `remoteStream`, `onPredictions`, `stop`.
- **`VersionHistory.tsx`** — left-rail drawer listing versions with
  restore buttons.

Modified files:
- **`App.tsx`** — rewritten around all new components:
  vertical handles, Dagre auto-layout on hydration, node mini-toolbar
  (duplicate/delete on hover), custom `PlusEdge` with inline `+`
  button, auto-wire on connect, keyboard shortcuts
  (`⌘S` `⌘⏎` `/` `⌫` `⌘D` `⎋`), topbar extras (version badge,
  auto-wire toggle, Arrange, Add Block, History, Publish).
- **`Inspector.tsx`** — schema-driven widgets: slider when
  `minimum`+`maximum` present, chip multi-select for
  `array<string>`, boolean pill toggle, reference combobox of
  `$inputs.*` / `$steps.*.*`, Model picker launcher for
  `model_id`-shaped fields, required vs additional fields split with
  collapsible accordion, connection summary header.
- **`compile.ts`** — `categoryFor`, `outputKindsOf`, `outputsByName`,
  `uiManifestFor` helpers used across picker, inspector, and auto-wire.
- **`api.ts`** — full versioning / pipeline / templates / devices /
  local_models / WebRTC init functions, typed
  `BlocksDescribeResponse` including `kinds_connections`.
- **`Dashboard.tsx`** — templates row at top, version chip on each
  workflow card.
- **`index.css`** — ~600 new lines: modal backdrop, block picker
  modal, inline picker, model picker, run panel + media tabs, version
  drawer, vertical node decorations, edge-plus button, empty-canvas
  hero, template grid, version chip.

## File-by-file inventory

```
inference/core/interfaces/http/flyt_builder/
├── routes.py                                  # ~720 lines, rewritten
├── templates/
│   ├── 01_detect_and_visualize.json          # NEW
│   ├── 02_sam3_prompted_segmentation.json    # NEW
│   ├── 03_crop_and_classify.json             # NEW
│   └── 04_people_tracker.json                # NEW
└── frontend/src/
    ├── App.tsx              # rewritten
    ├── Inspector.tsx        # rewritten
    ├── Dashboard.tsx        # extended
    ├── Palette.tsx          # unchanged
    ├── compile.ts           # extended
    ├── api.ts               # extended
    ├── layout.ts            # NEW
    ├── BlockPicker.tsx      # NEW
    ├── ModelPicker.tsx      # NEW
    ├── RunPanel.tsx         # NEW
    ├── WebRTCStream.ts      # NEW
    ├── VersionHistory.tsx   # NEW
    ├── main.tsx             # unchanged
    └── index.css            # extended (~900 → 1500 lines)
```

## Verification status

### Automated
- **Build**: `docker run --rm -v $PWD:/app -w /app node:20-alpine
  npm run build` produces clean `tsc -b && vite build` output.
  Final bundle: `index-CBVaYiuh.js` 393 KB (126 KB gzipped) +
  `index-CakVnUeZ.css` 35 KB (5.9 KB gzipped).
- **Route ordering bug caught + fixed**: first build had
  `/api/templates` shadowed by `/api/{workflow_id}`. Hoisted the
  literal-path routes above the parameterised one; re-probed all three
  endpoints → 200 with correct payloads.
- **Backend smoke** (container `flytbase-infer-v122` restarted after
  route change):
  - `GET /flybuild/api/templates` → 4 templates.
  - `GET /flybuild/api/devices` → `[]` (no `/dev/video*` in container —
    expected; host would need `--device=/dev/video0` passthrough).
  - `GET /flybuild/api/local_models` → 3 models found under
    `$MODEL_CACHE_DIR` (`coco`, `sam3`, `_file_locks`).
  - `GET /flybuild/api/my-flyt-workflow/versions` → auto-migration ran;
    `v1` created on disk with `{current_version:1, versions:[1]}`.
  - `GET /flybuild` → 200, references new bundle hashes.

### NOT yet tested (needs a human on the box)
Per `feedback_hardware_honesty`, I'm flagging these — I cannot drive a
browser session from this shell.

- Canvas vertical auto-layout on a real multi-step graph.
- Edge `+` button opening `InlineBlockPicker` with kind-filtered
  suggestions.
- Auto-wire on connect filling compatible ref fields.
- Model picker modal loading local + public model lists.
- Run panel:
  - Image mode with an uploaded file.
  - Stream mode with a public RTSP URL.
  - Stream mode via webcam (browser WebRTC round-trip).
  - Fullscreen image modal.
- Publish → version 2 → restore → version 3 round-trip.
- Keyboard shortcuts `⌘S / ⌘⏎ / / / ⌫ / ⌘D`.

## Known risks / caveats

- **WebRTC** depends on the inference server having the
  `InferencePipeline` WebRTC path functional. The code calls
  `/inference_pipelines/initialise_webrtc`, which upstream marks
  `[EXPERIMENTAL]`. If that route returns an unexpected SDP answer
  shape, `WebRTCStream.startWebRTCStream` throws. Any errors surface as
  `Run panel → error` toast.
- **USB mode** requires `/dev/video*` inside the container. On the
  current `flytbase-infer-v122` container this list is empty, so the UI
  will show a "mount `--device=/dev/video*`" hint rather than a real
  picker.
- **Auto-wire** uses a heuristic (field name matches `image|input|…`).
  When blocks ship cleaner `kind`-typed schemas, we can tighten this to
  full kind intersection. Unchanged ref fields remain typed by hand.
- **Kinds inference** falls back to "accept anything" for blocks whose
  `outputs_manifest` is empty. The suggestive picker still works —
  just shows all non-pseudo blocks.
- **Rollup on Alpine** needs the `@rollup/rollup-linux-x64-musl`
  optional dep injected before `vite build`. The build command in the
  report uses `npm install @rollup/rollup-linux-x64-musl --no-save`
  to work around https://github.com/npm/cli/issues/4828. Any node 20+
  glibc container wouldn't need this.

## Out of scope (still)

- **AI Workflow Agent / composer chat** — blocked on LLM backend
  decision. UI anchors not rendered.
- **Light theme + toggle** — dark only.
- **Deploy button** — did not ship a stub; can add when deployment
  target is decided.
- **Mobile** / responsive breakpoints.
- **i18n**.

## What I need from you

1. Walk through `/flybuild` and confirm the visible UX matches
   expectations. If it doesn't, tell me specifically what feels off —
   the new surface is deep (run panel, inspector widgets, pickers) and
   I'd rather iterate with real feedback than guess.
2. Decide on AI agent scope: in/out, and if in, which LLM backend.
3. Decide deploy semantics before I add that button.
