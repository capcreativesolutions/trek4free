#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import sharp from "sharp";
import pLimit from "p-limit";
import fetch from "node-fetch";

const INPUT = process.argv[2] || "public/data/events/events.json";
const OUT_DIR = process.argv[3] || "public/images/events";
const OUT_PATCH = process.argv[4] || "images_patch.json";
const SEEDS = process.argv[5] || null; // optional seeds.json

// ===== Tunables =====
const PER_EVENT_MAX = 3;
const MIN_BYTES = 80_000;
const MIN_W = 1200;
const MIN_H = 700;
const MAX_ASPECT = 3.0;
const CONCURRENCY = 3;
const NEVER_OVERWRITE = true;
const VERBOSE = true;

// timeouts
axios.defaults.timeout = 15000;

// filters
const LOGO_PAT = /(logo|icon|badge|sponsor|poster|flyer|map|bib|garmin|save[-_ ]?the[-_ ]?date|vector|ai-|psd|mockup)/i;
const GALLERY_HINT = /(gallery|photos|media|results|recap|photo|flickr|images)/i;

// external domains we’ll allow (we save locally anyway)
const ALLOWED_EXTERNAL = new Set([
  "upload.wikimedia.org",
  "live.staticflickr.com",
  "i.redd.it",
  "preview.redd.it",
  "static.wixstatic.com",
  "images.squarespace-cdn.com"
]);

const FLICKR_API_KEY = process.env.FLICKR_API_KEY || ""; // optional, but recommended

// ===== Utils =====
function host(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ""; } }
function sameHost(a,b){ return a && b && host(a) && host(a) === host(b); }
function toSlug(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }
function absURL(base, u){ try { return new URL(u, base).toString(); } catch { return null; } }
function uniq(a){ return [...new Set(a.filter(Boolean))]; }

async function ensureDir(dir){ await fs.mkdir(dir, { recursive: true }); }

async function fetchHTML(url){
  if (VERBOSE) console.log("  ↪ page:", url);
  const res = await axios.get(url, { responseType: "text", validateStatus: s=>s>=200 && s<400 });
  return res.data;
}

function extractLinks(html, base){
  const $ = cheerio.load(html);
  const out = [];
  $("a[href]").each((_,a)=>{
    const href = absURL(base, $(a).attr("href"));
    const text = ($(a).text()||"").trim();
    if (href && (GALLERY_HINT.test(href) || GALLERY_HINT.test(text))) out.push(href);
  });
  return uniq(out);
}

function extractImages(html, base){
  const $ = cheerio.load(html);
  const urls = [];

  $('meta[property="og:image"], meta[name="og:image"]').each((_,m)=>{
    urls.push(absURL(base, $(m).attr("content")));
  });
  $("img[src]").each((_,img)=>{
    urls.push(absURL(base, $(img).attr("src")));
  });

  return uniq(urls).filter(u => /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(u));
}

async function downloadImage(url){
  if (VERBOSE) console.log("    • img:", url);
  try{
    const res = await axios.get(url, { responseType: "arraybuffer", validateStatus: s=>s>=200 && s<400 });
    const buf = Buffer.from(res.data);
    const ct = (res.headers["content-type"]||"").toLowerCase();
    if (!ct.startsWith("image/")) return null;
    if (buf.length < MIN_BYTES) return null;
    return buf;
  }catch{ return null; }
}

async function goodPhoto(buf){
  try{
    const meta = await sharp(buf).metadata();
    if (!meta?.width || !meta?.height) return false;
    if (meta.width < MIN_W || meta.height < MIN_H) return false;
    if (meta.hasAlpha) return false;
    const aspect = meta.width / meta.height;
    if (aspect > MAX_ASPECT) return false;
    return true;
  }catch{ return false; }
}

async function writeJpeg(buf, destPath){
  await ensureDir(path.dirname(destPath));
  if (NEVER_OVERWRITE){
    let { dir, name, ext } = path.parse(destPath);
    let out = destPath, n = 1;
    while (true){
      try { await fs.access(out); n++; out = path.join(dir, `${name.replace(/-\d{2}$/,'')}-${String(n).padStart(2,'0')}${ext}`); }
      catch { break; }
    }
    await sharp(buf).jpeg({ quality: 88 }).toFile(out);
    return out;
  } else {
    await sharp(buf).jpeg({ quality: 88 }).toFile(destPath);
    return destPath;
  }
}

function allowed(url, official){
  const h = host(url);
  if (!h) return false;
  return sameHost(url, official) || ALLOWED_EXTERNAL.has(h);
}

// ===== Providers =====

// 1) Official site (home + discovered gallery pages)
async function* officialProvider(ev){
  const official = ev.url;
  if (!official) return;
  let html;
  try{ html = await fetchHTML(official);}catch{ return; }
  const pages = uniq([official, ...extractLinks(html, official)]).slice(0, 8);

  for (const p of pages){
    let ph;
    try{ ph = await fetchHTML(p);}catch{ continue; }
    const imgs = extractImages(ph, p)
      .filter(u => !LOGO_PAT.test(u))
      .filter(u => allowed(u, official));
    for (const u of imgs) yield u;
  }
}

