// src/lib/load-data.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/* ---------------- Types ---------------- */
export type PointType =
  | "trailhead"
  | "campground"
  | "freecamp"
  | "backpackcamp"
  | "swimming"
  | "epic"
  | "feature";

export type Point = {
  slug: string;
  name: string;
  type: PointType;
  source: string;

  lat: number | null;
  lon: number | null;

  state?: string;        // 2-letter lowercase
  location?: string;
  image?: string | null;
  description?: string;
  water?: string;
  bathrooms?: string;
  fee?: string;

  distance_miles?: number | null;
  elevation_gain_ft?: number | null;
  difficulty?: string | null;
  dogs_allowed?: boolean | null;
  features?: string[];
  source_url?: string | null;
};

/* ---------------- Datasets ---------------- */
type FileSpec = { path: string; type: PointType; source: string };
const DATASETS: FileSpec[] = [
  { path: "/data/trailheads-usfs.json",       type: "trailhead",    source: "usfs" },
  { path: "/data/trailheads-ridb.json",       type: "trailhead",    source: "ridb" },
  { path: "/data/campgrounds-usfs-ridb.json", type: "campground",   source: "usfs-ridb" },
  { path: "/data/freecamping.json",           type: "freecamp",     source: "custom" },
  { path: "/data/freecamping-usfs.json",      type: "freecamp",     source: "usfs" },
  { path: "/data/backpackcamping-usfs.json",  type: "backpackcamp", source: "usfs" },
  { path: "/data/swimming-holes.json",        type: "swimming",     source: "custom" },
  { path: "/data/epic-trails.json",           type: "epic",         source: "custom" },
  { path: "/data/at-points.json",             type: "feature",      source: "at" },
];

/* ---------------- Utilities ---------------- */
const slugify = (s: string) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function stableSlug(name: string, lat: number | null, lon: number | null) {
  const base = slugify(name || "unnamed");
  if (Number.isFinite(lat as number) && Number.isFinite(lon as number)) {
    return `${base}-${Math.round((lat as number) * 100000)}-${Math.round(
      (lon as number) * 100000
    )}`;
  }
  return base;
}

function asArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const v of Object.values(json)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/* ---------------- State helpers (names/abbrs) ---------------- */
const STATE_ABBR: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
  nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah",
  vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia",
  wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};
const NAME_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBR).map(([abbr, name]) => [name, abbr])
);

/* ---------------- Accurate polygons (optional) ---------------- */
/** Reads public/geo/us-states.min.json if present (GeoJSON FeatureCollection). */
type Ring = [number, number][];         // [lon, lat]
type Poly = Ring[];                      // [outer, hole1, hole2...]
type MultiPoly = Poly[];
type StateFeature = {
  abbr: string;
  name?: string;
  polys: MultiPoly;                      // normalized to MultiPolygon
  bbox: { minLat:number, maxLat:number, minLon:number, maxLon:number };
};

let STATE_FEATURES: StateFeature[] | null = null;

async function readPublicAny(relPath: string): Promise<any> {
  // HTTP first
  try {
    const origin =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      "http://localhost:4321";
    const res = await fetch(new URL(relPath, origin));
    if (res.ok) return await res.json();
  } catch {
    // ignore; fall back below
  }

  // Skip filesystem inside Netlify Functions
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error("public asset unavailable via HTTP");
  }

  // Local/build fallback via dynamic import
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const fsPath = join(process.cwd(), "public", relPath.replace(/^\/+/, ""));
  const raw = await readFile(fsPath, "utf8");
  return JSON.parse(raw);
}


