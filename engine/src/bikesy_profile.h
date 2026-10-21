#pragma once
// Uphill cost of one edge's elevation profile, for the policy builder.
// Kept out of bikesy_policy.h, which the routing engine also compiles, so that
// changing this filter changes the policy data but never the engine binary.
// How the two constants were chosen: docs/HILL-COST.md.
#include "bikesy_policy.h"
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <queue>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bikesy {
// A change of direction in the profile counts only once it exceeds this many
// metres. Smaller reversals are treated as DEM noise inside a steady grade.
constexpr double kHillDeadBand = 35.0;
// Grades are never computed over a run shorter than this many metres, so a
// few metres of DEM error between two close samples cannot produce a cliff.
constexpr double kHillMinRun = 60.0;
// Bridges and tunnels (docs/HILL-COST.md, "Bridges and tunnels"): the DEM reads the water, the
// valley floor or the hill above a tunnel, not the deck, so a structure's profile is replaced by a
// straight line. The line runs between the nodes where the whole connected structure touches
// ordinary ground, not between each edge's own two samples: a mid-structure node (the join of two
// bridge edges, or the end of a movable span) is itself over water.
// An unflagged edge no longer than this joins two flagged edges as part of the same structure
// (OSM bridge=movable spans, which the graph build does not flag, sit between bridge=yes approaches)
constexpr double kStructureGapMaxLength = 250.0;
// ... provided its own DEM samples average at least this far below the straightened line. A short
// piece of ground between two bridges does not sag and is left as it is.
constexpr double kStructureGapMinSag = 2.0;

// One edge shape, for the structure pass. `a` and `b` are node indices at the shape's first and
// last sample (hierarchy levels merged); `ha` and `hb` the DEM there; `mean_raw` the mean of all
// raw samples; `flagged` is Valhalla's bridge or tunnel flag.
struct StructureEdge { uint32_t a, b; double length; bool flagged; double ha, hb, mean_raw; };
struct StructureResult {
  std::vector<char> member, gap;                  // per edge: part of a structure; an unflagged gap edge
  std::vector<std::pair<double, double>> ends;    // per edge: the heights to use at a and b (raw ends for non-members)
  size_t structures = 0;                          // connected structures straightened (interior nodes and at least one ground node)
};

namespace detail {
struct Incidence {  // CSR lists of the edges incident to each node (a loop edge is listed once)
  std::vector<uint32_t> start, edges;
  Incidence(const std::vector<StructureEdge>& e, uint32_t nodes) : start(nodes + 1, 0) {
    for (const auto& x : e) { ++start[x.a + 1]; if (x.b != x.a) ++start[x.b + 1]; }
    for (uint32_t n = 0; n < nodes; ++n) start[n + 1] += start[n];
    edges.resize(start[nodes]); std::vector<uint32_t> fill(start.begin(), start.end() - 1);
    for (uint32_t i = 0; i < e.size(); ++i) { edges[fill[e[i].a]++] = i; if (e[i].b != e[i].a) edges[fill[e[i].b]++] = i; }
  }
  template <class F> void each(uint32_t node, F f) const { for (uint32_t k = start[node]; k < start[node + 1]; ++k) f(edges[k]); }
};

// Straighten every structure (connected member edges) between its terminal nodes: a terminal is an
// open node (data boundary) or a node with an incident non-member edge. Interior node heights are the
// inverse-distance weighted mean of the terminals' DEM heights, with distances measured along the
// structure (exactly linear interpolation along a simple chain); a structure without terminals keeps
// its DEM heights. Returns the heights at a and b for every edge (raw for non-members).
inline std::vector<std::pair<double, double>> straighten_structures(const std::vector<StructureEdge>& e, const std::vector<char>& member,
                                                                    const Incidence& inc, const std::vector<char>& open, size_t* structures) {
  const uint32_t nodes = inc.start.size() - 1;
  const double nan = std::numeric_limits<double>::quiet_NaN();
  std::vector<double> h_at(nodes, nan);
  for (uint32_t i = 0; i < e.size(); ++i) if (member[i]) {
    if (std::isnan(h_at[e[i].a])) h_at[e[i].a] = e[i].ha;
    if (std::isnan(h_at[e[i].b])) h_at[e[i].b] = e[i].hb;
  }
  std::vector<char> terminal(nodes, 0), seen(nodes, 0);
  for (uint32_t n = 0; n < nodes; ++n) {
    bool any = false, all = true; inc.each(n, [&](uint32_t i) { any = true; if (!member[i]) all = false; });
    terminal[n] = open[n] || (any && !all);
  }
  std::vector<double> height(h_at);
  std::vector<uint32_t> comp, term, stack; std::vector<char> incomp(nodes, 0);
  std::vector<double> num(nodes, 0), den(nodes, 0), dist(nodes, 0);
  size_t count = 0;
  for (uint32_t s0 = 0; s0 < nodes; ++s0) {
    if (seen[s0] || terminal[s0] || std::isnan(h_at[s0])) continue;
    comp.clear(); term.clear(); stack.assign(1, s0); seen[s0] = 1;
    while (!stack.empty()) {
      uint32_t u = stack.back(); stack.pop_back(); comp.push_back(u); incomp[u] = 1;
      inc.each(u, [&](uint32_t i) { if (!member[i] || e[i].a == e[i].b) return; uint32_t v = e[i].a == u ? e[i].b : e[i].a;
        if (terminal[v]) term.push_back(v); else if (!seen[v]) { seen[v] = 1; stack.push_back(v); } });
    }
    std::sort(term.begin(), term.end()); term.erase(std::unique(term.begin(), term.end()), term.end());
    if (!term.empty()) {
      ++count;
      for (uint32_t v : comp) num[v] = den[v] = 0;
      for (uint32_t t : term) {
        // Dijkstra from t through interior nodes of this structure only (other terminals block)
        for (uint32_t v : comp) dist[v] = std::numeric_limits<double>::infinity();
        std::priority_queue<std::pair<double, uint32_t>, std::vector<std::pair<double, uint32_t>>, std::greater<>> pq;
        auto relax = [&](uint32_t u, double d) { inc.each(u, [&](uint32_t i) { if (!member[i] || e[i].a == e[i].b) return;
          uint32_t v = e[i].a == u ? e[i].b : e[i].a; if (!incomp[v]) return; double nd = d + e[i].length;
          if (nd < dist[v]) { dist[v] = nd; pq.emplace(nd, v); } }); };
        relax(t, 0.0);
        while (!pq.empty()) { auto [d, u] = pq.top(); pq.pop(); if (d > dist[u]) continue; relax(u, d); }
        for (uint32_t v : comp) if (dist[v] < std::numeric_limits<double>::infinity() && dist[v] > 0) { num[v] += h_at[t] / dist[v]; den[v] += 1.0 / dist[v]; }
      }
      for (uint32_t v : comp) if (den[v] > 0) height[v] = num[v] / den[v];
    }
    for (uint32_t v : comp) incomp[v] = 0;
  }
  if (structures) *structures = count;
  std::vector<std::pair<double, double>> ends(e.size());
  for (uint32_t i = 0; i < e.size(); ++i) ends[i] = member[i] ? std::make_pair(height[e[i].a], height[e[i].b]) : std::make_pair(e[i].ha, e[i].hb);
  return ends;
}
}  // namespace detail

// Which edges form structures and the heights to use at their ends. Flagged edges are members; an
// unflagged edge of at most kStructureGapMaxLength whose both nodes touch a flagged edge is a
// candidate gap. Structures are straightened once with the candidates, gaps whose raw samples do
// not average kStructureGapMinSag below that line are dropped, and the rest is straightened again.
// `open[node]` marks nodes at the data boundary (always terminals).
inline StructureResult resolve_structures(const std::vector<StructureEdge>& e, uint32_t nodes, const std::vector<char>& open) {
  if (open.size() != nodes) throw std::runtime_error("Invalid structure node set");
  for (const auto& x : e) if (x.a >= nodes || x.b >= nodes || !(x.length > 0)) throw std::runtime_error("Invalid structure edge");
  detail::Incidence inc(e, nodes);
  StructureResult r; r.member.assign(e.size(), 0); r.gap.assign(e.size(), 0);
  std::vector<char> touches(nodes, 0);
  for (uint32_t i = 0; i < e.size(); ++i) if (e[i].flagged) { r.member[i] = 1; touches[e[i].a] = touches[e[i].b] = 1; }
  for (uint32_t i = 0; i < e.size(); ++i)
    if (!e[i].flagged && e[i].length <= kStructureGapMaxLength && e[i].a != e[i].b && touches[e[i].a] && touches[e[i].b]) r.member[i] = r.gap[i] = 1;
  r.ends = detail::straighten_structures(e, r.member, inc, open, nullptr);
  for (uint32_t i = 0; i < e.size(); ++i)
    if (r.gap[i] && e[i].mean_raw - (r.ends[i].first + r.ends[i].second) / 2 > -kStructureGapMinSag) r.member[i] = r.gap[i] = 0;
  r.ends = detail::straighten_structures(e, r.member, inc, open, &r.structures);
  return r;
}

// The straight-line profile of a structure edge: n samples from ha to hb.
inline std::vector<double> straight_profile(double ha, double hb, size_t n) {
  std::vector<double> h(n);
  for (size_t i = 0; i < n; ++i) h[i] = ha + (hb - ha) * double(i) / (n - 1);
  return h;
}

// Indices of the profile's turning points: the first and last samples, plus
// every extreme that the profile then leaves by at least `band` metres.
inline std::vector<size_t> hill_turning_points(const std::vector<double>& h, double band) {
  std::vector<size_t> at{0};
  int dir = 0; size_t ext = 0;
  for (size_t i = 1; i < h.size(); ++i) {
    if (dir == 0) {
      if (h[i] - h[0] >= band) { dir = 1; ext = i; }
      else if (h[0] - h[i] >= band) { dir = -1; ext = i; }
    } else if (dir == 1) {
      if (h[i] >= h[ext]) ext = i;
      else if (h[ext] - h[i] >= band) { at.push_back(ext); dir = -1; ext = i; }
    } else {
      if (h[i] <= h[ext]) ext = i;
      else if (h[i] - h[ext] >= band) { at.push_back(ext); dir = 1; ext = i; }
    }
  }
  if (at.back() != h.size() - 1) at.push_back(h.size() - 1);
  return at;
}

// Uphill cost of travelling a profile from its first sample to its last: the
// convex grade integral of the mean grade between consecutive turning points.
// `segments`, if given, receives the number of turning-point segments.
inline double profile_uphill_one_way(const std::vector<double>& h, double ds, double band, double min_run,
                                     size_t* segments = nullptr) {
  const auto at = hill_turning_points(h, band);
  double cost = 0;
  for (size_t j = 1; j < at.size(); ++j) {
    const double run = std::max(ds * (at[j] - at[j - 1]), min_run);
    cost += positive_grade_integral(h[at[j]] - h[at[j - 1]], run);
  }
  if (segments) *segments = at.size() - 1;
  return cost;
}

// Forward and reverse uphill cost of a profile sampled at equal spacing along
// an edge of `length` metres. The filter is directional (hysteresis), so each
// direction is costed by its own pass in its own travel order: the reverse cost
// is the forward cost of the reversed profile. That makes the result independent
// of which way the way was digitised: profile_uphill(reverse(h)) == {rev, fw}.
// `segments`, if given, receives the forward pass's segment count.
inline std::pair<double, double> profile_uphill(const std::vector<double>& h, double length,
                                                double band = kHillDeadBand, double min_run = kHillMinRun,
                                                size_t* segments = nullptr) {
  if (h.size() < 2 || !(length > 0)) throw std::runtime_error("Invalid Bikesy elevation profile");
  const double ds = length / (h.size() - 1);
  const double fw = profile_uphill_one_way(h, ds, band, min_run, segments);
  const std::vector<double> r(h.rbegin(), h.rend());
  return {fw, profile_uphill_one_way(r, ds, band, min_run)};
}
}
