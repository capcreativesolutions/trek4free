#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import pLimit from "p-limit";

const INPUT = process.argv[2] || "public/data/events/events.json";
const OUT_DIR = process.argv[3] || "public/images/events";           // where images will be saved
const OUT_PATCH = process.argv[4] || "images_patch.json";            // output patch
const PER_EVENT_MAX = 3;                                             // 1–3 images per event
const MIN_BYTES = 30_000;                                            // skip tiny icons
const CONCURRENCY = 4;

// Domains we trust for scraping images (official sites). We'll also accept absolute same-origin URLs.
const ALLOW_ANY_DOMAIN = false; // set true if you want to allow external (Wikimedia, Flickr) too
const EXTRA_ALLOWED = new Set([
  "upload.wikimedia.org", "static.wixstatic.com", "images.squarespace-cdn.com",
  "cdn-*.myshopify.com"
]);

function host(href) { try { return new URL(href).hostname; } catch { return ""; } }
function sameHost(a,b){ return a && b && host(a).replace(/^www\./,"") === host(b).replace(/^www\./,""); }
function allowed(u, official){
  if (sameHost(u, official)) return true;
  if (ALLOW_ANY_DOMAIN) return true;
  const h = host(u);
  for (const allow of EXTRA_ALLOWED) {
    if (allow.includes("*")) {
      const r = new RegExp("^" + allow.replace(/\./g,"\\.").replace(/\*/g,".*") + "$");
      if (r.test(h)) return true;
    } else if (h === allow) return true;
  }
  return false;
}

async function fetchHTML(url) {
  const res = await axios.get(url, { timeout: 20000, responseType: "text", validateStatus: s=>s>=200 && s<400 });
  return res.data;
}

function absURL(base, u) {
  if (!u) return null;
  try { return new URL(u, base).toString(); } catch { return null; }
}

function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }

function extractImages(html, baseUrl) {
  const dom = new JSDOM(html);
  const d = dom.window.document;

  const metas = [...d.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')]
    .map(m => absURL(baseUrl, m.getAttribute("content")));

  const imgs = [...d.images].map(img => absURL(baseUrl, img.getAttribute("src")));

  // Heuristic: prefer large images / “hero” classes
  const candidates = uniq([...metas, ...imgs])
    .filter(u => /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(u));

  return candidates.slice(0, 20);
}

async function headOrGetImage(url) {
  try {
    const res = await axios.get(url, { timeout: 25000, responseType: "arraybuffer", validateStatus: s=>s>=200 && s<400 });
    const buf = Buffer.from(res.data);
    const type = (res.headers["content-type"]||"").toLowerCase();
    if (!type.startsWith("image/")) return null;
    if (buf.length < MIN_BYTES) return null; // skip icons/thumbs
    return buf;
  } catch { return null; }
}

async function ensureDir(dir){ await fs.mkdir(dir, { recursive: true }); }

async function saveNormalized(buf, outPath) {
  // convert to webp (smaller) AND export jpg for broader compatibility
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".webp") {
    await sharp(buf).webp({ quality: 86 }).toFile(outPath);
  } else {
    await sharp(buf).jpeg({ quality: 88 }).toFile(outPath);
  }
  return outPath;
}

async function processEvent(ev) {
  const base = ev.url;
  if (!base) return { id: ev.id, images: [], error: "missing official url" };

  let html;
  try { html = await fetchHTML(base); }
  catch { return { id: ev.id, images: [], error: "failed to fetch event page" }; }

  const cand = extractImages(html, base).filter(u => allowed(u, base));
  const picked = [];
  for (const u of cand) {
    if (picked.length >= PER_EVENT_MAX) break;
    const buf = await headOrGetImage(u);
    if (!buf) continue;
    const slug = ev.id || (ev.name ? ev.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") : "event");
    const outName = `${slug}-${String(picked.length+1).padStart(2,"0")}.jpg`;
    const outPath = path.join(OUT_DIR, outName);
    await ensureDir(OUT_DIR);
    await saveNormalized(buf, outPath);
    picked.push(`/images/events/${outName}`);
  }
  return { id: ev.id, images: picked };
}

async function main(){
  const text = await fs.readFile(INPUT, "utf8");
  const events = JSON.parse(text);
  const limit = pLimit(CONCURRENCY);

  const results = await Promise.all(events.map(e => limit(()=>processEvent(e))));
  const ok = results.filter(r => r.images && r.images.length>0);
  const fail = results.filter(r => !r.images || r.images.length===0);

  await fs.writeFile(OUT_PATCH, JSON.stringify(ok, null, 2));
  console.log(`✅ images_patch.json written: ${ok.length} / ${results.length} events have images.`);
  if (fail.length) {
    console.log(`⚠️ ${fail.length} events had no acceptable images (likely blocked domains or none found):`);
    for (const f of fail) console.log("-", f.id, f.error || "");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