function ringBBox(r: Ring){
  let minLon=Infinity, maxLon=-Infinity, minLat=Infinity, maxLat=-Infinity;
  for (const [x,y] of r){ if(x<minLon)minLon=x; if(x>maxLon)maxLon=x; if(y<minLat)minLat=y; if(y>maxLat)maxLat=y; }
  return {minLon,maxLon,minLat,maxLat};
}
function polyBBox(p: Poly){
  let b = {minLon:Infinity,maxLon:-Infinity,minLat:Infinity,maxLat:-Infinity};
  for(const r of p){
    const rb = ringBBox(r);
    if(rb.minLon<b.minLon) b.minLon=rb.minLon;
    if(rb.maxLon>b.maxLon) b.maxLon=rb.maxLon;
    if(rb.minLat<b.minLat) b.minLat=rb.minLat;
    if(rb.maxLat>b.maxLat) b.maxLat=rb.maxLat;
  }
  return {minLon:b.minLon,maxLon:b.maxLon,minLat:b.minLat,maxLat:b.maxLat};
}
function pointInRing(lon:number, lat:number, ring: Ring){
  // ray-casting
  let inside=false; const n=ring.length;
  for(let i=0,j=n-1;i<n;j=i++){
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    const intersect = ((yi>lat)!==(yj>lat)) && (lon < (xj-xi)*(lat-yi)/(yj-yi + 0.0)+xi);
    if(intersect) inside=!inside;
  }
  return inside;
}
function pointInPoly(lon:number, lat:number, poly: Poly){
  if(!pointInRing(lon,lat, poly[0])) return false;
  for(let i=1;i<poly.length;i++){ if(pointInRing(lon,lat, poly[i])) return false; }
  return true;
}

async function ensureStateFeatures(){
  if(STATE_FEATURES !== null) return;
  try{
    const gj = await readPublicAny("/geo/us-states.min.json");
    const feats = (gj?.type==="FeatureCollection" ? gj.features : gj?.features) || [];
    STATE_FEATURES = feats.map((f:any)=>{
      const abFromName =
        NAME_TO_ABBR[String(f?.properties?.name ?? "").toLowerCase()] || "";
      const abbr = String(f?.properties?.abbr ?? abFromName).toLowerCase();
      const name = f?.properties?.name;
      let polys: MultiPoly = [];
      if(f?.geometry?.type === "Polygon"){
        polys = [ (f.geometry.coordinates as number[][][])
                   .map(r => r.map(([x,y])=>[x,y] as [number,number])) ];
      }else if(f?.geometry?.type === "MultiPolygon"){
        polys = (f.geometry.coordinates as number[][][][])
                 .map(p => p.map(r => r.map(([x,y])=>[x,y] as [number,number])));
      }
      // bbox of all rings
      let box = {minLon:Infinity,maxLon:-Infinity,minLat:Infinity,maxLat:-Infinity};
      for(const p of polys){
        const pb = polyBBox(p);
        if(pb.minLon<box.minLon) box.minLon=pb.minLon;
        if(pb.maxLon>box.maxLon) box.maxLon=pb.maxLon;
        if(pb.minLat<box.minLat) box.minLat=pb.minLat;
        if(pb.maxLat>box.maxLat) box.maxLat=pb.maxLat;
      }
      return { abbr, name, polys, bbox: {minLat:box.minLat,maxLat:box.maxLat,minLon:box.minLon,maxLon:box.maxLon} } as StateFeature;
    }).filter(s => s.abbr && s.polys.length>0);

    // verification log
    console.log("[states] polygons loaded:", STATE_FEATURES.length);
  }catch{
    STATE_FEATURES = [];
    console.warn("[states] polygons not loaded; using bbox only");
  }
}

function stateFromPolys(lat:number, lon:number): string | null {
  if(!STATE_FEATURES || !STATE_FEATURES.length) return null;
  for(const s of STATE_FEATURES){
    const b = s.bbox;
    if(lat<b.minLat || lat>b.maxLat || lon<b.minLon || lon>b.maxLon) continue;
    for(const poly of s.polys){
      if(pointInPoly(lon, lat, poly)) return s.abbr;
    }
  }
  return null;
}

