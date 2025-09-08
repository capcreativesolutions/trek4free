// tools/grab-event-dates.v2.mjs
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { DateTime } from "luxon";

// CLI: node tools/grab-event-dates.v2.mjs events.json patch_dates.json [--inplace] [--verbose]
const [,, eventsPath = "public/data/events/events.json", outPath = "public/data/events/patch_dates.json", ...flags] = process.argv;
const INPLACE  = flags.includes("--inplace");
const VERBOSE  = flags.includes("--verbose");

const limit = pLimit(6);

// ---------- helpers ----------
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function monthIndex(m) {
  const map = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12,
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12
  };
  return map[m.toLowerCase()] || null;
}
function toISO(y, m, d) {
  const dt = DateTime.fromObject({ year: +y, month: +m, day: +d });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd") : null;
}
function probableTZ(state) {
  const PT = new Set(["CA","WA","OR","NV"]);
  const MT = new Set(["AZ","CO","ID","MT","NM","UT","WY"]);
  const CT = new Set(["AL","AR","IA","IL","KS","LA","MN","MO","MS","ND","NE","OK","SD","TX","WI"]);
  const ET = new Set(["CT","DC","DE","FL","GA","IN","KY","MA","MD","ME","MI","NC","NH","NJ","NY","OH","PA","RI","SC","TN","VA","VT","WV"]);
  if (PT.has(state)) return "America/Los_Angeles";
  if (MT.has(state)) return "America/Denver";
  if (CT.has(state)) return "America/Chicago";
  if (ET.has(state)) return "America/New_York";
  return null;
}
async function fetchHTML(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 20000,
      headers: { "User-Agent": "trek4free-bot/1.0 (+https://trek4free.com)" }
    });
    return data;
  } catch (e) {
    if (VERBOSE) console.log("  ! fetch failed:", url, e?.response?.status ?? e.message);
    return null;
  }
}

// ---------- patterns (fixed) ----------
const MONTH_ALTS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const DAY = "(?:[0-2]?\\d|3[01])";
const YEAR = "(20\\d{2})";

// "June 8–9, 2025"   or "Jun 8-9, 2025"
const RANGE_MM_DD_DD = new RegExp(`\\b(${MONTH_ALTS})\\s+(${DAY})\\s*[–-]\\s*(${DAY}),?\\s*${YEAR}\\b`, "i");
// "June 8, 2025"
const SINGLE_MM_DD_YYYY = new RegExp(`\\b(${MONTH_ALTS})\\s+(${DAY}),?\\s*${YEAR}\\b`, "i");
// "2025-06-08" or "2025/06/08"
const ISO_YMD = /\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/;
// "6/8/2025"
const US_MDY = /\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](20\d{2})\b/;

function extractFromText(text) {
  // 1) Long month range
  let m = text.match(RANGE_MM_DD_DD);
  if (m && m[1] && m[2] && m[3] && m[4]) {
    const month = monthIndex(m[1]);
    if (month) {
      const d1 = String(m[2]).padStart(2, "0");
      const d2 = String(m[3]).padStart(2, "0");
      const y  = m[4];
      const start = toISO(y, month, d1);
      const end   = toISO(y, month, d2);
      if (start && end) return { start, end, via: "range-long" };
    }
  }
  // 2) Single long month "June 8, 2025"
  m = text.match(SINGLE_MM_DD_YYYY);
  if (m && m[1] && m[2] && m[3]) {
    const month = monthIndex(m[1]);
    if (month) {
      const d = String(m[2]).padStart(2, "0");
      const y = m[3];
      const iso = toISO(y, month, d);
      if (iso) return { start: iso, end: iso, via: "single-long" };
    }
  }
  // 3) ISO 2025-06-08
  m = text.match(ISO_YMD);
  if (m) {
    const [_, y, mo, d] = m;
    const iso = toISO(y, mo, d);
    if (iso) return { start: iso, end: iso, via: "iso" };
  }
  // 4) US numeric 6/8/2025
  m = text.match(US_MDY);
  if (m) {
    const [_, mo, d, y] = m;
    const iso = toISO(y, mo, d);
    if (iso) return { start: iso, end: iso, via: "us-numeric" };
  }
  return null;
}

function extractFromJSONLD($) {
  const blocks = $('script[type="application/ld+json"]').toArray();
  for (const el of blocks) {
    let txt = $(el).contents().text().trim();
    if (!txt) continue;
    try {
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const list = node?.["@graph"] ? node["@graph"] : [node];
        for (const n of list) {
          const types = []
            .concat(n?.["@type"] || [])
            .map(x => (typeof x === "string" ? x : ""))
            .filter(Boolean);
          if (types.includes("Event") && (n.startDate || n.endDate)) {
            const start = n.startDate?.slice(0,10) || null;
            const end   = n.endDate?.slice(0,10) || start || null;
            if (start) return { start, end, via: "jsonld" };
          }
        }
      }
    } catch { /* ignore broken JSON-LD blocks */ }
  }
  return null;
}

function extractMetaText($) {
  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const ogDesc  = $('meta[property="og:description"]').attr("content") || "";
  const twTitle = $('meta[name="twitter:title"]').attr("content") || "";
  const twDesc  = $('meta[name="twitter:description"]').attr("content") || "";
  return [ogTitle, ogDesc, twTitle, twDesc].join(" • ");
}

async function processEvent(ev) {
  if (!ev?.url || ev.dateStart) return null;
  const tz = ev.timezone || probableTZ(ev.state) || null;

  const html = await fetchHTML(ev.url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // 1) JSON-LD
  const ld = extractFromJSONLD($);
  if (ld?.start) {
    if (VERBOSE) console.log(`✔ ${ev.id} -> ${ld.start}${ld.end && ld.end!==ld.start ? "–"+ld.end : ""} (jsonld)`);
    return { id: ev.id, dateStart: ld.start, dateEnd: ld.end || ld.start, timezone: tz };
  }

  // 2) Meta + body text
  const text = `${extractMetaText($)} • ${$("body").text().replace(/\s+/g, " ").trim()}`.slice(0, 250000);
  const guess = extractFromText(text);
  if (guess?.start) {
    if (VERBOSE) console.log(`✔ ${ev.id} -> ${guess.start}${guess.end && guess.end!==guess.start ? "–"+guess.end : ""} (${guess.via})`);
    return { id: ev.id, dateStart: guess.start, dateEnd: guess.end || guess.start, timezone: tz };
  }

  if (VERBOSE) console.log(`— ${ev.id}: no dates found`);
  return null;
}

(async () => {
  const events = readJSON(eventsPath);
  const targets = events.filter(e => !e.dateStart && e.url?.startsWith("https://"));
  if (VERBOSE) console.log(`Scanning ${targets.length} events missing dates...`);

  const results = await Promise.all(targets.map(e => limit(() => processEvent(e))));
  const patches = results.filter(Boolean);

  writeJSON(outPath, patches);
  console.log(`patch_dates.json written: ${patches.length} patch(es)`);

  if (INPLACE && patches.length) {
    const map = new Map(patches.map(p => [p.id, p]));
    const updated = events.map(e => {
      const p = map.get(e.id);
      return p ? { ...e, dateStart: p.dateStart, dateEnd: p.dateEnd ?? p.dateStart, timezone: e.timezone ?? p.timezone ?? null } : e;
    });
    writeJSON(eventsPath, updated);
    console.log(`events.json updated in place: ${patches.length} record(s) patched`);
  }
})();
