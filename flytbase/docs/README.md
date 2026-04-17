# FlytBase AI-R Edge — Fork Documentation

This folder holds **FlytBase-specific documentation** for our fork of
`github.com/roboflow/inference`. It lives beside, not inside, the upstream
`docs/` folder at the repo root (which is Roboflow's own documentation and we
don't modify that).

## How to read this

Start at **00** and work downward. Each doc is focused on one question:

| # | File | Question it answers |
| --- | --- | --- |
| 00 | [Context](00_context.md) | Why is FlytBase forking Roboflow Inference? |
| 01 | [Scope and constraints](01_scope_and_constraints.md) | What are we actually building, and what are the hard rules? |
| 02 | [Plan and phases](02_plan_and_phases.md) | How are we sequencing the work? |
| 03 | [Current status](03_current_status.md) | What's been done so far? |
| 04 | [Capabilities](04_capabilities.md) | What does this foundation give us for free, and what do we still need to build? |
| 05 | [Key design decisions](05_key_design_decisions.md) | Which decisions are one-way doors, and what's our current stance on each? |

## Sibling documents

- [../phase_1_feasibility_spike.md](../phase_1_feasibility_spike.md) — the
  Phase 1 gate-decision report (static + hardware findings). This is the
  authoritative technical record for Phase 1; `03_current_status.md` here is
  a summary with pointers.

## What will live here later

- `FORK_CHANGES.md` — Phase 2 will add this to track every deviation from
  upstream. Required by Apache 2.0 Section 4 and our quarterly rebase plan.
- Per-phase completion reports (02 onwards) in the same style as the Phase 1
  spike.

## Conventions

- **Commits referencing the phase**: `[phase-N] ...` subject line. No
  Co-Authored-By trailers on this project.
- **No push until a FlytBase fork repo exists** (Phase 2 task 1). Current
  work sits on the local `phase-1-spike` branch; `origin` still points at
  `roboflow/inference` upstream.
- **Date format in docs**: absolute ISO-8601 (e.g., `2026-04-17`), never
  relative ("last Thursday").
- **Source-of-truth hierarchy** when two docs conflict:
  1. Committed code and `FORK_CHANGES.md` (Phase 2+)
  2. Phase completion reports (`flytbase/phase_N_*.md`)
  3. These index docs (00–05)
  If a doc here disagrees with the code, fix the doc.