/* ---------------- Rough bboxes fallback ---------------- */
type BBox = { minLat: number; maxLat: number; minLon: number; maxLon: number };
const BBOXES: Record<string, BBox> = {
  al:{minLat:30.1,maxLat:35.1,minLon:-88.6,maxLon:-84.7},
  ak:{minLat:51.2,maxLat:71.5,minLon:-179.2,maxLon:-129.9},
  az:{minLat:31.2,maxLat:37.1,minLon:-114.9,maxLon:-109.0},
  ar:{minLat:33.0,maxLat:36.6,minLon:-94.6,maxLon:-89.6},
  ca:{minLat:32.4,maxLat:42.1,minLon:-124.5,maxLon:-114.1},
  co:{minLat:36.9,maxLat:41.1,minLon:-109.1,maxLon:-102.0},
  ct:{minLat:41.0,maxLat:42.1,minLon:-73.7,maxLon:-71.8},
  de:{minLat:38.4,maxLat:39.9,minLon:-75.8,maxLon:-75.0},
  fl:{minLat:24.4,maxLat:31.1,minLon:-87.7,maxLon:-80.0},
  ga:{minLat:30.4,maxLat:35.1,minLon:-85.6,maxLon:-80.8},
  hi:{minLat:18.8,maxLat:22.4,minLon:-160.5,maxLon:-154.5},
  ia:{minLat:40.4,maxLat:43.6,minLon:-96.7,maxLon:-90.1},
  id:{minLat:41.9,maxLat:49.1,minLon:-117.3,maxLon:-111.0},
  il:{minLat:36.9,maxLat:42.6,minLon:-91.6,maxLon:-87.0},
  in:{minLat:37.8,maxLat:41.8,minLon:-88.2,maxLon:-84.8},
  ks:{minLat:36.9,maxLat:40.1,minLon:-102.1,maxLon:-94.6},
  ky:{minLat:36.5,maxLat:39.3,minLon:-89.6,maxLon:-81.9},
  la:{minLat:28.9,maxLat:33.1,minLon:-94.1,maxLon:-89.0},
  ma:{minLat:41.2,maxLat:42.9,minLon:-73.5,maxLon:-69.9},
  md:{minLat:37.9,maxLat:39.8,minLon:-79.5,maxLon:-75.0},
  me:{minLat:43.0,maxLat:47.5,minLon:-71.1,maxLon:-66.9},
  mi:{minLat:41.5,maxLat:48.3,minLon:-90.5,maxLon:-82.1},
  mn:{minLat:43.5,maxLat:49.4,minLon:-97.3,maxLon:-89.5},
  mo:{minLat:35.9,maxLat:40.7,minLon:-95.8,maxLon:-89.1},
  ms:{minLat:30.2,maxLat:35.0,minLon:-91.7,maxLon:-88.1},
  mt:{minLat:44.4,maxLat:49.1,minLon:-116.1,maxLon:-104.0},
  nc:{minLat:33.8,maxLat:36.6,minLon:-84.3,maxLon:-75.4},
  nd:{minLat:46.0,maxLat:49.1,minLon:-104.1,maxLon:-96.5},
  ne:{minLat:39.9,maxLat:43.1,minLon:-104.1,maxLon:-95.3},
  nh:{minLat:42.7,maxLat:45.3,minLon:-72.6,maxLon:-70.6},
  nj:{minLat:38.9,maxLat:41.4,minLon:-75.6,maxLon:-73.9},
  nm:{minLat:31.3,maxLat:37.0,minLon:-109.1,maxLon:-103.0},
  nv:{minLat:35.0,maxLat:42.1,minLon:-120.0,maxLon:-114.0},
  ny:{minLat:40.5,maxLat:45.1,minLon:-79.8,maxLon:-71.8},
  oh:{minLat:38.4,maxLat:42.3,minLon:-84.8,maxLon:-80.5},
  ok:{minLat:33.6,maxLat:37.1,minLon:-103.0,maxLon:-94.4},
  or:{minLat:42.0,maxLat:46.3,minLon:-124.7,maxLon:-116.5},
  pa:{minLat:39.7,maxLat:42.5,minLon:-80.6,maxLon:-74.7},
  ri:{minLat:41.1,maxLat:42.1,minLon:-71.9,maxLon:-71.1},
  sc:{minLat:32.0,maxLat:35.2,minLon:-83.4,maxLon:-78.5},
  sd:{minLat:42.5,maxLat:45.9,minLon:-104.1,maxLon:-96.4},
  tn:{minLat:34.9,maxLat:36.7,minLon:-90.4,maxLon:-81.6},
  tx:{minLat:25.8,maxLat:36.6,minLon:-106.7,maxLon:-93.5},
  ut:{minLat:37.0,maxLat:42.1,minLon:-114.1,maxLon:-109.0},
  va:{minLat:36.5,maxLat:39.5,minLon:-83.7,maxLon:-75.2},
  vt:{minLat:42.7,maxLat:45.1,minLon:-73.5,maxLon:-71.5},
  wa:{minLat:45.5,maxLat:49.1,minLon:-124.8,maxLon:-116.9},
  wi:{minLat:42.5,maxLat:47.3,minLon:-92.9,maxLon:-86.2},
  wv:{minLat:37.1,maxLat:40.7,minLon:-82.7,maxLon:-77.7},
  wy:{minLat:41.0,maxLat:45.1,minLon:-111.1,maxLon:-104.0},
  dc:{minLat:38.79,maxLat:39.0,minLon:-77.12,maxLon:-76.91},
};

