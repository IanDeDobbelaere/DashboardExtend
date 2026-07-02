# Performance Improvement Tasks

Use this as a local backlog for separate AI sessions. Pick one task, paste the whole task into a fresh session, and ask the agent to complete only that task plus any blockers listed as already done.

Keep tasks small. Each task should leave the extension working and should be verifiable on its own.

## Status Key

- [ ] Not started
- [~] In progress
- [x] Done

## Task 1: Add a performance safety harness

**Blocked by:** None - can start immediately

### What to build

Add a small verification harness around the point-cloud export and tile-capture behavior so later refactors can prove they preserved the existing behavior.

### Acceptance criteria

- [x] There is a repeatable way to run focused checks for tile identity, duplicate detection, transform lookup, projection/clipping, and export formatting.
- [x] The checks can run locally without opening Smart Construction Dashboard.
- [x] The harness includes at least one fixture for a tiny point tile or equivalent decoded tile shape.
- [x] The README or this file explains the command or manual steps to run the checks.

### Verification

```bash
node tests/performance_harness.js
```

## Task 2: Deepen tile capture through the fetch path

**Blocked by:** Task 1

### What to build

Refactor fetch-based tile capture so intercepted tileset and point-tile responses are captured from the real fetch response path without issuing duplicate network requests.

### Acceptance criteria

- [x] Fetch requests for `.pnts` and `tileset.json` are inspected from cloned real responses where possible.
- [x] The page still receives the original fetch response unchanged.
- [x] Duplicate tile keys are still ignored.
- [x] Transform lookup and capture diagnostics still work.
- [x] The safety harness covers the fetch path.

## Task 3: Route XHR tile responses through tile capture

**Blocked by:** Task 2

### What to build

Refactor XHR-based tile capture so XHR responses use the same tile-capture implementation as fetch and no longer trigger probe fetches just to parse data.

### Acceptance criteria

- [x] XHR-loaded `.pnts` and `tileset.json` responses flow through the same tile-capture module as fetch-loaded responses.
- [x] XHR interception does not issue extra network requests for resources already loaded by the host page.
- [x] Auth token capture from XHR headers still works.
- [x] Duplicate tile keys are still ignored across fetch and XHR.
- [x] The safety harness covers the XHR path or documents the manual verification gap.

## Task 4: Prepare projection and polygon clipping once per export

**Blocked by:** Task 1

### What to build

Deepen the export worker math so projection settings, local-grid constants, rotation candidates, polygon bounds, and polygon edges are prepared once per export instead of being recomputed throughout the point loop.

### Acceptance criteria

- [x] Export behavior remains unchanged for WGS84, projected, and ECEF polygon modes.
- [x] Local-grid origin, trigonometry, scale, and rotation values are prepared outside the per-point hot path.
- [x] Polygon bounds and edge data are prepared once per export.
- [x] Diagnostics still report processed count, candidate counts, ranges, transform source counts, and rotation candidate stats.
- [x] The safety harness covers at least one WGS84 case and one local-grid/projected case.

## Task 5: Stream CSV and DXF point output

**Blocked by:** Task 4

### What to build

Change CSV and DXF point exports so accepted points are written directly to format-specific writers instead of first collecting all accepted point objects and then formatting them.

### Acceptance criteria

- [x] CSV output matches the previous format for the same accepted points.
- [x] DXF point output matches the previous format for the same accepted points.
- [x] Non-mesh exports no longer need a full `finalPoints` array.
- [x] Export diagnostics still report clipped and dropped counts.
- [x] The safety harness compares at least one CSV export and one DXF point export.

## Task 6: Stream DXF mesh output through a grid writer

**Blocked by:** Task 5

### What to build

Move DXF mesh generation behind a mesh writer that accumulates only grid-cell state while accepted points stream through it.

### Acceptance criteria

- [x] Mesh output remains compatible with the current `3DFACE` DXF structure.
- [x] Mesh mode stores grid-cell accumulators rather than all accepted points.
- [x] Grid size behavior is unchanged.
- [x] Export diagnostics still report clipped and dropped counts.
- [x] The safety harness compares at least one mesh export.

## Task 7: Deepen host DOM discovery for export UI and metadata

**Blocked by:** Task 1

### What to build

Create a host DOM adapter that owns shadow-DOM traversal, caching, invalidation, and named access to dashboard elements used by export UI injection, filename metadata, polygon extraction, layer toggles, and calibration.

### Acceptance criteria

- [x] Export controls still inject into the annotation detail panel.
- [x] Project name, polygon name, timeline date, polygon coordinates, layer toggles, and calibration data are read through the host DOM adapter.
- [x] Repeated full-tree scans are reduced or centralized behind cache-aware methods.
- [x] The adapter has fixture-based checks for shadow-root traversal and cache invalidation, or the manual verification gap is documented.
- [x] Existing UI behavior remains unchanged.

## Task 8: Move measurements toolbar sync onto the host DOM adapter

**Blocked by:** Task 7

### What to build

Refactor measurements toolbar injection and visibility sync to use the host DOM adapter instead of running its own repeated full-tree scans.

### Acceptance criteria

- [x] The measurements toolbar still appears beside drawing guides.
- [x] Toolbar visibility still follows drawing-guide visibility.
- [x] Toolbar injection does not create duplicates.
- [x] Idle DOM scan work is reduced compared with the current polling implementation.
- [x] The verification notes explain how to confirm toolbar behavior in the dashboard.

### Verification

```bash
node tests/performance_harness.js
```

Manual dashboard check: reload the extension in Smart Construction Dashboard, open a project view where drawing guides are available, and confirm the `sc-simplemeasurements-toolbar` appears in the same `.panels` container as `sc-drawing-guides`. Toggle the drawing-guide UI hidden and visible, then reopen or rebuild the panel; the custom toolbar should hide/show with the guides and should still exist only once.

## Task 9: Deepen capture timing around tile-capture events

**Blocked by:** Task 2 and Task 7

### What to build

Move export capture timing into a capture session module that coordinates host-layer toggles, tile-capture progress, quiet-period detection, timeout handling, progress text, and worker launch.

### Acceptance criteria

- [x] Export still toggles the relevant data layers to encourage tile loading.
- [x] Capture completion is based on tile-capture progress and quiet-period rules, not only nested fixed waits.
- [x] Timeout behavior still restores button text and enabled state.
- [x] Diagnostic timing still reports elapsed listen time, stable time, minimum listen time, stable threshold, and max wait.
- [x] The safety harness or a documented manual check covers quiet-period and timeout behavior.

### Verification

```bash
node tests/performance_harness.js
```
