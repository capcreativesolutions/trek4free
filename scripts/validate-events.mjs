// scripts/validate-events.mjs
import fs from "fs";

const LEVELS = ["Beginner-Friendly", "Intermediate", "Advanced", "Expert"];
const TYPES = ["Ultrarun", "Trail Run", "Paddle Race", "Basejump", "Aerial/Balloons", "Off-Road/Vehicle", "Multi-sport", "Other"];
const FREQ_HINTS = ["Annual", "One-off"]; // we allow variations (e.g., "Annual (lottery)")

const REQUIRED = ["id","name","type","city","state","lat","lon","usualDate","freq","level","hook","url"];

function readJson(path){
  const raw = fs.readFileSync(path, "utf-8").trim();
  let data;
  try { data = JSON.parse(raw); } catch(e) {
    fail(`File is not valid JSON: ${path}\n${e.message}`);
  }
  if (!Array.isArray(data)) {
    fail(`Top-level JSON must be an array (received ${typeof data}) in ${path}`);
  }
  return data;
}

function fail(msg){ console.error("Validation failed:\n" + msg); process.exit(1); }

function softIncludesFreq(freq){
  // allow "Annual (lottery)" etc.
  return FREQ_HINTS.some(h => freq && freq.toLowerCase().includes(h.toLowerCase()));
}

function isKebab(s){ return typeof s === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s); }

function validateFile(path){
  const data = readJson(path);
  const errors = [];
  const seen = new Set();

  data.forEach((ev, idx) => {
    const where = `${path}[${idx}]`;

    // Required
    for (const f of REQUIRED) {
      if (ev[f] === undefined || ev[f] === null || (typeof ev[f] === "string" && ev[f].trim() === "")) {
        errors.push(`❌ ${where}: missing/empty field "${f}" (id=${ev.id ?? "?"})`);
      }
    }

    // id
    if (ev.id && !isKebab(ev.id)) {
      errors.push(`❌ ${where}: id must be kebab-case (id=${ev.id})`);
    }
    if (ev.id) {
      if (seen.has(ev.id)) errors.push(`❌ ${where}: duplicate id "${ev.id}"`);
      seen.add(ev.id);
    }

    // type
    if (ev.type && !Array.isArray(ev.type)) {
      errors.push(`❌ ${where}: type must be an array`);
    } else if (Array.isArray(ev.type)) {
      ev.type.forEach(t => {
        if (!TYPES.includes(t)) errors.push(`❌ ${where}: invalid type "${t}" (allowed: ${TYPES.join(", ")})`);
      });
    }

    // state
    if (ev.state && !/^[A-Z]{2}$/.test(ev.state)) {
      errors.push(`❌ ${where}: invalid state "${ev.state}" (must be 2-letter USPS)`);
    }

    // level
    if (ev.level && !LEVELS.includes(ev.level)) {
      errors.push(`❌ ${where}: invalid level "${ev.level}" (allowed: ${LEVELS.join(", ")})`);
    }

    // coords
    if (typeof ev.lat !== "number" || ev.lat < -90 || ev.lat > 90) {
      errors.push(`❌ ${where}: bad latitude "${ev.lat}"`);
    }
    if (typeof ev.lon !== "number" || ev.lon < -180 || ev.lon > 180) {
      errors.push(`❌ ${where}: bad longitude "${ev.lon}"`);
    }

    // freq
    if (typeof ev.freq !== "string" || ev.freq.trim() === "") {
      errors.push(`❌ ${where}: freq must be a non-empty string`);
    } else if (!softIncludesFreq(ev.freq)) {
      // not fatal, just a nudge
      if (!ev.freq.toLowerCase().includes("annual") && !ev.freq.toLowerCase().includes("one-off")) {
        errors.push(`⚠️  ${where}: freq "${ev.freq}" is unusual (expected "Annual..." or "One-off")`);
      }
    }

    // url
    if (ev.url && !/^https?:\/\//i.test(ev.url)) {
      errors.push(`❌ ${where}: url must start with http(s)`);
    }
  });

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  } else {
    console.log(`✅ ${path} passed validation with ${data.length} events.`);
  }
}

const file = process.argv[2] || "./public/data/events/events.json";
validateFile(file);