function stateFromBbox(lat:number, lon:number): string | null {
  for (const [ab, box] of Object.entries(BBOXES)) {
    if (lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon) {
      return ab;
    }
  }
  return null;
}

/* ---------------- Normalization + State inference ---------------- */
function deriveState(row: any, location: string): string {
  // 1) explicit fields first
  const raw =
    row.state ?? row.State ?? row.STATE ?? row.StateProvince ?? row.STATE_CODE ?? row.state_code ?? "";
  if (typeof raw === "string" && raw.trim()) {
    const v = raw.trim().toLowerCase();
    if (STATE_ABBR[v as keyof typeof STATE_ABBR]) return v; // already abbr
    if (NAME_TO_ABBR[v]) return NAME_TO_ABBR[v];             // full name → abbr
  }

  // 2) parse from free text
  const text = [
    location,
    row.closest_town,
    row.CLOSEST_TO,
    row.city, row.TOWN,
    row.directions ?? row.DIRECTIONS,
    row.description ?? row.RECAREA_DE,
    row.operator ?? row.OPERATED_B,
  ].filter(Boolean).join(" | ").toLowerCase();

  const abbrMatch = text.match(/(^|[^a-z])(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy|dc)([^a-z]|$)/i);
  if (abbrMatch) {
    const ab = abbrMatch[2].toLowerCase();
    if (STATE_ABBR[ab]) return ab;
  }
  for (const [name, ab] of Object.entries(NAME_TO_ABBR)) {
    if (text.includes(name)) return ab;
  }

  // 3) accurate polygons if we have coords
  const lat = Number(row.lat ?? row.latitude ?? row.Latitude ?? row.LAT ?? row.lat_dd ?? NaN);
  const lon = Number(row.lon ?? row.lng ?? row.longitude ?? row.Longitude ?? row.LON ?? row.long_dd ?? NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const ab = stateFromPolys(lat, lon); // null if polygons unavailable
    if (ab) return ab;
  }

  // 4) rough bbox fallback
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const ab = stateFromBbox(lat, lon);
    if (ab) return ab;
  }

  return "unknown";
}

