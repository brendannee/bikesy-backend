// Which O/D data may be committed. Pairs and points carry a `source` string; only data
// built solely from public-domain or openly licensed inputs goes into the repository:
//   US Census LEHD LODES   public domain
//   US Census ACS          public domain (tract tables, e.g. B08301 means of transportation to work)
//   OpenStreetMap          ODbL (attribute "© OpenStreetMap contributors")
//   LTBC Tahoe Bike Map    aggregated route searches LTBC chose to publish (area-pair shares only,
//                          no individual searches, usage coordinates or counts)
// Everything else stays outside git and is loaded at run time (--pairs-file, --points):
//   TRPA data layers       "Copyright TRPA", public download, no licence grant
//   GTFS feeds             no licence stated
// Sources are allow-listed, so a new or unrecognised source is restricted until added here.
const OPEN_SOURCE = /^(OpenStreetMap\b|OSM\b|US Census LEHD LODES\b|US Census ACS\b|LTBC Tahoe Bike Map searches \(aggregated\))/;

// A source string may combine inputs ("OSM supermarkets + LODES RAC", "... + TRPA ...").
// Every part must be open; LODES alone ("LODES RAC") is open only when it names Census.
export function isOpenSource(source) {
  if (typeof source !== 'string' || !source.trim()) return false;
  return source.split(/\s\+\s/).every(part => OPEN_SOURCE.test(part.trim()) || /^LODES\b/.test(part.trim()));
}

export const OSM_ATTRIBUTION = 'Contains data from OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright).';
export const OPEN_ATTRIBUTION = 'Contains data from OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright) '
  + 'and US Census LEHD LODES 8, 2023 (public domain).';

export function splitBySource(items, sourceOf = item => item.source) {
  const open = [], restricted = [];
  for (const item of items) (isOpenSource(sourceOf(item)) ? open : restricted).push(item);
  return { open, restricted };
}
