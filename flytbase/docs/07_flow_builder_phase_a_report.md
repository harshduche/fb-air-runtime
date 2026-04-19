# 07 — Flow builder Phase A report (list view + save polish)

**Status**: implementation drafted 2026-04-18 on branch `phase-1-spike`.
Awaiting review before Phase B (canvas + block insertion UX) starts.

## Scope shipped

Phase A of the Roboflow-builder port, per the plan agreed with the user
on 2026-04-18 after reviewing 22 reference screenshots.

| Feature | State before | State after |
| --- | --- | --- |
| Workflow discovery | `window.prompt` pick-list inside the Load button | Dedicated `/flybuild` dashboard with card grid |
| URL routing | Single-page; workflow ID lived in topbar input | `/flybuild` (list) · `/flybuild/edit/:id` (builder) |
| Open a workflow | Click Load, type the ID exactly | Click card on dashboard |
| Create a workflow | Type into ID field, click Save | `+ Create Workflow` button → enter ID → lands in builder |
| Rename | Edit ID field, click Save (old file quietly stayed on disk) | Rename icon on card: save-as-new + delete-old |
| Duplicate | Manually copy the JSON file on disk | `⧉` icon on card |
| Delete | curl the API | `×` icon on card with confirm |
| Save indicator | Transient status text | Persistent "Saved 3m ago" + amber dirty dot |
| Unsaved-changes guard | None | `beforeunload` + confirm on back/clear |

Unchanged in Phase A: canvas behavior, inspector, run panel, block
palette — all land in Phases B–D.

## Files touched

- `frontend/src/Dashboard.tsx` — **new** (260 LoC). Lists workflows
  from `GET /flybuild/api`, renders a compact schematic preview per card
  (pure CSS, no React Flow instantiation in the list), CRUD affordances.
- `frontend/src/App.tsx` — rewritten. Splits into `BuilderInner`
  (workflow id as prop, auto-loads on mount) and an `App` router that
  swaps Dashboard/Builder based on `window.location.pathname`. Dirty
  tracking via serialized-spec diff; relative-time "Saved X ago"
  indicator refreshed every 30 s.
- `frontend/src/api.ts` — added `deleteWorkflow`.
- `frontend/src/index.css` — added dashboard styles, mini-graph schematic,
  dirty-dot + saved-ago topbar decorations.

Backend (`routes.py`) **unchanged** — `/flybuild/edit/{workflow_id}`
already returned the SPA shell, which the new client router now actually
uses.

## Behaviour notes / decisions applied

- **Routing is history-based, no router library.** Two routes total;
  `react-router` would be overhead. `popstate` listener handles back/forward.
- **Mini-graph is static CSS, not React Flow.** Rendering 30 React Flow
  instances for a dashboard was the wrong trade; a three-column
  schematic (inputs · steps · outputs) conveys the shape with zero
  runtime cost.
- **Dirty check uses serialized-spec equality**, not a mutation counter.
  Survives node moves, undo/redo, and avoids false dirties after save.
- **Rename is two-step (save-new + delete-old) from the client.** The
  backend's `old_id` payload path is still available but not used here —
  keeps rename idempotent even if the user closes the tab mid-flow.
- **404 on load is treated as a new workflow**, not an error. Lets
  `Create Workflow` jump straight into the builder before the first save.

## What I did NOT do (per memory: no one-way-door guesses)

- Did not flip the canvas layout from horizontal to vertical (Phase B
  pending your decision in the plan, decisions #4).
- Did not add Publish/Deploy affordances (decision #1 still open).
- Did not change the theme (decision #5 still open).
- Did not touch `enterprise/`.

## Verification status

- **Static review**: imports clean (no dangling references to removed
  helpers), types match the existing `FlytNodeData` / `BlockDef` shapes,
  no new external deps.
- **`npm run build`**: **NOT RUN** on this machine. Local node is 12.22;
  tsc 5.5 + Vite 5.4 need node 18+. Honest call per memory
  `feedback_hardware_honesty`: the build has to be run on a host with a
  modern toolchain before merge.
- **Runtime smoke**: **NOT RUN** for the same reason. Needs a human on
  a dev box with `npm install && npm run build` capability, then
  exercise the five flows in the table above.

## Suggested verification checklist (for reviewer)

1. `npm install && npm run build` in `frontend/` — expect clean tsc.
2. `ENABLE_FLYT_BUILDER=true` start the inference server.
3. Open `/flybuild` → confirm dashboard renders, empty state prompts
   creation.
4. Click `+ Create Workflow`, enter an ID → confirm URL changes to
   `/flybuild/edit/<id>` and builder loads empty.
5. Drop a block, Save → confirm dirty dot disappears, "Saved just now"
   appears, card appears on dashboard with schematic preview.
6. Back to Workflows → rename, duplicate, delete. Reload page on each —
   state should match disk.
7. Hard-refresh on `/flybuild/edit/<id>` → should land on the builder
   with the workflow rehydrated.

## Gate check

Per `feedback_phase_gating`: Phase A is **not** complete until this
report is reviewed and the verification checklist is signed off. I am
not starting Phase B work until that happens.
