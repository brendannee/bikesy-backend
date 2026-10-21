#include "bikesy_policy.h"
#include "bikesy_profile.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
void require(bool b){if(!b)throw std::runtime_error("Policy test failed");}
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
 std::cout<<"positive-only convex grade, profile filter and conservative connectivity tests passed\n";
}
