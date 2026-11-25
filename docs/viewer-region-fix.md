# Viewer region selection repair

- Select and rank detail chunks by distance to their world-space AABB, not their centre or bounding sphere. Long, narrow chunks intersecting the focus no longer lose priority solely because their centres are distant. Empty areas alongside long chunks no longer count as nearby.
- Transform source Z-up bounds to viewer Y-up bounds consistently. Reject inverted bounds and retain original manifest indices for diagnostics.
- When actual file bytes exceed the initial estimate, release cached chunks outside the current selection before rejecting a wanted chunk. Preserve the existing encoded-byte, tile-count and concurrency limits.
- Compute ranking distances once per selection. Rotation-only navigation continues to retain the working set.

Validation: two regression cases fail before the change and pass afterward; 26 tests pass, plus TypeScript and production build.

Deployment: frontend changes only; existing manifests work without model reconversion. No conversion job was started. Raw models, credentials and signed URLs are excluded.

Limits: AABB overlap does not prove a chunk contains the structure body. The existing 24-chunk / 192 MiB encoded-byte working set can still omit neighbouring chunks. Complete region coverage and actual GPU performance remain unverified. This is a targeted fix, not a claim of full-model completeness.

User verification: reopen the same cached model in the test deployment, compare the same bridge/tunnel region, rotate and zoom, then provide a screenshot, a short navigation video and diagnostics JSON. Do not click reconvert for this change.
