# Hill cost: filtering DEM noise from edge profiles

`engine/src/build_policy.cc` gives every directed edge an uphill cost, stored in
`bikesy-policy.bin`. The engine adds `4 · (1 − use_hills) · cost` to the edge's routing cost.
This document explains how the cost is computed from the elevation model, why a filter is needed,
and how its two constants were chosen. The code is `engine/src/bikesy_profile.h`; its unit tests
are in `engine/tests/policy_test.cc`.

## The cost

The builder resamples each edge's shape every 30 m and reads the DEM at each point. Bridges and
tunnels are not costed from those samples: the whole structure is replaced by a straight line between
the points where it meets the ground (see [Bridges and tunnels](#bridges-and-tunnels)). The cost of a
climb of `rise` metres over `run` metres is the convex grade integral in `bikesy_policy.h`:

```
cost = run · (max(0, rise / run) / 0.05)³
```

A steady 5% grade costs about 1 unit per metre, 10% about 8, and 20% about 64. Descents cost
nothing. The cube is what makes steep streets expensive, and also what makes noise expensive.

## The problem

Until this change the builder applied the formula to every 30 m step. The DEM (1 arc-second,
about 28 m cells) is not accurate enough for that:

- **Side slopes.** Where a road is cut into a steep hillside, the DEM often does not resolve the
  bench the road sits on. The sampled profile then swings up and down the slope beside the road.
  On the US 50 Spooner grade above Lake Tahoe, the DEM along the road is off by 40 to 58 m over
  hundreds of metres. A steady 5% highway reads as a series of 20 to 60 m humps with 50 to 100%
  sample-to-sample grades. Two westbound edges there cost 31 and 87 units per metre, and the
  4 km eastbound edge, which is a descent, cost 137,000 units.
- **Short edges.** Two samples a few metres apart that differ by a few metres of DEM error make a
  "cliff": on a 30 m edge, a 3 m error reads as a 10% grade.

Cubing turns these artifacts into the dominant term. In the Tahoe graph, more than half of all
uphill cost was noise, and about 2,500 directed edges carried a false penalty of over 10,000
units. Routes avoided such edges with long detours, for example 109 km via Luther Pass instead of
19 km on US 50 from Carson City to Spooner Summit.

## The filter

Two changes, both applied per edge in `bikesy::profile_uphill`:

1. **Dead-band (`kHillDeadBand` = 35 m).** The profile is reduced to its turning points: the two
   endpoints, plus each high or low point that the profile then leaves by at least 35 m. Cost is
   computed on the mean grade between consecutive turning points. Reversals smaller than 35 m are
   treated as noise within a steady grade. Endpoints are always kept, so an edge's net climb is
   never lost, and a real climb that rises and falls by more than 35 m inside one edge is costed in
   both directions. The filter is directional, so it runs once along each direction of travel: the
   reverse cost is the forward cost of the reversed profile, and an edge costs the same whichever
   way its OSM way was digitised. (A single pass shared by both directions gave different costs
   after reversal on noisy profiles; it affects about one directed edge in 10,000.)
2. **Minimum run (`kHillMinRun` = 60 m).** A grade is never computed over a run shorter than 60 m:
   `run = max(run, 60)`. The rise is unchanged, so short edges keep their full climb in metres, but
   a few metres of DEM error between two close samples can no longer read as a 30% grade.

The constants are fixed in code on purpose. They describe the DEM's resolution, not a routing
preference, so they are not configuration. Changing them changes the policy data of every region
and needs the same evidence as below.

## How the constants were chosen

### Method

The 1 arc-second DEM was compared, edge by edge, with an independent and more accurate one: the
USGS 3DEP 1/3 arc-second (about 10 m) DEM, sampled at the same 30 m points along every edge. The
reference cost uses the same formula on the 10 m DEM, with a 3 m band to drop its own small
noise. The comparison covered every bicycle-accessible edge of the Tahoe graph (140,461 edge
shapes) and the SF Bay Area graph (1.24 million shapes, 82,000 km), counting each direction only
where bicycles may ride it.

For each candidate filter, the analysis measured:

- **false cost kept**: cost above the reference, summed over edges;
- **real cost removed**: cost below the reference;
- **climb kept**: metres of ascent as a share of the reference ascent;
- **false penalties longer than the edge**: directed edges whose excess cost, weighted as the
  engine weights it, is more than the edge's own length (so the edge costs at least double) while
  being over 3 times the reference. This counts the edges that can bend a route.

Candidates were dead-bands of 0 to 100 m, dead-bands scaled by edge length or by cross-slope
(the DEM 30 m either side of the road), grade caps of 15 to 35% alone and combined with a band,
class-dependent bands, and minimum runs of 60, 90 and 120 m. The candidates that looked best per
edge were then compared on real routes with the route benchmark (`bench/`).

### Dead-band: 35 m

Tahoe, all bicycle-accessible edges, before the minimum run is added (reference cost 107.8 M
units, reference climb 576 km):

| Band | False cost kept | Real cost removed | Climb kept | Edges with doubled cost, `use_hills` 0.85 |
| --- | --- | --- | --- | --- |
| none (previous builder) | 123.3 M | 4.3 M | 111% | 11,882 |
| 5 m | 18.2 M | 15.2 M | 101% | 5,225 |
| 10 m | 14.3 M | 19.2 M | 96% | 4,946 |
| 15 m | 12.2 M | 22.5 M | 93% | 4,846 |
| 25 m | 10.8 M | 25.8 M | 90% | 4,800 |
| **35 m** | 10.4 M | 27.9 M | 89% | 4,789 |
| 50 m | 9.6 M | 29.6 M | 87% | 4,786 |
| 100 m | 8.8 M | 31.7 M | 86% | 4,782 |

- Most of the noise goes in the first 10 to 15 m. Past that, each extra metre of band removes
  little noise in total and keeps removing real climb.
- **Real undulation inside an edge is common** on trails and dirt roads. In the 10 m DEM, 14,363
  Tahoe edges climb and descend by 3 m or more within the edge, about 20% of all climbing.
  Dirt roads keep 88% of their climb at 25 m, 86% at 35 m and 85% at 50 m; paths 88%, 86% and 85%.
  Roads keep 93 to 98% at any band from 15 to 100 m. In SF, roads keep 97 to 99% at every band,
  and city streets 99%: their edges are short (median 40 m), so they rarely contain a hump.
- **The total hides the edges that matter most: false humps of 25 to 35 m on engineered roads.**
  On the US 50 Spooner grade, the 2.2 km westbound edge has a 28 m false hump. With a 25 m band it
  keeps 23,400 units against 2,100 in the 10 m reference; from 35 m it keeps 5,000. At production
  settings (Tahoe `use_hills` 0.5, a weight of 2) that difference is worth about 40 km of flat road,
  and it decides whether busy-mode routes use US 50 over Spooner Summit. In the benchmark at
  production settings, 25 m left Carson City to Spooner Summit, Carson City junction to Glenbrook and
  the Spooner grade climb on detours in busy mode (26.0, 27.4 and 16.7 km); 35 m and 50 m route all
  three on US 50 (19.4, 20.9 and 10.2 km), as the 10 m reference does.
- 35 m and 50 m gave the same aggregate results in both regions at production settings and differ
  on very few routes, so 35 m, which keeps more real climb, is the better point. In SF, 25, 35 and
  50 m gave the same aggregate results in every scenario.
- Scaling the band by edge length or cross-slope was no better than a fixed band on any measure.
  Neither the cross-slope nor Valhalla's own `max_upward_grade` identifies the noisy edges well:
  most of them sit on slopes under 15%.

### Minimum run: 60 m

After any band, the remaining false cost is concentrated on short edges. Their endpoints are
always kept, so the band cannot remove an endpoint error, and on a 30 m edge a 3 m error reads
as a 10% grade. A minimum run spreads that error over at least 60 m.

| Filter | False cost kept, Tahoe | Real cost removed, Tahoe | Edges with doubled cost, Tahoe `use_hills` 0.5 | SF, `use_hills` 0 | Cost kept on SF's steepest streets |
| --- | --- | --- | --- | --- | --- |
| 35 m band | 10.4 M | 27.9 M | 8,130 | 65,981 | 96% |
| 35 m band, 60 m minimum run | 7.4 M | 30.2 M | 3,211 | 13,928 | 82% |
| 35 m band, 90 m minimum run | 6.2 M | 31.7 M | 2,044 | 8,815 | 69% |

The Tahoe doubled-cost column counts at `use_hills` 0.5, the production setting, while the band
table above counts at 0.85, the original benchmark setting. Both counts are correct for the same
35 m band: at 0.5 the hill weight is larger, so more edges cross the doubling threshold (8,130
against 4,789).

"SF's steepest streets" are the 739 street edges in San Francisco with a true grade of 15% or
more (47.5 km, median length 56 m). Climb in metres is unchanged by the minimum run; only the
grade, and so the cube, is reduced.

- The minimum run cuts the edges with a doubled cost by 60% in Tahoe and 79% in SF. In SF it is
  the larger part of the change: in a run on the same SF data, the band alone reduced the routes in scenario 1
  that failed or were over 1.5 times the shortest distance from 35 to 32, and adding the 60 m minimum run
  brought them to 22.
- 90 m removes a little more noise but keeps only 69% of the cost of SF's steepest streets. 60 m
  keeps 82%. Across SF's six hill-sensitive scenarios, 12 of 2,574 benchmark routes with the filter
  climb at least 20 m and 20% more than the 10 m reference route, against 11 today.
- A grade cap does not help with the short-edge tail and would treat real 25 to 35% streets as
  one class.

## Bridges and tunnels

The DEM does not know about decks. Under a bridge it reads the water surface, the sea floor where
the tiles carry bathymetry (the Golden Gate Bridge reads -95 m at mid-span against a 67 m deck) or the
valley floor; over a tunnel it reads the hill. Costed as sampled, a bridge is a deep valley with a
cliff at each end, and the cube makes the crossing expensive enough to send routes round by another
bridge.

The builder therefore straightens structures. Since the first release it did so per edge: for every
edge Valhalla flags as `bridge` or `tunnel`, the interior samples were replaced by a line between the
edge's own two end samples. That is not enough, for two reasons found on the Oakland Estuary:

- **The flag misses some spans.** The graph build only flags `bridge=yes`. The main spans of the
  Park Street, Fruitvale Avenue and High Street bridges are `bridge=movable` and were costed from the
  DEM (-6 to -9 m). Across the SF region, 423 flagged bicycle edges (65 km) sag 3 m or more below
  both ends in the raw DEM, and the unflagged `bridge=movable`, `viaduct`, `cantilever` and
  `covered` edges add only a handful, so the flag is right far more often than not; but every miss
  is on a crossing with no alternative.
- **A mid-structure node is over water too.** A long bridge is several edges, and the span and its
  approaches are separate ways. The node where two bridge edges meet reads the water, so a flagged
  approach interpolated between its own ends still climbs out of the water: the Park Street approach
  (29 m, `bridge=yes`) ran from 3.2 m on the street to -1.9 m at the span, a false 8.5% grade and 285
  units, about 1.1 km of flat road in the hill-averse scenarios. Flattening the span alone would not
  have fixed the crossing.

Now `bikesy::resolve_structures` (in `bikesy_profile.h`) works on the whole graph before any edge is
costed:

1. **Members.** Every flagged edge is part of a structure. An unflagged edge of at most 250 m
   (`kStructureGapMaxLength`) whose both end nodes also touch a flagged edge is a candidate gap:
   the shape of a movable span between two `bridge=yes` approaches.
2. **Ground nodes.** Nodes are merged across hierarchy levels, so a path bridge sees the arterial it
   meets on another level. A node is ground if any edge at it is not a structure member, or if it
   lies on the data boundary or outside the tile set. Every other node of a structure is interior.
3. **Straightening.** Each interior node takes the inverse-distance weighted mean of the heights of
   the ground nodes reachable through its structure, with distance measured along the structure. On
   a simple chain this is exact linear interpolation between the two ends; a dead-end pier takes the
   height of its one ground node; a structure with no ground node (all of it on the data boundary)
   keeps its DEM heights. Every member edge is then a line between its two node heights.
4. **Gap check.** A candidate gap whose raw DEM samples do not average at least 2 m
   (`kStructureGapMinSag`) below that line is a piece of ground between two bridges, not a span; it
   is dropped and the structure is straightened again without it. In SF 704 candidates reduce to 58
   spans, in Tahoe 50 to 3.

The 35 m / 60 m filter then runs on the straightened profile as on any other, each direction by its
own pass, so an edge's two costs still do not depend on how its way was digitised.

What this does and does not do:

- The three estuary bridges cost under 2 units in every direction (they were 811, 644, 285, 248,
  166, 124 and 38 units on their approach pieces). Region-wide, SF's 14,633 structure edges fall
  from 282,000 to 129,000 units in the bicycle directions; Tahoe's 1,094 from 158,000 to 151,000.
  Outside structures nothing changes.
- Climb a bridge really has is kept between its ground ends: an approach that rises 10 m to the deck
  still costs 10 m of climb, spread along the structure. What is lost is a hump inside a structure
  whose ends are both low, such as the deck camber of a long bridge over a shipping channel; the DEM
  cannot see it either, and no route choice depends on it since the bridge is the only crossing.
- On land structures with many ground contacts (an elevated interchange), the interpolation
  redistributes cost between the pieces; the total climb between ground nodes is unchanged. Six
  bicycle edges in SF and one in Tahoe gain more than 100 units this way, the largest 1,540.
- Ordinary roads that dip into a valley are untouched: the DEM sag alone never makes an edge a
  structure, because 4,700 SF edges (2,900 km) and 2,500 Tahoe edges sag 3 m or more below both ends
  and are real valleys.
- Not fixed: a ground node whose own DEM cell is water or rock, such as the Cave Rock tunnel portals
  on US 50 (the portal sample sits in the cliff, 21 m above the road), still costs the adjoining
  edge. The graph build could also flag `bridge=movable` and the other `bridge=*` values; with this
  change that is no longer needed for the hill cost, and it would be a graph release.

## Releasing

The change affects only the policy builder. The routing engine binary is unchanged
(`valhalla_service` SHA-256 `82c32a12…`, as in `release.json`), and so is every graph tile. To
release it for a region, rebuild that region's `bikesy-policy.bin` with the new builder (a data
release; see `docs/REGIONS.md`), then run the usual gates. The policy test runs in every
`engine/build.sh`, and the engine cost test runs against the rebuilt file. Rebuilt with this
builder, the 2026-10-19 Tahoe and 2026-10-20 SF graphs pass the engine cost test, and their policy
files match the ones benchmarked above to float precision on all but two of 4.06 million edges
(both directions of one Wentworth Springs Road edge, 1.2% apart).
