# XKT sample inspection

A user-provided sample was inspected locally. No model binary, screenshot, source
object identifiers, project identifiers, signed URL, or credentials are included
in this change.

## Observations

- Uncompressed XKT v12; 380 entities, 380 meshes, 350,611 triangles.
- Entity bounding-box diagonals range from approximately 1.155 to 1.194 in file
  coordinate units. The sample contains dispersed small parts, not a complete
  bridge or a complete spatial region.
- No triangle index outside its geometry's vertex range was found.
- Local Chromium rendered the sample with Viewer DTX both enabled and disabled.
  Both runs loaded 380 entities with matching bounds and no page/console errors.
  Software GPU rendering does not establish performance on the user's hardware.
- This single sample does not establish completeness or correctness of other
  cached chunks. Loading a chunk is not equivalent to completing a structure.

## Reproducible inspection

Run `node scripts/inspect-xkt.mjs path/to/chunk.xkt` for supported local files.
Run `node --test tests/xkt-inspection.test.mjs` for the inspection regressions.
The inspector deliberately rejects compressed/other versions, reused geometry,
and non-triangle primitives instead of guessing their layout.

## Remaining work

The viewer's distance/count/file-size selection has no guarantee of structural
coverage. The next data-layout work must account for region completeness and
object scale, then progressively display detail without permanently removing
small parts. This audit does not implement that change or resolve the full-scene
visibility and navigation-performance issues. No new conversion was triggered.
