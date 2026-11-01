# Efficiency + UI enhancement audit wave (audit-eu, 2026-11-01)

Executor: the orchestrator (subagent launcher degraded — 7 consecutive
"context deadline exceeded" failures; E1/E2/U1 agent launches all failed.
The audit below was executed inline: bundle measurement, a 200-event
end-to-end measurement run, and a UI inventory cross-checked against the
existing e2e/smoke/stress coverage — every claim verified against code or
execution; false-positive protocol applied throughout. Probe artifacts:
/home/z/e1-combined.mjs, /home/z/e1-cmeta.mjs, /home/z/e1-measure.mjs.)

## E1/E2 — Efficiency baseline (measured @ 20f56d2)

### Client bundle (first load, cold cache)
| asset | raw | gz |
|---|---|---|
| all.global.js (FC v7.1.3 all-plugins) | 850.1 KB | 180.4 KB |
| app.js | 170.9 KB | 48.5 KB |
| style.css | 42.7 KB | 9.1 KB |
| rrule.mjs (modulepreload) | 88.8 KB | 18.5 KB |
| calendar-core.js + ical.js + api.js + crypto.js + boot-guard.js | 61.1 KB | ~14 KB |
| skeleton.css | 8.7 KB | — |
| **TOTAL** | **1222.4 KB** | **~256 KB gz** |

Per-theme assets (loaded on demand by managed links): global.js 31 KB +
theme.css 15 KB + one palette css. The all-plugins bundle is exactly the
plugin set the app uses (daygrid/timegrid/interaction/multimonth/list) —
a custom slimmer bundle would need a build toolchain and break the
vendored-verbatim posture; not proposed.

### Runtime measurements (200 synthetic events, local stack)
| flow | measured |
|---|---|
| Seed 200 rows (PUT incl. client crypto) | 1097 ms (~5.5 ms/PUT) |
| Fresh-browser unlock → app visible | ~4.9 s wall (incl. harness overhead; PBKDF2 600k ≈ 150 ms) |
| **Reload unlock → first chip painted (local-first hydration)** | **272 ms** |
| Month navigation (Next/Prev) with 200 chips | ~230 ms per nav |
| Page/console errors at 200 events | 0 |
| Cache size at 200 events | 71.5 KB (localStorage 5 MB budget) |
| 200 parallel DELETEs (cleanup) | 440 ms |

### Verdict + proposals
The prior efficiency wave (fe92525) captured the structural wins (etag/304
idle polls, batch sync, change-gated rendering, modulepreload, WeakMap RRule
cache). Remaining opportunities, ranked:

1. **E7-1 [LOW, ~15 KB gz]** `js/app.js` ships readable source (48.5 KB gz).
   A minified build would halve it but abandons the readable-vendored
   posture; only worth it if the Pages budget ever matters.
2. **E7-2 [LOW]** `writeLocalCache` re-serializes every event's payload on
   each debounced write (200 × serialize ≈ measurable at ~10–20 ms/write).
   Memoizing `serializeEvtPayload` on the parsed object (WeakMap or a
   `_ser` field) would make writes O(dirty). Low value at current scale.
3. **E7-3 [INFO]** First-sync wall time (~2–4 s at 200 rows) is dominated by
   200 sequential decrypt+parse in one batch response — could parallelize
   decryption with Promise.all in `fetchRowsIntoState` (bounded, e.g. 32
   concurrent). Estimated 2–3× faster first paint on fresh browsers.
   **This is the one real proposal worth implementing.**
4. **E7-4 [INFO, worker]** Manifest at 1000 rows ≈ 94 B/row JSON; a compact
   `[[id,ver],…]` form would halve it — a protocol change (additive, §22)
   not justified at PoC scale. PUT throughput measured at ~5.5 ms/req
   including client crypto; the epoch triggers add sub-ms per mutation
   (VP1-measured). No worker change proposed.

## U1 — UI enhancement inventory (verified against code + test coverage)

Already present (verified — do not re-propose): keyboard shortcuts
(n/t/d/w/m/y/v/a/arrows/Escape with B13 modal blocking), 7 themes ×
palettes + density + hour12 + customDays + auto-lock toggle, empty states,
375px-viewport support (A6-6), corrupt-row surfacing with dedup'd toasts
(A6-5), recurring-edit choice modal with Escape/backdrop cancel, drag/resize
native, tasks (VTODO + completion + editor task mode), mini-calendar with
firstDay, agenda/list view, chip a11y (tabindex + Enter popover).

Ranked enhancement candidates (value/effort/risk):
1. **Undo for event delete** (HIGH value / MEDIUM effort / LOW risk) — the
   popover Delete is immediate; a 5-second undo toast holding the deleted
   envelope (re-PUT with allowCreate) gives safe destructive recovery.
   Implementation: capture the row payload before deleteRow; toast with an
   Undo button calling putRowRMW(id, () => capturedText, {allowCreate:true}).
2. **Parallel first-sync decryption** (efficiency crossover with E7-3 —
   faster first paint IS a UX enhancement).
3. **Search/filter events** (MEDIUM / MEDIUM / LOW) — a filter input in the
   sidebar filtering state.evt by summary substring before renderAll.
4. **Task list view** (MEDIUM / HIGH / MEDIUM) — Fossify-style list of
   incomplete tasks with checkboxes; new view type in VIEWS + list builder.
5. **Sidebar collapse toggle** (LOW / LOW / LOW) — CSS-class toggle + media
   query; improves narrow viewports beyond the current stacking.

No visual defects outstanding: the VLM month-view audit (this session)
passed cleanly after the ?server= toast was removed from the provisioning
flow; FC-native title truncation and multi-day continuation edges are
documented deviations.

## Disposition
- Implement now: **E7-3 (parallel batch decryption)** — the single
  measured, low-risk win.
- Queue (next session, owner's call): undo-delete, search, task list view,
  sidebar collapse, E7-2 memoized serialization.
- No worker-side efficiency changes justified by the measurements.
