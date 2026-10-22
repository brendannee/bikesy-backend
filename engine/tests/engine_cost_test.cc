#include "bikesy_policy.h"
#include "config.h"
#include "sif/bicyclecost.h"
#include "sif/dynamiccost.h"
#include <iostream>
void require(bool b,const char* msg){if(!b)throw std::runtime_error(msg);}
valhalla::sif::cost_ptr_t model(float roads,float hills,const std::string& extra=""){
 valhalla::Costing c;rapidjson::Document d;
 std::string s="{\"bicycle\":{\"bicycle_type\":\"Hybrid\",\"use_roads\":"+std::to_string(roads)+",\"use_hills\":"+std::to_string(hills)+",\"use_ferry\":0"+extra+"}}";
 d.Parse(s.c_str());valhalla::sif::ParseBicycleCostOptions(d,"/bicycle",&c);return valhalla::sif::CreateBicycleCost(c);
}
bool same(const valhalla::sif::Cost& a,const valhalla::sif::Cost& b){return a.cost==b.cost&&a.secs==b.secs;}
bool near(float a,float b){return std::abs(a-b)<std::max(.01f,std::abs(b)*.0001f);}
// A difference of two float costs: allow for the rounding of the larger total (steep edges).
bool near_diff(float a,float b,float total){return std::abs(a-b)<std::max({.01f,std::abs(b)*.0001f,std::abs(total)*1e-6f});}
int main(int argc,char**argv){try{
 using namespace valhalla;using namespace baldr;
 GraphReader reader(valhalla::config(argv[1]).get_child("mjolnir"));auto avoid=model(.5,0),ignore=model(.5,1),direct=model(1,1);
 require(avoid->AStarCostFactor()==0&&direct->AStarCostFactor()==0,"Heuristic must remain admissible");
 // Two-class surface preference (unpaved_penalty/paved_penalty); absent keys keep the stock term.
 auto flat=model(.5,.5,",\"avoid_bad_surfaces\":0"),zero=model(.5,.5,",\"avoid_bad_surfaces\":0,\"unpaved_penalty\":0,\"paved_penalty\":0");
 auto stock=model(.5,.5),unpaved=model(.5,.5,",\"unpaved_penalty\":2.5"),paved=model(.5,.5,",\"paved_penalty\":1"),both=model(.5,.5,",\"unpaved_penalty\":2,\"paved_penalty\":0.5");
 auto direct_surface=model(1,1,",\"unpaved_penalty\":3");
 // Busy-road preference (busy_penalty/busy_lane_relief); absent keys, or neutral values, keep stock costs.
 auto quiet=model(.1,.5,",\"unpaved_penalty\":1"),quiet_neutral=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":0,\"busy_lane_relief\":1");
 auto quiet_pen=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":0.5"),quiet_half=model(.1,.5,",\"unpaved_penalty\":1,\"busy_lane_relief\":0.5");
 auto quiet_none=model(.1,.5,",\"unpaved_penalty\":1,\"busy_lane_relief\":0"),quiet_both=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":0.5,\"busy_lane_relief\":0.5");
 auto quiet_town=model(.1,.5,",\"unpaved_penalty\":1,\"busy_town_penalty\":2"),quiet_cfg=model(.1,.5,",\"unpaved_penalty\":1,\"busy_town_penalty\":2,\"busy_lane_relief\":0.5");
 auto quiet_town0=model(.1,.5,",\"unpaved_penalty\":1,\"busy_town_penalty\":0");
 size_t busy_edges=0,busy_lane_edges=0,town_edges=0;
 const float kStock[]={1.0f,2.5f,4.5f,7.0f};
 size_t uphill=0,downhill=0,mixed=0,total=0,unpaved_edges=0,paved_edges=0;
 for(auto id:reader.GetTileSet()){auto tile=reader.GetGraphTile(id);
  for(uint32_t i=0;i<tile->header()->directededgecount();++i){auto edge=tile->directededge(i);if(edge->is_shortcut()||edge->use()==Use::kFerry||edge->use()==Use::kRailFerry)continue;
   uint8_t flow=0;auto a=avoid->EdgeCost(edge,tile,TimeInfo::invalid(),flow),b=ignore->EdgeCost(edge,tile,TimeInfo::invalid(),flow),c=direct->EdgeCost(edge,tile,TimeInfo::invalid(),flow);float g=bikesy::policy().uphill(edge,tile);
   require(a.cost>=b.cost,"Uphill avoidance gave credit");if(edge->use()==Use::kSteps){require(c.cost>edge->length(),"Direct Ignore omitted stair burden");}else require(std::abs(c.cost-edge->length())<.01,"Nonstair Direct Ignore not distance");require(a.secs==b.secs,"Hill preference altered ETA speed");
   require(std::abs((a.cost-b.cost)-4*g)<std::max(.01f,4*g*.0001f),"Actual engine cost differs from positive grade integral");
   graph_tile_ptr other;auto opposite=reader.GetOpposingEdge(edge,other);if(opposite&&other){float reverse=bikesy::policy().uphill(opposite,other);if(g==0&&reverse>0){require(a.cost==b.cost,"Downhill penalized");++downhill;}if(g>0)++uphill;if(g>0&&reverse>0)++mixed;}
   auto f=flat->EdgeCost(edge,tile,TimeInfo::invalid(),flow),z=zero->EdgeCost(edge,tile,TimeInfo::invalid(),flow),s=stock->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
   auto u=unpaved->EdgeCost(edge,tile,TimeInfo::invalid(),flow),p=paved->EdgeCost(edge,tile,TimeInfo::invalid(),flow),m=both->EdgeCost(edge,tile,TimeInfo::invalid(),flow),ds=direct_surface->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
   require(same(f,z),"Zero surface-class penalties differ from no surface term");
   require(s.secs==f.secs&&u.secs==f.secs&&p.secs==f.secs&&m.secs==f.secs,"Surface preference altered ETA speed");
   float len=edge->length();bool is_paved=edge->surface()<=Surface::kPavedRough;
   if(edge->use()==Use::kSteps){
    require(same(s,f)&&same(u,f)&&same(p,f)&&same(m,f)&&same(ds,c),"Surface preference changed stair cost");
   }else{
    // Stock Hybrid term: avoid_bad_surfaces (default 0.25) times kSurfaceFactors from kDirt.
    float expected=edge->surface()>=Surface::kDirt?len*.25f*kStock[static_cast<uint32_t>(edge->surface())-static_cast<uint32_t>(Surface::kDirt)]:0.f;
    require(near(s.cost-f.cost,expected),"Stock avoid_bad_surfaces term changed");
    require(near(u.cost-f.cost,is_paved?0.f:2.5f*len),"unpaved_penalty is not an additive factor on unpaved edges");
    require(near(p.cost-f.cost,is_paved?1.f*len:0.f),"paved_penalty is not an additive factor on paved edges");
    require(near(m.cost-f.cost,is_paved?.5f*len:2.f*len),"Combined surface-class penalties wrong");
    require(near(ds.cost,is_paved?len:4.f*len),"Shortest mode ignored the surface preference");
    if(is_paved)++paved_edges;else ++unpaved_edges;
    auto q=quiet->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qn=quiet_neutral->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    auto qp=quiet_pen->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qh=quiet_half->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    auto q0=quiet_none->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qb=quiet_both->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    require(same(q,qn),"Neutral busy-road values differ from no busy-road keys");
    auto qt=quiet_town->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qc=quiet_cfg->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qt0=quiet_town0->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    require(same(qt0,q),"busy_town_penalty 0 differs from no busy-road keys");
    require(qp.secs==q.secs&&qh.secs==q.secs&&q0.secs==q.secs&&qb.secs==q.secs,"Busy-road preference altered ETA speed");
    const bool road_use=edge->use()==Use::kRoad||edge->use()==Use::kRamp||edge->use()==Use::kTurnChannel;
    const float w=edge->classification()<=baldr::RoadClass::kSecondary&&road_use?std::min(1.f,std::max(0.f,(float(edge->speed())-40.f)/16.f)):0.f;
    require(near_diff(qp.cost-q.cost,.5f*w*len,qp.cost),"busy_penalty is not an additive factor on busy roads");
    if(w==0)require(same(qh,q)&&same(q0,q)&&same(qb,q),"Busy-road preference changed a non-busy edge");
    // Less relief never makes an edge cheaper, and a lane keeps some relief unless it is 0.
    require(qh.cost>=q.cost-.01f&&q0.cost>=qh.cost-.01f,"busy_lane_relief gave credit");
    require(near_diff(qb.cost-qh.cost,.5f*w*len,qb.cost),"busy_penalty does not add to the reduced relief");
    const float town=std::min(1.f,std::max(0.f,(float(edge->density())-2.f)/3.f));
    require(near_diff(qt.cost-q.cost,2.f*w*town*len,qt.cost),"busy_town_penalty is not a town-weighted additive factor");
    require(near_diff(qc.cost-qh.cost,2.f*w*town*len,qc.cost),"busy_town_penalty does not add to the reduced relief");
    if(w>0&&town>0)++town_edges;
    if(w>0){++busy_edges;if(int(edge->cyclelane())>=2||edge->shoulder())++busy_lane_edges;}
   }
   ++total;
  }
 }
 require(uphill>100&&downhill>100&&mixed>100,"Insufficient real grade/reversal coverage");
 require(paved_edges>100&&unpaved_edges>100,"Insufficient paved/unpaved surface coverage");
 require(busy_edges>100&&busy_lane_edges>100&&town_edges>100,"Insufficient busy-road coverage");
 std::cout<<"{\"passed\":true,\"edges_checked\":"<<total<<",\"uphill\":"<<uphill<<",\"downhill_only\":"<<downhill<<",\"mixed_grade\":"<<mixed<<",\"paved\":"<<paved_edges<<",\"unpaved\":"<<unpaved_edges<<",\"busy\":"<<busy_edges<<",\"busy_with_lane\":"<<busy_lane_edges<<",\"busy_in_town\":"<<town_edges<<"}\n";
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
