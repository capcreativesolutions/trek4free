import type { APIRoute } from 'astro';
import { promises as fs } from 'fs';
import path from 'path';

const ALLOWED = {
  free_camping: 'freecamping-submissions.json',
  camping: 'camping-submissions.json',
  trail: 'trails-submissions.json',
  event: 'events-submissions.json',
} as const;

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const type = String(form.get('type') || '');
    if (!(type in ALLOWED)) {
      return new Response(JSON.stringify({ message: 'Invalid type' }), { status: 400 });
    }

    // Common fields
    const name = String(form.get('name') || '').trim();
    const lat = Number(form.get('lat'));
    const lon = Number(form.get('lon'));
    const description = String(form.get('description') || '').trim();

    if (!name || Number.isNaN(lat) || Number.isNaN(lon) || !description) {
      return new Response(JSON.stringify({ message: 'Missing required fields' }), { status: 400 });
    }

    // Type-specific
    const payload: any = {
      id: slugify(name),
      type,
      name,
      lat,
      lon,
      description,
      submitted_at: new Date().toISOString(),
      status: 'pending',
      source: 'user',
    };

    if (type === 'free_camping') {
      payload.access_notes = String(form.get('access_notes') || '').trim() || undefined;
      payload.max_rig_length = parseOptionalNumber(form.get('max_rig_length'));
      payload.water = pickEnum(String(form.get('water') || 'unknown'), ['unknown','yes','no']);
      payload.toilets = pickEnum(String(form.get('toilets') || 'unknown'), ['unknown','vault','flush','none']);
      payload.stay_limit = parseOptionalNumber(form.get('stay_limit'));
    }

    if (type === 'camping') {
      payload.fee_desc = String(form.get('fee_desc') || '').trim() || undefined;
      payload.site_type = pickEnum(String(form.get('site_type') || 'mixed'), ['tent','rv','mixed']);
      payload.reservations = pickEnum(String(form.get('reservations') || 'unknown'), ['unknown','required','recommended','first_come']);
    }

    if (type === 'trail') {
      payload.distance_mi = parseOptionalNumber(form.get('distance_mi'));
      payload.elevation_ft = parseOptionalNumber(form.get('elevation_ft'));
      payload.dogs = pickEnum(String(form.get('dogs') || 'unknown'), ['unknown','yes_leash','no']);
      payload.gpx_url = String(form.get('gpx_url') || '').trim() || undefined;
    }

    if (type === 'event') {
      const start = String(form.get('start_date') || '').trim();
      const end = String(form.get('end_date') || '').trim();
      payload.start_date = start || undefined;
      payload.end_date = end || undefined;
      payload.website = String(form.get('website') || '').trim() || undefined;
    }

    // Append to the correct pending file
    const rel = path.join('public', 'data', 'pending', ALLOWED[type as keyof typeof ALLOWED]);
    const file = path.join(process.cwd(), rel);

    // Ensure folder exists
    await fs.mkdir(path.dirname(file), { recursive: true });

    let arr: any[] = [];
    try {
      const raw = await fs.readFile(file, 'utf-8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }

    arr.push(payload);
    await fs.writeFile(file, JSON.stringify(arr, null, 2), 'utf-8');

    return new Response(JSON.stringify({ ok: true, message: 'Thanks! Your submission is pending review.' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: 'Server error' }), { status: 500 });
  }
};

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}
function parseOptionalNumber(v: FormDataEntryValue | null) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function pickEnum<T extends string>(v: string, allowed: readonly T[]): T {
  return (allowed as readonly string[]).includes(v) ? (v as T) : (allowed[0] as T);
}
