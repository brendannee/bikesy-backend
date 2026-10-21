#include "bikesy_policy.h"
#include "bikesy_profile.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
void require_at(bool b,int line){if(!b)throw std::runtime_error("Policy test failed at line "+std::to_string(line));}
#define require(b) require_at((b),__LINE__)
int main(){
 using namespace bikesy;
 require(positive_grade_integral(0,100)==0);require(positive_grade_integral(-10,100)==0);
 require(positive_grade_integral(10,100)>positive_grade_integral(10,500));
 const double flat=200,undulating=200+4*(positive_grade_integral(-10,100)+positive_grade_integral(10,100));require(undulating>flat);
 // Reversal exchanges ascent and descent, never subtracts either uphill cost.
 require(positive_grade_integral(10,100)+positive_grade_integral(-10,100)==positive_grade_integral(-10,100)+positive_grade_integral(10,100));
 require(proves_disconnected({1},{2}));require(proves_disconnected({1|kOpen},{2}));
 require(!proves_disconnected({1|kOpen},{2|kOpen}));require(!proves_disconnected({1},{1|kOpen}));
 require(!proves_disconnected({1,2},{2}));require(!proves_disconnected({},{2}));
 // Profile filter (bikesy_profile.h): samples every 30 m like the builder.
 auto ramp=[](size_t n,double step){std::vector<double> h(n);for(size_t i=0;i<n;++i)h[i]=1900+step*i;return h;};
 const double eps=1e-9;auto near=[&](double a,double b){return std::abs(a-b)<=eps*std::max(1.0,std::abs(b));};
 // A steady climb is costed as one segment, whatever the band.
 {auto h=ramp(21,1.5);auto c=profile_uphill(h,600);require(near(c.first,positive_grade_integral(30,600))&&c.second==0);}
 // DEM noise: a 20 m bump inside a flat 600 m edge is ignored entirely.
 {auto h=ramp(21,0);h[9]+=10;h[10]+=20;h[11]+=10;auto c=profile_uphill(h,600);require(c.first==0&&c.second==0);
  require(profile_uphill(h,600,0,0).first>0);}
 // A real hump larger than the band is kept: 80 m up then 80 m down, costed both ways.
 {std::vector<double> h;for(int i=0;i<=20;++i)h.push_back(1900+4.0*i);for(int i=19;i>=0;--i)h.push_back(1900+4.0*i);
  auto c=profile_uphill(h,1200);require(near(c.first,positive_grade_integral(80,600))&&near(c.second,c.first));}
 // A reversal of exactly the band counts; one metre less does not.
 {std::vector<double> h{1900,1900+kHillDeadBand,1900};auto c=profile_uphill(h,600);require(near(c.first,positive_grade_integral(kHillDeadBand,300)));
  std::vector<double> g{1900,1900+kHillDeadBand-1,1900};require(profile_uphill(g,600).first==0);}
 // Short edges: grade is computed over at least kHillMinRun metres.
 {std::vector<double> h{1900,1903};require(near(profile_uphill(h,30).first,positive_grade_integral(3,kHillMinRun)));
  require(profile_uphill(h,30).first<positive_grade_integral(3,30));
  require(near(profile_uphill(h,200).first,positive_grade_integral(3,200)));}
// Orientation: the hysteresis is directional, so each direction is costed by its own pass and
// reversing the samples exchanges the two costs exactly. Humps near the band size are where a
// single shared pass would disagree with itself.
{auto flip=[](std::vector<double> h){std::reverse(h.begin(),h.end());return h;};
 const std::vector<std::vector<double>> cases{
  {1900,1930,1900,1935,1900},{1900,1935,1900,1930,1900},
  {1900,1912,1960,1900,1990,1940,2001},
  {1900,1934,1902,1938,1899,1936,1905,1940,1900,1937,1950,1912,1948,1910,1990,1951,1960},
  {1900,1936,1901,1934,1903,1937,1900,1939,1904,1936,1900},{1900,1903},ramp(9,-2)};
 for(const auto& h:cases){const double len=30.0*(h.size()-1);
  const auto a=profile_uphill(h,len),b=profile_uphill(flip(h),len);
  require(a.first==b.second&&a.second==b.first);
  // The reverse cost is the forward cost of the reversed profile, from a pass of its own.
  require(a.second==profile_uphill(flip(h),len).first);}
 // Mirrored heights still swap ascent and descent for a symmetric profile.
 std::vector<double> h{1900,1912,1960,1900,1990,1940,2001},m;for(double x:h)m.push_back(-x);
 auto a=profile_uphill(h,180),b=profile_uphill(m,180);require(a.first>0&&a.second>0&&b.first>0&&b.second>0);
 // The segment count is the forward pass's.
 size_t seg=0;profile_uphill(h,180,kHillDeadBand,kHillMinRun,&seg);require(seg==hill_turning_points(h,kHillDeadBand).size()-1);}
 // Structures (bikesy_profile.h, resolve_structures): bridges and tunnels straightened between ground nodes.
 {auto E=[](uint32_t a,uint32_t b,double len,bool flagged,double ha,double hb,double mean_raw){return StructureEdge{a,b,len,flagged,ha,hb,mean_raw};};
  auto line_cost=[&](const std::pair<double,double>& ends,double len){return profile_uphill(straight_profile(ends.first,ends.second,size_t(std::ceil(len/30.0))+1),len);};
  // A movable bridge: street (3 m) - flagged approach - mid node over water (-2 m) - unflagged span (DEM -6 m) - mid node (-2 m) - flagged approach - street (3 m).
  // Nodes: 0 street west, 1 and 2 over water, 3 street east, 4 and 5 ordinary streets beyond.
  {std::vector<StructureEdge> e{E(4,0,100,false,3,3,3),E(0,1,29,true,3.2,-1.9,0.65),E(1,2,86,false,-1.9,-1.7,-4.0),E(2,3,23,true,-1.7,2.5,0.4),E(3,5,100,false,2.5,2.5,2.5)};
   auto r=resolve_structures(e,6,std::vector<char>(6,0));
   require(r.member[1]&&r.member[2]&&r.member[3]&&r.gap[2]&&!r.member[0]&&!r.member[4]&&r.structures==1);
   // the whole structure runs straight from 3.2 to 2.5: every piece is nearly level, no false ramp either way
   require(near(r.ends[1].first,3.2)&&near(r.ends[3].second,2.5));
   require(r.ends[1].second<3.2&&r.ends[1].second>2.5&&r.ends[2].second<r.ends[1].second);
   for(int i=1;i<=3;++i){auto c=line_cost(r.ends[i],e[i].length);require(c.first<1&&c.second<1);}
   // per-edge flattening (the previous builder) left the approaches as false ramps
   require(profile_uphill(straight_profile(-1.9,3.2,2),29).first>250);
   // linear along the chain: the mid nodes sit on the line between the street ends by distance
   require(near(r.ends[1].second,3.2+(2.5-3.2)*29/138.0)&&near(r.ends[2].second,3.2+(2.5-3.2)*115/138.0));
   // orientation: digitising every edge the other way swaps the ends and leaves the structure alone
   std::vector<StructureEdge> f;for(auto x:e)f.push_back(E(x.b,x.a,x.length,x.flagged,x.hb,x.ha,x.mean_raw));
   auto q=resolve_structures(f,6,std::vector<char>(6,0));
   for(size_t i=0;i<e.size();++i){require(q.member[i]==r.member[i]&&q.gap[i]==r.gap[i]);require(q.ends[i].first==r.ends[i].second&&q.ends[i].second==r.ends[i].first);
    auto c=line_cost(r.ends[i],e[i].length),d=line_cost(q.ends[i],f[i].length);require(c.first==d.second&&c.second==d.first);}}
  // A gap that does not sag is ground between two bridges and is left alone (a real dip is kept).
  {std::vector<StructureEdge> e{E(4,0,100,false,10,10,10),E(0,1,20,true,10,9,9.5),E(1,2,60,false,9,9,8.5),E(2,3,20,true,9,10,9.5),E(3,5,100,false,10,10,10)};
   auto r=resolve_structures(e,6,std::vector<char>(6,0));
   require(!r.member[2]&&!r.gap[2]&&r.member[1]&&r.member[3]&&r.structures==0);
   require(near(r.ends[2].first,9)&&near(r.ends[2].second,9)&&near(r.ends[1].second,9));
   // an unflagged road that dips with no bridge at either end is never touched
   std::vector<StructureEdge> g{E(0,1,300,false,20,20,12),E(1,2,300,false,20,20,12)};auto s=resolve_structures(g,3,std::vector<char>(3,0));
   require(!s.member[0]&&!s.member[1]&&s.ends[0].first==20&&s.ends[0].second==20);}
  // Approach ramp: a bridge that climbs from 3 m to 13 m keeps its climb, spread over the whole structure.
  {std::vector<StructureEdge> e{E(4,0,100,false,3,3,3),E(0,1,100,true,3,-5,-1),E(1,2,100,true,-5,-5,-5),E(2,3,100,true,-5,13,4),E(3,5,100,false,13,13,13)};
   auto r=resolve_structures(e,6,std::vector<char>(6,0));
   require(near(r.ends[1].second,3+10/3.0)&&near(r.ends[2].second,3+20/3.0));
   double up=0;for(int i=1;i<=3;++i)up+=r.ends[i].second-r.ends[i].first;require(near(up,10));
   double cost=0;for(int i=1;i<=3;++i)cost+=line_cost(r.ends[i],100).first;require(near(cost,3*positive_grade_integral(10/3.0,100)));
   // the previous builder costed the last edge as an 18 m cliff
   require(profile_uphill(straight_profile(-5,13,5),100).first>cost*5);}
  // Tunnel: the DEM reads the hill above; the structure is level between its portals.
  {std::vector<StructureEdge> e{E(3,0,100,false,10,10,10),E(0,1,200,true,10,60,40),E(1,2,200,true,60,10,40),E(2,4,100,false,10,10,10)};
   auto r=resolve_structures(e,5,std::vector<char>(5,0));require(near(r.ends[1].second,10)&&near(r.ends[2].first,10));
   require(line_cost(r.ends[1],200).first==0&&line_cost(r.ends[2],200).second==0);}
  // Dead end over water (a pier): one terminal, everything takes its height.
  {std::vector<StructureEdge> e{E(3,0,100,false,2,2,2),E(0,1,50,true,2,-3,-1),E(1,2,50,true,-3,-3,-3)};
   auto r=resolve_structures(e,4,std::vector<char>(4,0));require(near(r.ends[1].second,2)&&near(r.ends[2].first,2)&&near(r.ends[2].second,2));}
  // Open node: the data boundary ends a structure where it is.
  {std::vector<StructureEdge> e{E(0,1,100,true,5,-9,-2),E(1,2,100,true,-9,5,-2)};std::vector<char> open{1,0,1};
   auto r=resolve_structures(e,3,open);require(near(r.ends[0].second,5)&&near(r.ends[1].first,5));
   std::vector<char> closed(3,0);auto s=resolve_structures(e,3,closed);require(s.structures==0&&near(s.ends[0].second,-9));}  // no terminal: left as sampled
  // Gaps are bounded: a long unflagged edge between two bridges is not a span.
  {std::vector<StructureEdge> e{E(4,0,100,false,3,3,3),E(0,1,29,true,3.2,-1.9,0.65),E(1,2,kStructureGapMaxLength+1,false,-1.9,-1.7,-4.0),E(2,3,23,true,-1.7,2.5,0.4),E(3,5,100,false,2.5,2.5,2.5)};
   auto r=resolve_structures(e,6,std::vector<char>(6,0));require(!r.member[2]&&near(r.ends[1].second,-1.9));}
  // Invalid input is refused.
  {bool thrown=false;try{resolve_structures({E(0,7,10,true,0,0,0)},2,std::vector<char>(2,0));}catch(const std::exception&){thrown=true;}require(thrown);}}
 std::cout<<"positive-only convex grade, profile filter, structure straightening and conservative connectivity tests passed\n";
}
