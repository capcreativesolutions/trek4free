#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import sharp from "sharp";
import pLimit from "p-limit";

const INPUT = process.argv[2] || "public/data/events/events.json";
const OUT_DIR = process.argv[3] || "public/images/events";
const OUT_PATCH = process.argv[4] || "images_patch.json";
const SEEDS = process.argv[5] || null; // optional seeds.json

// Tunables
const PER_EVENT_MAX = 3;
const MIN_BYTES = 80_000;
const MIN_W = 1200;
const MIN_H = 700;
const MAX_ASPECT = 3.0;
const CONCURRENCY = 4;
const NEVER_OVERWRITE = true; // <-- set false if you do want overwrites

const LOGO_PAT = /(logo|icon|badge|sponsor|poster|flyer|map|bib|garmin|save[-_ ]?the[-_ ]?date)/i;
const GALLERY_HINT = /(gallery|photos|media|results|recap|photo|flickr)/i;

const ALLOW_ANY_DOMAIN = false;
const EXTRA_ALLOWED = new Set([
  "upload.wikimedia.org",
  "static.wixstatic.com",
  "images.squarespace-cdn.com",
  "live.staticflickr.com"
]);

function host(href){ try{ return new URL(href).hostname; }catch{ return ""; } }
function sameHost(a,b){ return a && b && host(a).replace(/^www\./,"") === host(b).replace(/^www\./,""); }
function allowed(u, official){
  if (sameHost(u, official)) return true;
  if (ALLOW_ANY_DOMAIN) return true;
  const h = host(u);
  if (!h) return false;
  for (const allow of EXTRA_ALLOWED){
    if (allow === h) return true;
  }
  return false;
}
function absURL(base, u){ try{ return new URL(u, base).toString(); }catch{ return null; } }
function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
function toSlug(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }

async function ensureDir(dir){ await fs.mkdir(dir, { recursive: true }); }

async function fetchHTML(url){
  const res = await axios.get(url, { timeout: 20000, responseType: "text", validateStatus: s=>s>=200 && s<400 });
  return res.data;
}

function extractLinks(html, baseUrl){
  const $ = cheerio.load(html);
  const anchors = [];
  $("a[href]").each((_,a)=>{
    const href = absURL(baseUrl, $(a).attr("href"));
    const text = ($(a).text()||"").trim();
    anchors.push({ href, text });
  });
  return uniq(
    anchors
      .filter(a => a.href && (GALLERY_HINT.test(a.href) || GALLERY_HINT.test(a.text)))
      .map(a => a.href)
  );
}

function extractImages(html, baseUrl){
  const $ = cheerio.load(html);
  const urls = [];

  // meta og:image
  $('meta[property="og:image"], meta[name="og:image"]').each((_,m)=>{
    const u = absURL(baseUrl, $(m).attr("content"));
    urls.push(u);
  });

  // <img src>
  $("img[src]").each((_,img)=>{
    const u = absURL(baseUrl, $(img).attr("src"));
    urls.push(u);
  });

  const out = uniq(urls).filter(u => /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(u));
  return out;
}

async function downloadImage(url){
  try{
    const res = await axios.get(url, { timeout: 25000, responseType: "arraybuffer", validateStatus: s=>s>=200 && s<400 });
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
    if (!meta || !meta.width || !meta.height) return false;
    if (meta.width < MIN_W || meta.height < MIN_H) return false;
    if (meta.hasAlpha) return false;                // often logos
    const aspect = meta.width / meta.height;
    if (aspect > MAX_ASPECT) return false;          // skinny banners
    return true;
  }catch{ return false; }
}

async function writeJpeg(buf, destPath){
  if (NEVER_OVERWRITE){
    // append incremental suffix if exists
    const { dir, name, ext } = path.parse(destPath);
    let n = 0, out = destPath;
    // name may end with -NN; we keep it and increment if needed
    while (true){
      try{
        await fs.access(out);
        n++;
        const suffix = String(n).padStart(2,"0");
        out = path.join(dir, `${name.replace(/-\d{2}$/, "")}-${suffix}${ext}`);
      }catch{
        break;
      }
    }
    await sharp(buf).jpeg({ quality: 88 }).toFile(out);
    return out;
  } else {
    await sharp(buf).jpeg({ quality: 88 }).toFile(destPath);
    return destPath;
  }
}

async function collectFromPage(pageUrl, officialUrl){
  const html = await fetchHTML(pageUrl);
  const imgs = extractImages(html, pageUrl)
    .filter(u => !LOGO_PAT.test(u))
    .filter(u => allowed(u, officialUrl));
  return imgs;
}

async function processEvent(ev, seeds){
  const official = ev.url;
  if (!official) return { id: ev.id, images: [], error: "missing official url" };

  await ensureDir(OUT_DIR);
  const slug = ev.id ? ev.id : toSlug(ev.name||"event");

  const candidatePages = [];
  if (seeds && seeds[ev.id] && Array.isArray(seeds[ev.id])) {
    candidatePages.push(...seeds[ev.id]);
  }

  // official page + discovered galleries
  try{
    const html = await fetchHTML(official);
    candidatePages.push(official);
    extractLinks(html, official).forEach(u => { if (!candidatePages.includes(u)) candidatePages.push(u); });
  }catch{
    return { id: ev.id, images: [], error: "failed to fetch event page" };
  }

  const found = new Set();
  for (const page of candidatePages){
    try{
      const urls = await collectFromPage(page, official);
      urls.forEach(u => found.add(u));
    }catch{/* ignore */}
    if (found.size >= 60) break;
  }

  const images = [];
  for (const u of [...found]){
    if (images.length >= PER_EVENT_MAX) break;
    const buf = await downloadImage(u);
    if (!buf) continue;
    if (!(await goodPhoto(buf))) continue;
    const baseName = `${slug}-${String(images.length+1).padStart(2,"0")}.jpg`;
    const savePath = path.join(OUT_DIR, baseName);
    const finalPath = await writeJpeg(buf, savePath);
    const fileName = path.basename(finalPath);
    images.push(`/images/events/${fileName}`);
  }

  return { id: ev.id, images };
}

async function main(){
  const text = await fs.readFile(INPUT, "utf8");
  const events = JSON.parse(text);

  let seeds = null;
  if (SEEDS){
    try{ seeds = JSON.parse(await fs.readFile(SEEDS, "utf8")); }catch{/* optional */}
  }

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(events.map(e => limit(()=>processEvent(e, seeds))));
  const ok = results.filter(r => r.images && r.images.length>0);
  const fail = results.filter(r => !r.images || r.images.length===0);

  await fs.writeFile(OUT_PATCH, JSON.stringify(ok, null, 2));
  console.log(`✅ ${OUT_PATCH} written: ${ok.length} / ${results.length} events have photos (logos filtered).`);
  if (fail.length){
    console.log(`⚠️ ${fail.length} events had no acceptable photos:`);
    fail.forEach(f => console.log("-", f.id, f.error || ""));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
