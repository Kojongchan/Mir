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
