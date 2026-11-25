# Spatial packing repair

## Problem

The converter previously sorted objects by a coarse horizontal cell, then original node index. Triangle-limited chunks from the same cell could therefore contain interleaved parts of the same structures. Loading the nearest bounded prefix of chunks is not equivalent to loading a complete structure. Increasing the resident count alone increases rendering and transfer costs without establishing coverage.

## Change

Within each coarse cell, recursively partition object centres along their longest 3D extent until each leaf fits the triangle budget. Flush the existing writer at each leaf boundary. Keep an oversized object whole in a separate leaf. Compute exact local bounds once per reusable geometry instead of sampling vertices for the grouping centre. Mark new manifests with `tileLayout: spatial-median-v1`.

The partitioner changes object membership/order only. It does not simplify faces, classify structures, change client memory budgets, or alter the existing downstream geometry processing. In particular this is not a guarantee that the entire converter is lossless.

## Validation

Run `node --test tests/spatial-partition.test.mjs tests/streaming-stability.test.mjs` and `npm run typecheck`.

Tests cover interleaved source order, exact membership, coincident centres, vertical groups, oversized objects and invalid data. An integration test runs the actual GLB builder on four interleaved synthetic regions and checks emitted object IDs, triangle totals and local bounds.

## Deployment and limits

Code deployment does not rewrite existing XKT caches. No conversion job is dispatched by this change. Existing cache generations must remain available until a new generation is validated and published through the normal conversion path.

Before requesting another screenshot, rebuild a representative region from available source geometry and compare original/rebuilt membership and visual coverage. Then measure navigation on the same camera path and client. A single exported detail chunk cannot reconstruct missing neighbours or prove full source-model completeness.

Dense overlapping geometry, long objects, coarse coverage/LOD, terrain occlusion and GPU cost remain separate issues. A spatial partition alone is not a complete large-model rendering solution. Median splitting may increase file counts and exact bounds add preprocessing work. No measured full-model speedup or completed visual repair is claimed here.

## Exact detail welding follow-up

Local reprocessing of one uploaded detail chunk exposed a separate issue: the legacy 2cm coordinate grid reduced 351,025 input triangles to 331,744. This is a reprocessing experiment on an already converted chunk, not a measurement of original NWD loss.

The tiled detail path now deduplicates identical position/normal tuples only. It keeps input numeric precision until the existing world-to-local transform and does not remove faces. Repeating the same experiment retains all 351,025 triangles and all 329 input objects across two output GLB chunks. This validates membership/counts for this step, not original-source completeness, final XKT precision or GPU performance. More retained geometry may cost more memory than the lossy path.

`node --test tests/exact-weld.test.mjs tests/spatial-partition.test.mjs tests/streaming-stability.test.mjs` covers exact tuples, sharp normal seams, precision, malformed data and actual GLB conversion of 5mm synthetic faces that the previous grid collapsed.

Existing XKT files cannot recover previously removed faces. An original-source rebuild is required for restoration. No cloud conversion job has been launched.