// 2) Flickr (needs API key for best results)
async function* flickrProvider(ev){
  if (!FLICKR_API_KEY) return;
  const q = encodeURIComponent(`${ev.name} ${ev.city||""} ${ev.state||""}`);
  const url = `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${FLICKR_API_KEY}&text=${q}&sort=relevance&media=photos&content_type=1&safe_search=1&per_page=40&format=json&nojsoncallback=1`;
  try{
    const r = await fetch(url).then(r=>r.json());
    if (!r?.photos?.photo?.length) return;
    for (const p of r.photos.photo){
      const src = `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg`; // large
      yield src;
    }
  }catch{}
}

// 3) Reddit (direct images only from i.redd.it / preview.redd.it)
async function* redditProvider(ev){
  const q = encodeURIComponent(`${ev.name} ${ev.city||""} ${ev.state||""}`);
  const url = `https://www.reddit.com/search.json?q=${q}&sort=relevance&t=all&limit=25`;
  try{
    const r = await fetch(url, { headers: { "User-Agent": "trek4free-img/1.0" }}).then(r=>r.json());
    const posts = r?.data?.children || [];
    for (const c of posts){
      const d = c.data;
      const u = d?.url_overridden_by_dest || d?.url || "";
      if (/^https:\/\/(i|preview)\.redd\.it\/.+\.(jpg|jpeg|png|webp)$/i.test(u)) yield u;
    }
  }catch{}
}

// 4) Wikimedia Commons
async function* wikimediaProvider(ev){
  const q = encodeURIComponent(`${ev.name} ${ev.city||""} ${ev.state||""}`);
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=20&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json&origin=*`;
  try{
    const r = await fetch(url).then(r=>r.json());
    const pages = r?.query?.pages || {};
    for (const id in pages){
      const info = pages[id]?.imageinfo?.[0];
      const src = info?.thumburl || info?.url;
      if (src && /\.(jpg|jpeg|png|webp)$/i.test(src)) yield src;
    }
  }catch{}
}

// 5) Seeds (manual gallery or direct image URLs)
async function* seedsProvider(ev, seeds){
  if (!seeds || !seeds[ev.id]) return;
  for (const s of seeds[ev.id]){
    if (/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(s)) {
      yield s;
    } else {
      // treat as a page
      try{
        const html = await fetchHTML(s);
        const imgs = extractImages(html, s).filter(u => !LOGO_PAT.test(u));
        for (const u of imgs) yield u;
      }catch{}
    }
  }
}

// ===== Main per-event =====
async function processEvent(ev, seeds){
  const official = ev.url;
  if (!official){ return { id: ev.id, images: [], error: "missing official url" }; }

  if (VERBOSE) console.log(`\n▶ ${ev.id} — ${ev.name||""}`);

  // build candidate stream
  const gens = [
    seedsProvider(ev, seeds),
    officialProvider(ev),
    flickrProvider(ev),
    redditProvider(ev),
    wikimediaProvider(ev)
  ];

  const slug = ev.id ? ev.id : toSlug(ev.name||"event");
  const picked = [];

  for (const g of gens){
    // eslint-disable-next-line no-constant-condition
    while (true){
      const { value, done } = await g.next?.() ?? { done: true };
      if (done) break;
      const u = value;
      if (!u) continue;
      if (!allowed(u, official)) continue;
      const buf = await downloadImage(u);
      if (!buf) continue;
      if (!(await goodPhoto(buf))) continue;
      const baseName = `${slug}-${String(picked.length+1).padStart(2,'0')}.jpg`;
      const finalPath = await writeJpeg(buf, path.join(OUT_DIR, baseName));
      picked.push(`/images/events/${path.basename(finalPath)}`);
      if (picked.length >= PER_EVENT_MAX) break;
    }
    if (picked.length >= PER_EVENT_MAX) break;
  }

  if (VERBOSE) console.log(`  ✓ saved ${picked.length} photo(s)`);
  return { id: ev.id, images: picked };
}

// ===== Orchestrate =====
async function main(){
  await ensureDir(OUT_DIR);
  const events = JSON.parse(await fs.readFile(INPUT, "utf8"));
  let seeds = null;
  if (SEEDS){
    try { seeds = JSON.parse(await fs.readFile(SEEDS, "utf8")); } catch { /* optional */ }
  }

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(events.map(e => limit(()=>processEvent(e, seeds))));
  const ok = results.filter(r => r.images?.length);
  const fail = results.filter(r => !r.images?.length);

  await fs.writeFile(OUT_PATCH, JSON.stringify(ok, null, 2));
  console.log(`\n✅ ${OUT_PATCH} written: ${ok.length} / ${results.length} events have photos (multi-source).`);
  if (fail.length){
    console.log(`⚠️ ${fail.length} events had no acceptable photos:`);
    fail.forEach(f => console.log("-", f.id, f.error || ""));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
