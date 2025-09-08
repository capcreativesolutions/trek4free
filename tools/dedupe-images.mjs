import fs from "fs";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";

const [, , folder = "public/images/events", ...argv] = process.argv;
const args = Object.fromEntries(argv.map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));

const MODE = (args.mode || "report");        // report | move | delete
const OUT  = args.out || "public/images/_dupes";
const TH   = Number(args.threshold ?? 6);     // Hamming distance for aHash near-dup
const DRY  = !!args.dry;

function listFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .map(f => path.join(dir, f));
}

async function fileHash(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("md5").update(buf).digest("hex");
}
async function aHash(p) {
  const buf = await sharp(p).resize(8,8,{fit:"cover"}).grayscale().raw().toBuffer();
  const avg = buf.reduce((a,b)=>a+b,0)/buf.length;
  let bits = "";
  for (const v of buf) bits += (v > avg ? "1":"0");
  return bits;
}
function hamming(a,b){ let d=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++; return d; }

(async () => {
  if (!fs.existsSync(folder)) { console.error("Folder not found:", folder); process.exit(1); }
  const files = listFiles(folder);
  console.log(`Scanning ${files.length} images in ${folder} ...`);
  if (!files.length) return;

  const exactMap = new Map();   // md5 -> keeper
  const dupExact = [];          // [dupe, keeper]

  // exact dupes first
  for (const f of files) {
    const md5 = await fileHash(f);
    if (exactMap.has(md5)) dupExact.push([f, exactMap.get(md5)]);
    else exactMap.set(md5, f);
  }

  // near dupes (aHash)
  const keepers = [...exactMap.values()];
  const aHashes = await Promise.all(keepers.map(async f => [f, await aHash(f)]));
  const dupNear = [];           // [dupe, keeper, dist]
  const mark = new Set();

  for (let i=0;i<aHashes.length;i++){
    const [fi, hi] = aHashes[i];
    if (mark.has(fi)) continue;
    for (let j=i+1;j<aHashes.length;j++){
      const [fj, hj] = aHashes[j];
      if (mark.has(fj)) continue;
      const d = hamming(hi, hj);
      if (d <= TH) { dupNear.push([fj, fi, d]); mark.add(fj); }
    }
  }

  const total = dupExact.length + dupNear.length;
  console.log(`Found ${dupExact.length} exact dupes and ${dupNear.length} near dupes (≤ ${TH}).`);

  if (MODE === "report" || DRY || total === 0) {
    for (const [f,k] of dupExact) console.log(`EXACT  | ${path.basename(f)}  -> keep ${path.basename(k)}`);
    for (const [f,k,d] of dupNear) console.log(`NEAR ${d}| ${path.basename(f)}  -> keep ${path.basename(k)}`);
    if (DRY) console.log("(dry run: no changes)");
    return;
  }

  if (MODE === "move" && !fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const act = [];
  for (const pair of [...dupExact.map(x=>[...x, "EXACT"]), ...dupNear.map(x=>[...x, "NEAR"])]) {
    const [dupe, keeper, kindOrDist] = pair;
    if (MODE === "move") {
      const dest = path.join(OUT, path.basename(dupe));
      fs.renameSync(dupe, dest);
      act.push([kindOrDist, path.basename(dupe), "→", dest]);
    } else if (MODE === "delete") {
      fs.unlinkSync(dupe);
      act.push([kindOrDist, "deleted", path.basename(dupe)]);
    }
  }
  console.log(`Action: ${MODE}. ${act.length} files processed.`);
})();
