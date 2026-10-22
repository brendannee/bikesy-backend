#include "bikesy_policy.h"
#include "config.h"
#include "sif/bicyclecost.h"
#include "sif/dynamiccost.h"
#include <iostream>
#include <utility>
#include <vector>
void require(bool b,const char* msg){if(!b)throw std::runtime_error(msg);}
valhalla::sif::cost_ptr_t model(float roads,float hills,const std::string& extra="",const std::string& type="Hybrid"){
 valhalla::Costing c;rapidjson::Document d;
 std::string s="{\"bicycle\":{\"bicycle_type\":\""+type+"\",\"use_roads\":"+std::to_string(roads)+",\"use_hills\":"+std::to_string(hills)+",\"use_ferry\":0"+extra+"}}";
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
 // Busy-road preference (busy_penalty); an absent key, or 0, keeps stock costs.
 auto quiet=model(.1,.5,",\"unpaved_penalty\":1"),quiet_neutral=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":0");
 auto quiet_pen=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":0.5"),quiet_cfg=model(.1,.5,",\"unpaved_penalty\":1,\"busy_penalty\":2");
 // Busy penalty on other bicycle types and with the stock avoid_bad_surfaces term: each is a
 // (base, base + busy_penalty 1.5) pair, so the difference must be 1.5 * weight * length.
 const float kBusyK=1.5f;
 std::vector<std::pair<valhalla::sif::cost_ptr_t,valhalla::sif::cost_ptr_t>> busy_variants;
 for(const char* type:{"Road","Mountain"})busy_variants.push_back({model(.1,.5,"",type),model(.1,.5,",\"busy_penalty\":1.5",type)});
 busy_variants.push_back({model(.1,.5,",\"avoid_bad_surfaces\":1"),model(.1,.5,",\"avoid_bad_surfaces\":1,\"busy_penalty\":1.5")});
 busy_variants.push_back({model(.1,.5,",\"avoid_bad_surfaces\":1,\"unpaved_penalty\":1","Road"),model(.1,.5,",\"avoid_bad_surfaces\":1,\"unpaved_penalty\":1,\"busy_penalty\":1.5","Road")});
 // Shortest modes are pure distance: the busy key must change nothing (implicit: use_roads 1, use_hills 1).
 auto short_plain=model(.1,.5,",\"shortest\":true"),short_busy=model(.1,.5,",\"shortest\":true,\"busy_penalty\":2"),direct_busy=model(1,1,",\"busy_penalty\":2");
 size_t busy_edges=0,busy_lane_edges=0,busy_variant_edges=0;
 const float kStock[]={1.0f,2.5f,4.5f,7.0f};
 size_t uphill=0,downhill=0,mixed=0,total=0,unpaved_edges=0,paved_edges=0;
 for(auto id:reader.GetTileSet()){auto tile=reader.GetGraphTile(id);
  for(uint32_t i=0;i<tile->header()->directededgecount();++i){auto edge=tile->directededge(i);if(edge->is_shortcut()||edge->use()==Use::kFerry||edge->use()==Use::kRailFerry)continue;
   uint8_t flow=0;auto a=avoid->EdgeCost(edge,tile,TimeInfo::invalid(),flow),b=ignore->EdgeCost(edge,tile,TimeInfo::invalid(),flow),c=direct->EdgeCost(edge,tile,TimeInfo::invalid(),flow);float g=bikesy::policy().uphill(edge,tile);
   {auto sp=short_plain->EdgeCost(edge,tile,TimeInfo::invalid(),flow),sb=short_busy->EdgeCost(edge,tile,TimeInfo::invalid(),flow),db=direct_busy->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    require(same(sp,sb),"busy_penalty changed explicit shortest mode");require(same(c,db),"busy_penalty changed implicit shortest (Direct) mode");}
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
    auto qp=quiet_pen->EdgeCost(edge,tile,TimeInfo::invalid(),flow),qc=quiet_cfg->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
    require(same(q,qn),"busy_penalty 0 differs from no busy-road key");
    require(qp.secs==q.secs&&qc.secs==q.secs,"Busy-road preference altered ETA speed");
    const bool road_use=edge->use()==Use::kRoad||edge->use()==Use::kRamp||edge->use()==Use::kTurnChannel;
    const float w=edge->classification()<=baldr::RoadClass::kSecondary&&road_use?std::min(1.f,std::max(0.f,(float(edge->speed())-40.f)/16.f)):0.f;
    require(near_diff(qp.cost-q.cost,.5f*w*len,qp.cost),"busy_penalty is not an additive factor on busy roads");
    require(near_diff(qc.cost-q.cost,2.f*w*len,qc.cost),"busy_penalty does not scale with its value");
    if(w==0)require(same(qp,q)&&same(qc,q),"Busy-road preference changed a non-busy edge");
    for(auto& v:busy_variants){
     auto vb=v.first->EdgeCost(edge,tile,TimeInfo::invalid(),flow),vp=v.second->EdgeCost(edge,tile,TimeInfo::invalid(),flow);
     require(vb.secs==vp.secs,"Busy-road preference altered ETA speed (bicycle type)");
     require(near_diff(vp.cost-vb.cost,kBusyK*w*len,vp.cost),"busy_penalty is not an additive factor on busy roads (bicycle type or avoid_bad_surfaces)");
    }
    if(w>0){++busy_variant_edges;++busy_edges;if(int(edge->cyclelane())>=2||edge->shoulder())++busy_lane_edges;}
   }
   ++total;
  }
 }
 require(uphill>100&&downhill>100&&mixed>100,"Insufficient real grade/reversal coverage");
 require(paved_edges>100&&unpaved_edges>100,"Insufficient paved/unpaved surface coverage");
 require(busy_edges>100&&busy_lane_edges>100&&busy_variant_edges>100,"Insufficient busy-road coverage");
 std::cout<<"{\"passed\":true,\"edges_checked\":"<<total<<",\"uphill\":"<<uphill<<",\"downhill_only\":"<<downhill<<",\"mixed_grade\":"<<mixed<<",\"paved\":"<<paved_edges<<",\"unpaved\":"<<unpaved_edges<<",\"busy\":"<<busy_edges<<",\"busy_with_lane\":"<<busy_lane_edges<<"}\n";
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
