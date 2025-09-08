// scripts/build-us-states.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);

// Robustly load a states TopoJSON from us-atlas (try 50m → 10m → plain)
let statesTopo;
try {
  statesTopo = require("us-atlas/states-50m.json");
} catch {
  try {
    statesTopo = require("us-atlas/states-10m.json");
  } catch {
    statesTopo = require("us-atlas/states.json");
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// FIPS → USPS abbr
const FIPS_TO_ABBR = {
  1:"al",2:"ak",4:"az",5:"ar",6:"ca",8:"co",9:"ct",10:"de",11:"dc",12:"fl",
  13:"ga",15:"hi",16:"id",17:"il",18:"in",19:"ia",20:"ks",21:"ky",22:"la",
  23:"me",24:"md",25:"ma",26:"mi",27:"mn",28:"ms",29:"mo",30:"mt",31:"ne",
  32:"nv",33:"nh",34:"nj",35:"nm",36:"ny",37:"nc",38:"nd",39:"oh",40:"ok",
  41:"or",42:"pa",44:"ri",45:"sc",46:"sd",47:"tn",48:"tx",49:"ut",50:"vt",
  51:"va",53:"wa",54:"wv",55:"wi",56:"wy",
};

// USPS abbr → display name
const ABBR_TO_NAME = {
  al:"Alabama", ak:"Alaska", az:"Arizona", ar:"Arkansas", ca:"California",
  co:"Colorado", ct:"Connecticut", de:"Delaware", fl:"Florida", ga:"Georgia",
  hi:"Hawaii", id:"Idaho", il:"Illinois", in:"Indiana", ia:"Iowa",
  ks:"Kansas", ky:"Kentucky", la:"Louisiana", me:"Maine", md:"Maryland",
  ma:"Massachusetts", mi:"Michigan", mn:"Minnesota", ms:"Mississippi",
  mo:"Missouri", mt:"Montana", ne:"Nebraska", nv:"Nevada",
  nh:"New Hampshire", nj:"New Jersey", nm:"New Mexico", ny:"New York",
  nc:"North Carolina", nd:"North Dakota", oh:"Ohio", ok:"Oklahoma",
  or:"Oregon", pa:"Pennsylvania", ri:"Rhode Island", sc:"South Carolina",
  sd:"South Dakota", tn:"Tennessee", tx:"Texas", ut:"Utah",
  vt:"Vermont", va:"Virginia", wa:"Washington", wv:"West Virginia",
  wi:"Wisconsin", wy:"Wyoming", dc:"District of Columbia",
};

// Convert TopoJSON → GeoJSON
const fc = feature(statesTopo, statesTopo.objects.states);

// Keep 50 states + DC, add {abbr, name}
const features = fc.features
  .map((f) => {
    const abbr = FIPS_TO_ABBR[Number(f.id)];
    if (!abbr) return null; // drop territories
    return {
      type: "Feature",
      properties: { abbr, name: ABBR_TO_NAME[abbr] },
      geometry: f.geometry, // Polygon or MultiPolygon
    };
  })
  .filter(Boolean);

const out = { type: "FeatureCollection", features };
const outPath = join(__dirname, "..", "public", "geo", "us-states.min.json");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(out));
console.log(`[ok] Wrote ${out.features.length} states to ${outPath}`);
