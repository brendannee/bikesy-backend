-- Optional layer on top of bicycle-access.lua, appended to the import profile only for
-- regions whose config sets "paved_surface_defaults": true (prepare-bicycle-access.py).
-- Valhalla maps an untagged footway (including sidewalks and crossings) and
-- surface=wood or boardwalk to compacted. Sidewalks, crossings, wooden bridges and
-- boardwalks are paved for riding, as in the frontend's bicycle overlays. Only the surface
-- tag changes: the importer uses it for the edge surface (and from that, speeds and the
-- surface preference class), never for access. Untagged footways other than sidewalks and
-- crossings stay compacted. Regions without the option do not load this file at all.
local access_ways_proc = ways_proc

local function default_surface(tags)
  local surface = tags["surface"]
  if surface ~= nil then
    local value = string.lower(surface)
    if value == "wood" or value == "boardwalk" then
      return "paved"
    end
    return nil
  end
  -- tracktype, sac_scale and mtb:scale already imply a surface; keep Valhalla's choice.
  if tags["tracktype"] ~= nil or tags["sac_scale"] ~= nil or tags["mtb:scale"] ~= nil or
      tags["mtb:scale:uphill"] ~= nil then
    return nil
  end
  if tags["highway"] == "footway" and
      (tags["footway"] == "sidewalk" or tags["footway"] == "crossing") then
    return "paved"
  end
  if tags["highway"] ~= nil and tags["bridge"] == "boardwalk" then
    return "paved"
  end
  return nil
end

function ways_proc(tags, count)
  -- Read the original tags first: the upstream transformer mutates its input table.
  local surface = default_surface(tags)
  local filter, transformed, polygon, road = access_ways_proc(tags, count)
  if filter == 0 and surface ~= nil then
    transformed["surface"] = surface
  end
  return filter, transformed, polygon, road
end
