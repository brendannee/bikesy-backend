#include "bikesy_policy.h"
#include "bikesy_profile.h"
#include "config.h"
#include "skadi/sample.h"
#include "midgard/util.h"
#include <iostream>
#include <numeric>
using namespace valhalla;using namespace valhalla::baldr;
int main(int argc,char** argv){try{
 if(argc!=7&&argc!=8)throw std::runtime_error("Usage: build_policy config output west south east north [hill_exponent]");
 const double hill_exponent=argc==8?std::stod(argv[7]):bikesy::kHillExponent;
 if(!(hill_exponent>=1&&hill_exponent<=3))throw std::runtime_error("hill_exponent must be between 1 and 3");
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
 // Structures (bridges, tunnels) are resolved over the whole graph, so the first pass stores every shape's
 // raw profile and its two nodes. Nodes are merged across hierarchy levels (transitions) so that a bridge on
 // one level still sees the ordinary road it meets on another; a node at the data boundary, or outside the
 // tile set, is "open" and always ends a structure.
 std::vector<uint32_t> tparent(nn);std::iota(tparent.begin(),tparent.end(),0);
 auto troot=[&](uint32_t v){while(tparent[v]!=v){tparent[v]=tparent[tparent[v]];v=tparent[v];}return v;};
 std::vector<bool> boundary(nn,false);
 std::vector<bikesy::StructureEdge> shapes;std::vector<double> heights;std::vector<uint32_t> hoff{0};
 std::vector<uint32_t> edge_shape(ne,UINT32_MAX);std::vector<bool> edge_fwd(ne,false);
 std::unordered_map<uint64_t,uint32_t> outside;   // end nodes outside the tile set: one synthetic node each
 struct Pending{uint32_t s,t;bool s_in,t_in;};std::vector<Pending> pending;
 uint64_t ferry_edges=0,segments=0;
 for(const auto& entry:index){std::cerr<<"begin tile "<<entry.id<<"\n";auto tile=reader.GetGraphTile(GraphId(entry.id));
  std::vector<uint32_t> start_of(entry.edge_count,UINT32_MAX);
  for(uint32_t n=0;n<entry.node_count;++n){auto node=tile->node(n);uint32_t idx=entry.nodes+n;auto ll=node->latlng(tile->header()->base_ll());
   // Components touching the data-buffer boundary cannot establish exterior disconnection.
   if(ll.lng()<=west+.001||ll.lng()>=east-.001||ll.lat()<=south+.001||ll.lat()>=north-.001){open[idx]=true;boundary[idx]=true;}
   for(auto trans:tile->GetNodeTransitions(node)){join(idx,trans.endnode());uint32_t other=nodeidx(trans.endnode());if(other!=UINT32_MAX){uint32_t a=troot(idx),b=troot(other);if(a!=b)tparent[a]=b;}}
   for(uint32_t e=node->edge_index();e<node->edge_index()+node->edge_count();++e){auto edge=tile->directededge(e);start_of[e]=idx;
    if(edge->use()==Use::kFerry||edge->use()==Use::kRailFerry){++ferry_edges;continue;}
    // Over-approximation: include all modes/directions/restrictions, ensuring no false bicycle disconnection.
    join(idx,edge->endnode());
   }
  }
  std::unordered_map<uint32_t,uint32_t> profiles;
  for(uint32_t e=0;e<entry.edge_count;++e){auto edge=tile->directededge(e);
   if(edge->use()==Use::kFerry||edge->use()==Use::kRailFerry||edge->is_shortcut())continue;
   auto off=edge->edgeinfo_offset();auto found=profiles.find(off);
   if(found==profiles.end()){
    auto shape=tile->edgeinfo(edge).shape();double length=edge->length();
    if(length<=0){profiles.emplace(off,UINT32_MAX);continue;}
    uint32_t count=std::max(2u,uint32_t(std::ceil(length/30.0))+1);
    auto sampled=midgard::uniform_resample_spherical_polyline(shape,length,count);auto hs=dem.get_all(sampled);
    if(hs.size()<2)throw std::runtime_error("Missing elevation samples");
    double sum=0;for(double h:hs){if(!std::isfinite(h)||h<=-32768)throw std::runtime_error("Missing DEM elevation");sum+=h;}
    uint32_t s=start_of[e];if(s==UINT32_MAX)throw std::runtime_error("Edge without start node");
    GraphId tn=edge->endnode();uint32_t t=nodeidx(tn);bool t_in=t!=UINT32_MAX;
    if(!t_in)t=outside.emplace(tn.value,uint32_t(outside.size())).first->second;   // synthetic node, numbered after the merged ones below
    // the shape runs from node a (first sample) to node b (last sample)
    if(edge->forward())pending.push_back({s,t,true,t_in});else pending.push_back({t,s,t_in,true});
    shapes.push_back({0,0,length,edge->bridge()||edge->tunnel(),hs.front(),hs.back(),sum/hs.size()});
    heights.insert(heights.end(),hs.begin(),hs.end());hoff.push_back(heights.size());
    found=profiles.emplace(off,uint32_t(shapes.size()-1)).first;
   }
   if(found->second==UINT32_MAX){uphill[entry.edges+e]=0.f;continue;}
   edge_shape[entry.edges+e]=found->second;edge_fwd[entry.edges+e]=edge->forward();
  }
  std::cerr<<"profile tile "<<entry.id<<" nodes "<<entry.node_count<<" edges "<<entry.edge_count<<"\n";
 }
 // Logical structure nodes: one per transition-merged node, plus one per outside end node.
 std::vector<uint32_t> logical(nn,UINT32_MAX);uint32_t nm=0;for(uint32_t i=0;i<nn;++i){uint32_t r=troot(i);if(logical[r]==UINT32_MAX)logical[r]=nm++;logical[i]=logical[r];}
 const uint32_t nl=nm+outside.size();
 std::vector<char> sopen(nl,0);for(uint32_t i=0;i<nn;++i)if(boundary[i])sopen[logical[i]]=1;for(uint32_t k=nm;k<nl;++k)sopen[k]=1;
 for(size_t i=0;i<shapes.size();++i){const auto& p=pending[i];
  shapes[i].a=p.s_in?logical[p.s]:nm+p.s;shapes[i].b=p.t_in?logical[p.t]:nm+p.t;}
 std::cerr<<"structures over "<<shapes.size()<<" shapes, "<<nl<<" nodes\n";
 const auto structures=bikesy::resolve_structures(shapes,nl,sopen);
 std::vector<std::pair<float,float>> cost(shapes.size());uint64_t members=0,gaps=0;
 for(size_t i=0;i<shapes.size();++i){
  std::vector<double> hs(heights.begin()+hoff[i],heights.begin()+hoff[i+1]);
  if(structures.member[i]){hs=bikesy::straight_profile(structures.ends[i].first,structures.ends[i].second,hs.size());++members;gaps+=structures.gap[i];}
  // Dead-band and minimum run: see bikesy_profile.h and docs/HILL-COST.md.
  size_t profile_segments=0;const auto [fw,rev]=bikesy::profile_uphill(hs,shapes[i].length,bikesy::kHillDeadBand,bikesy::kHillMinRun,&profile_segments,hill_exponent);segments+=profile_segments;
  cost[i]={float(fw),float(rev)};
 }
 for(uint32_t e=0;e<ne;++e)if(edge_shape[e]!=UINT32_MAX)uphill[e]=edge_fwd[e]?cost[edge_shape[e]].first:cost[edge_shape[e]].second;
 std::vector<bool> roots_open(nn,false);for(uint32_t i=0;i<nn;++i)if(open[i])roots_open[root(i)]=true;
 std::vector<uint32_t> components(nn);uint32_t closed_nodes=0;
 for(uint32_t i=0;i<nn;++i){uint32_t r=root(i);components[i]=r|(roots_open[r]?bikesy::kOpen:0);if(!roots_open[r])++closed_nodes;}
 std::ofstream f(argv[2],std::ios::binary);uint64_t magic=bikesy::kMagic;uint32_t nt=index.size();f.write((char*)&magic,8);f.write((char*)&nt,4);f.write((char*)&nn,4);f.write((char*)&ne,4);for(auto t:index)f.write((char*)&t,sizeof t);f.write((char*)components.data(),nn*4);f.write((char*)uphill.data(),ne*4);if(!f)throw std::runtime_error("Policy write failed");
 std::cout<<"{\"tiles\":"<<nt<<",\"nodes\":"<<nn<<",\"edges\":"<<ne<<",\"closed_nodes\":"<<closed_nodes<<",\"ferry_edges\":"<<ferry_edges<<",\"profile_segments\":"<<segments
          <<",\"structure_edges\":"<<members<<",\"structure_gap_edges\":"<<gaps<<",\"structures\":"<<structures.structures<<"}\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}
