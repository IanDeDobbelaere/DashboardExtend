# DashboardExtend

## Performance Safety Harness

Run the focused point-cloud export checks locally with:

```bash
node tests/performance_harness.js
```

The harness runs without opening Smart Construction Dashboard. It verifies host DOM adapter shadow-root traversal and cache invalidation, measurements toolbar injection and visibility sync, capture-session quiet-period and timeout behavior, tile identity, duplicate PNTS detection, fetch-path and XHR-path capture without duplicate requests, tileset transform lookup, WGS84 and local-grid clipping, and CSV/DXF point and mesh export formatting against a tiny in-memory PNTS fixture.
