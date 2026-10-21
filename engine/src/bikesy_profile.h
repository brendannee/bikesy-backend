#pragma once
// Uphill cost of one edge's elevation profile, for the policy builder.
// Kept out of bikesy_policy.h, which the routing engine also compiles, so that
// changing this filter changes the policy data but never the engine binary.
// How the two constants were chosen: docs/HILL-COST.md.
#include "bikesy_policy.h"
#include <algorithm>
#include <cstddef>
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
