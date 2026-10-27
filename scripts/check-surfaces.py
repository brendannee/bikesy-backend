"""Exercise real pinned Lua: the opt-in paved surface defaults change only the surface tag."""
import json
from pathlib import Path
base=Path(__file__).parent
setup=(base/'check-bicycle-access.py').read_text().split('try:\n')[0]
exec(setup)
# (name, tags, expected surface tag after the wrapper; None keeps the stock value)
cases=[
 ('sidewalk-untagged',{'highway':'footway','footway':'sidewalk'},'paved'),
 ('crossing-untagged',{'highway':'footway','footway':'crossing','crossing':'marked'},'paved'),
 ('sidewalk-bicycle-no',{'highway':'footway','footway':'sidewalk','bicycle':'no'},'paved'),
 ('sidewalk-bicycle-yes',{'highway':'footway','footway':'sidewalk','bicycle':'yes','foot':'designated'},'paved'),
 ('crossing-oneway',{'highway':'footway','footway':'crossing','oneway':'yes'},'paved'),
 ('sidewalk-tagged-concrete',{'highway':'footway','footway':'sidewalk','surface':'concrete'},None),
 ('sidewalk-tagged-gravel',{'highway':'footway','footway':'sidewalk','surface':'gravel'},None),
 ('sidewalk-tracktype',{'highway':'footway','footway':'sidewalk','tracktype':'grade2'},None),
 ('sidewalk-sac-scale',{'highway':'footway','footway':'sidewalk','sac_scale':'hiking'},None),
 ('sidewalk-mtb-scale',{'highway':'footway','footway':'sidewalk','mtb:scale':'0'},None),
 ('footway-untagged',{'highway':'footway'},None),
 ('path-untagged',{'highway':'path'},None),
 ('path-sidewalk-not-footway',{'highway':'path','footway':'sidewalk'},None),
 ('path-wood',{'highway':'path','surface':'wood','bridge':'yes'},'paved'),
 ('footway-wood-case',{'highway':'footway','surface':'Wood'},'paved'),
 ('residential-wood-bridge',{'highway':'residential','surface':'wood','bridge':'yes','layer':'1'},'paved'),
 ('cycleway-wood',{'highway':'cycleway','surface':'wood'},'paved'),
 ('track-wood-mtb',{'highway':'track','surface':'wood','mtb:scale':'1'},'paved'),
 ('surface-boardwalk',{'highway':'footway','surface':'boardwalk'},'paved'),
 ('woodchips-stays',{'highway':'path','surface':'woodchips'},None),
 ('boardwalk-bridge-untagged',{'highway':'path','bridge':'boardwalk'},'paved'),
 ('boardwalk-bridge-dirt',{'highway':'path','bridge':'boardwalk','surface':'dirt'},None),
 ('not-a-way-wood',{'building':'yes','surface':'wood'},None),
]
try:
 execute((base/'vendor/valhalla-3.5.1-graph.lua').read_text());execute('baseline_ways=ways_proc');execute((base/'bicycle-access.lua').read_text());execute('access_ways=ways_proc');execute((base/'bicycle-surface-defaults.lua').read_text())
 for name,t,expected in cases:
  literal='{'+','.join('['+json.dumps(k)+']='+json.dumps(v)for k,v in t.items())+'}'
  want='ta.surface' if expected is None else json.dumps(expected)
  execute(f'''local input={literal};local a={{}};local b={{}};local n=0
   for k,v in pairs(input)do a[k]=v;b[k]=v;n=n+1 end
   local fa,ta=access_ways(a,n);local fb,tb=ways_proc(b,n)
   assert(fa==fb,'filter changed {name}')
   assert(tb.surface=={want},'surface {name}: '..tostring(tb.surface))
   for k,v in pairs(ta)do if k~='surface' then assert(tb[k]==v,'access/nonsurface changed '..k..' {name}')end end
   for k,v in pairs(tb)do if k~='surface' then assert(ta[k]~=nil,'unexpected added field '..k..' {name}')end end
  ''');print('PASS',name)
 print(json.dumps({'surface_tests':len(cases),'passed':True}))
finally:lib.lua_close(state)