function normalizeRow(row: any, defType: PointType, source: string): Point {
  const lat = row.lat ?? row.latitude ?? row.Latitude ?? row.LAT ?? row.lat_dd ?? null;
  const lon = row.lon ?? row.lng ?? row.longitude ?? row.Longitude ?? row.LON ?? row.long_dd ?? null;

  const latNum = lat != null ? Number(lat) : null;
  const lonNum = lon != null ? Number(lon) : null;

  const name = String(
    row.name ??
      row.title ??
      row.Title ??
      row.SITE_NAME ??
      row.RECAREA_NA ??
      row.FacilityName ??
      "Unnamed"
  );

  const stateLike = row.StateProvince ?? row.STATE ?? row.STATE_CODE ?? row.state ?? "";
  const cityLike  = row.city ?? row.TOWN ?? row.NEAREST_CITY ?? "";
  const closeTo   = row.location ?? row.CLOSEST_TO ?? row.closest_town ?? "";
  const location  =
    closeTo ||
    (cityLike && stateLike ? `${cityLike}, ${stateLike}` : (cityLike || stateLike || ""));

  const distance_miles    = row.distance_miles ?? row.distance ?? row.length_mi ?? null;
  const elevation_gain_ft = row.elevation_gain_ft ?? row.elevation_gain ?? row.gain_ft ?? null;
  const difficulty        = (row.difficulty ?? row.DIFFICULTY ?? "")?.toString() || null;

  let dogs_allowed: boolean | null = null;
  if (typeof row.dogs_allowed === "boolean") dogs_allowed = row.dogs_allowed;
  else if (row.RESTRICTIO) dogs_allowed = !/no\s*dogs/i.test(String(row.RESTRICTIO));

  const features: string[] = Array.isArray(row.features)
    ? row.features
    : row.FEATURES
    ? String(row.FEATURES).split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];

  const description = row.description ?? row.desc ?? row.RECAREA_DE ?? "";
  const directions  = row.directions  ?? row.DIRECTIONS ?? "";
  const water       = row.water ?? row.WATER_AVAI ?? "";
  const bathrooms   = row.bathrooms ?? row.RESTROOM_A ?? "";
  const image       = row.image ?? row.photo ?? row.thumbnail ?? null;
  const fee         = row.fee ?? row.FEE_DESCRI ?? "";

  const state = deriveState({ ...row, lat: latNum, lon: lonNum }, location);
  const slug  = row.slug ?? stableSlug(name, latNum, lonNum);

  return {
    slug,
    name,
    type: defType,
    source,
    lat: latNum,
    lon: lonNum,

    state,
    location,
    image,
    description,
    water,
    bathrooms,
    fee,

    distance_miles: distance_miles != null ? Number(distance_miles) : null,
    elevation_gain_ft: elevation_gain_ft != null ? Number(elevation_gain_ft) : null,
    difficulty,
    dogs_allowed,
    features,
    source_url: row.url ?? row.link ?? null,
  };
}

function dedupe(points: Point[]): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const p of points) {
    const key = p.slug || p.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

/* ---------------- File IO ---------------- */

async function readPublicJSON(relPath: string): Promise<any[]> {
  // Try HTTP first — works on Netlify Functions & in preview/dev
  try {
    const origin =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      "http://localhost:4321";
    const res = await fetch(new URL(relPath, origin));
    if (res.ok) {
      const json = await res.json();
      return asArray(json);
    }
  } catch {
    // ignore; fall back below
  }

  // On Netlify Functions, DO NOT try filesystem — avoids bundling /public/**
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return [];
  }

  // Local/build fallback: dynamic import keeps fs/path out of the SSR bundle
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const fsPath = join(process.cwd(), "public", relPath.replace(/^\/+/, ""));
    const raw = await readFile(fsPath, "utf8");
    const json = JSON.parse(raw);
    return asArray(json);
  } catch {
    return [];
  }
}


/* ---------------- Public API ---------------- */
export async function loadAllPoints(): Promise<Point[]> {
  await ensureStateFeatures(); // polygons optional; safe if file missing

  const all: Point[] = [];
  for (const spec of DATASETS) {
    const arr = await readPublicJSON(spec.path);
    for (const row of arr) {
      all.push(normalizeRow(row, spec.type, spec.source));
    }
  }

  // verification log
  const unknown = all.filter(p => (p.state || "unknown") === "unknown").length;
  console.log(`[points] total=${all.length} unknown=${unknown}`);

  return dedupe(all);
}

export function byTypeAndState(points: Point[]) {
  const map = new Map<string, Point[]>();
  for (const p of points) {
    const t = p.type;
    const s = (p.state || "unknown").toLowerCase();
    const key = `${t}::${s}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return map;
}
