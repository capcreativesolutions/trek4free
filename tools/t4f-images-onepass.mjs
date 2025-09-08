// tools/t4f-images-onepass.mjs
// One-pass image normalizer for Trek4Free events.
// - Flattens images into public/images/events (no subfolders)
// - Builds images list per event id from filenames (<id>-NN.*)
// - Skips logos/maps/etc, limits to N per event
// - Rewrites events.json images[] to clean site-relative paths
// Usage:
//   node tools/t4f-images-onepass.mjs \
//     --events public/data/events/events.json \
//     --out public/data/events/events.patched.json \
//     --images public/images/events \
//     --mode append|replace|fill \
//     --limit 3

import fs from "fs";
import path from "path";
import url from "url";

const argv = Object.fromEntries(process.argv.slice(2).map(a=>{
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m? [m[1], m[2] ?? true] : [a,true];
}));

const ROOT   = process.cwd();
const EVENTS = path.resolve(ROOT, argv.events || "public/data/events/events.json");
const OUT    = path.resolve(ROOT, argv.out    || "public/data/events/events.patched.json");
const IMGDIR = path.resolve(ROOT, argv.images || "public/images/events");
const MODE   = (argv.mode || "append").toLowerCase();   // append | replace | fill
const LIMIT  = Number(argv.limit || 3);

const SKIP_WORDS = (argv.skip || "logo,map,route,course,save-the-date,garmin,promo,badge,poster,flyer,schedule")
  .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function listRecursive(dir){
  const out = [];
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const p = path.join(dir,e.name);
    if (e.isDirectory()) out.push(...listRecursive(p));
    else out.push(p);
  }
  return out;
}
function isImage(f){ return /\.(jpe?g|png|webp)$/i.test(f); }
function slugStem(name){
  // accept "<id>-01.jpg" or "<id>-001.jpg" etc → return "<id>"
  const base = name.toLowerCase();
  const m = base.match(/^(.+?)(?:-(?:\d{2,3}))?\.(?:jpe?g|png|webp)$/i);
  return (m? m[1] : base.replace(/\.(jpe?g|png|webp)$/i,""));
}
function hasSkipWord(name){
  const lower = name.toLowerCase();
  return SKIP_WORDS.some(w => lower.includes(w));
}
function uniq(arr){
  const s = new Set(); const out=[];
  for (const v of arr){ const k=v.toLowerCase(); if(!s.has(k)){ s.add(k); out.push(v); } }
  return out;
}
function today(){ return new Date().toISOString().slice(0,10); }

// 1) Read events
if (!fs.existsSync(EVENTS)) { console.error("Events file not found:", EVENTS); process.exit(1); }
const events = JSON.parse(fs.readFileSync(EVENTS,"utf8"));
const ids = new Set(events.map(e => (e.id||"").toLowerCase()));

// 2) Ensure image dir; flatten any subfolders
ensureDir(IMGDIR);
const filesAll = listRecursive(IMGDIR).filter(isImage);

// Move files from subfolders up to IMGDIR root (keep basename)
for (const abs of filesAll) {
  const dir = path.dirname(abs);
  if (path.resolve(dir) === path.resolve(IMGDIR)) continue; // already flat
  const base = path.basename(abs);
  const dst  = path.join(IMGDIR, base);
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(abs, dst); // copy
  }
}

// 3) Build a quick index of images by stem
const flatFiles = fs.readdirSync(IMGDIR).filter(isImage);
const index = new Map(); // stem -> [basenames]
for (const base of flatFiles) {
  if (hasSkipWord(base)) continue;
  const stem = slugStem(base);
  if (!index.has(stem)) index.set(stem, []);
  index.get(stem).push(base);
}
// sort each list by numeric suffix if present
for (const [stem, arr] of index.entries()) {
  arr.sort((a,b)=>{
    const na = Number(a.match(/-(\d+)\./)?.[1] || 9999);
    const nb = Number(b.match(/-(\d+)\./)?.[1] || 9999);
    return na-nb;
  });
}

// 4) Normalize events images
let changed=0, dropped=0, matched=0;
const basePrefix = "/images/events/";

for (const ev of events) {
  if (!Array.isArray(ev.images)) ev.images = [];
  const id = (ev.id||"").toLowerCase();

  // Start with current images, rewrite any local paths to flat /images/events/<basename>
  let current = [];
  for (const u of ev.images) {
    if (!u) continue;
    if (/^https?:\/\//i.test(u)) {
      // keep https if you want mixed sources; if not, comment next line:
      current.push(u);
    } else {
      const base = path.posix.basename(u);
      if (flatFiles.some(f => f.toLowerCase() === base.toLowerCase())) {
        current.push(basePrefix + base);
      } else {
        dropped++;
      }
    }
  }

  // Candidate local images from folder by id
  let candidates = [];
  if (index.has(id)) {
    matched++;
    candidates = index.get(id).map(b => basePrefix + b);
  }

  let next = [];
  if (MODE === "replace") {
    next = candidates.slice(0, LIMIT);
  } else if (MODE === "fill") {
    next = uniq([...current, ...candidates]).slice(0, LIMIT);
    if (current.length) {
      // Keep existing order but cap to LIMIT
      const keepFirst = current.slice(0, LIMIT);
      // then fill from candidates not already present
      const more = candidates.filter(c => !keepFirst.map(x=>x.toLowerCase()).includes(c.toLowerCase()))
                             .slice(0, Math.max(0, LIMIT - keepFirst.length));
      next = [...keepFirst, ...more];
    }
  } else { // append (default)
    next = uniq([...current, ...candidates]).slice(0, LIMIT);
  }

  if (JSON.stringify(next) !== JSON.stringify(ev.images)) {
    ev.images = next;
    ev.lastUpdated = today();
    changed++;
  }
}

fs.writeFileSync(OUT, JSON.stringify(events, null, 2));
console.log(`✔ One-pass complete.`);
console.log(`  Events changed: ${changed}`);
console.log(`  Events with folder matches: ${matched}`);
console.log(`  Dropped bad local paths: ${dropped}`);
console.log(`  Wrote: ${path.relative(ROOT, OUT)}`);
