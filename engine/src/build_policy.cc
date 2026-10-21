#include "bikesy_policy.h"
#include "bikesy_profile.h"
#include "config.h"
#include "skadi/sample.h"
#include "midgard/util.h"
#include <iostream>
#include <numeric>
using namespace valhalla;using namespace valhalla::baldr;
int main(int argc,char** argv){try{
 if(argc!=7)throw std::runtime_error("Usage: build_policy config output west south east north");
 const auto config=valhalla::config(argv[1]);GraphReader reader(config.get_child("mjolnir"));
 std::cerr<<"reader ready\n";skadi::sample dem(config.get<std::string>("additional_data.elevation"));std::cerr<<"dem ready\n";double west=std::stod(argv[3]),south=std::stod(argv[4]),east=std::stod(argv[5]),north=std::stod(argv[6]);
 std::vector<GraphId> ids;for(auto id:reader.GetTileSet())ids.push_back(id);std::sort(ids.begin(),ids.end(),[](auto a,auto b){return a.value<b.value;});
 std::cerr<<"tiles "<<ids.size()<<"\n";std::vector<bikesy::Tile> index;std::unordered_map<uint64_t,uint32_t> lookup;uint32_t nn=0,ne=0;
 for(auto id:ids){auto tile=reader.GetGraphTile(id);if(!tile)throw std::runtime_error("Missing input tile");lookup[id.value]=index.size();index.push_back({id.value,nn,tile->header()->nodecount(),ne,tile->header()->directededgecount()});nn+=tile->header()->nodecount();ne+=tile->header()->directededgecount();}
 std::cerr<<"indexed "<<nn<<" nodes\n";if(nn>=bikesy::kOpen)throw std::runtime_error("Too many nodes");
 std::vector<uint32_t> parent(nn),size(nn,1);std::iota(parent.begin(),parent.end(),0);std::vector<bool> open(nn,false);std::vector<float> uphill(ne);
 auto root=[&](uint32_t v){while(parent[v]!=v){parent[v]=parent[parent[v]];v=parent[v];}return v;};
 auto nodeidx=[&](GraphId id)->uint32_t{auto it=lookup.find(id.Tile_Base().value);if(it==lookup.end()||id.id()>=index[it->second].node_count)return UINT32_MAX;return index[it->second].nodes+id.id();};
 auto join=[&](uint32_t a,GraphId target){uint32_t b=nodeidx(target);if(b==UINT32_MAX){open[a]=true;return;}a=root(a);b=root(b);if(a!=b){if(size[a]<size[b])std::swap(a,b);parent[b]=a;size[a]+=size[b];}};
 uint64_t ferry_edges=0,segments=0;
 for(const auto& entry:index){std::cerr<<"begin tile "<<entry.id<<"\n";auto tile=reader.GetGraphTile(GraphId(entry.id));
  for(uint32_t n=0;n<entry.node_count;++n){auto node=tile->node(n);uint32_t idx=entry.nodes+n;auto ll=node->latlng(tile->header()->base_ll());
   // Components touching the data-buffer boundary cannot establish exterior disconnection.
   if(ll.lng()<=west+.001||ll.lng()>=east-.001||ll.lat()<=south+.001||ll.lat()>=north-.001)open[idx]=true;
   for(auto trans:tile->GetNodeTransitions(node))join(idx,trans.endnode());
   for(uint32_t e=node->edge_index();e<node->edge_index()+node->edge_count();++e){auto edge=tile->directededge(e);
    if(edge->use()==Use::kFerry||edge->use()==Use::kRailFerry){++ferry_edges;continue;}
    // Over-approximation: include all modes/directions/restrictions, ensuring no false bicycle disconnection.
    join(idx,edge->endnode());
   }
  }
  std::unordered_map<uint32_t,std::pair<float,float>> profiles;
  for(uint32_t e=0;e<entry.edge_count;++e){auto edge=tile->directededge(e);
   if(edge->use()==Use::kFerry||edge->use()==Use::kRailFerry||edge->is_shortcut())continue;
   auto off=edge->edgeinfo_offset();auto found=profiles.find(off);
   if(found==profiles.end()){
    auto shape=tile->edgeinfo(edge).shape();double length=edge->length();
    if(length<=0){profiles.emplace(off,std::make_pair(0.f,0.f));continue;}
    uint32_t count=std::max(2u,uint32_t(std::ceil(length/30.0))+1);
    auto sampled=midgard::uniform_resample_spherical_polyline(shape,length,count);auto heights=dem.get_all(sampled);
    if(heights.size()<2)throw std::runtime_error("Missing elevation samples");
    if(edge->bridge()||edge->tunnel()){
     for(size_t i=1;i+1<heights.size();++i)heights[i]=heights.front()+(heights.back()-heights.front())*double(i)/(heights.size()-1);
    }
    for(double h:heights)if(!std::isfinite(h)||h<=-32768)throw std::runtime_error("Missing DEM elevation");
    // Dead-band and minimum run: see bikesy_profile.h and docs/HILL-COST.md.
    size_t profile_segments=0;const auto [fw,rev]=bikesy::profile_uphill(heights,length,bikesy::kHillDeadBand,bikesy::kHillMinRun,&profile_segments);segments+=profile_segments;
    found=profiles.emplace(off,std::make_pair(float(fw),float(rev))).first;
   }
   uphill[entry.edges+e]=edge->forward()?found->second.first:found->second.second;
  }
  std::cerr<<"policy tile "<<entry.id<<" nodes "<<entry.node_count<<" edges "<<entry.edge_count<<"\n";
 }
 std::vector<bool> roots_open(nn,false);for(uint32_t i=0;i<nn;++i)if(open[i])roots_open[root(i)]=true;
 std::vector<uint32_t> components(nn);uint32_t closed_nodes=0;
 for(uint32_t i=0;i<nn;++i){uint32_t r=root(i);components[i]=r|(roots_open[r]?bikesy::kOpen:0);if(!roots_open[r])++closed_nodes;}
 std::ofstream f(argv[2],std::ios::binary);uint64_t magic=bikesy::kMagic;uint32_t nt=index.size();f.write((char*)&magic,8);f.write((char*)&nt,4);f.write((char*)&nn,4);f.write((char*)&ne,4);for(auto t:index)f.write((char*)&t,sizeof t);f.write((char*)components.data(),nn*4);f.write((char*)uphill.data(),ne*4);if(!f)throw std::runtime_error("Policy write failed");
 std::cout<<"{\"tiles\":"<<nt<<",\"nodes\":"<<nn<<",\"edges\":"<<ne<<",\"closed_nodes\":"<<closed_nodes<<",\"ferry_edges\":"<<ferry_edges<<",\"profile_segments\":"<<segments<<"}\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}
