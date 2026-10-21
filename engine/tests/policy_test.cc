#include "bikesy_policy.h"
#include "bikesy_profile.h"
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
 // The reverse cost is the forward cost of the mirrored profile: same turning points, climbs and descents swapped.
 {std::vector<double> h{1900,1912,1960,1900,1990,1940,2001},m;for(double x:h)m.push_back(-x);
  auto a=profile_uphill(h,180),b=profile_uphill(m,180);require(near(a.first,b.second)&&near(a.second,b.first)&&a.first>0&&a.second>0);}
 std::cout<<"positive-only convex grade, profile filter and conservative connectivity tests passed\n";
}
