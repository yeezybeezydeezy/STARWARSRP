// Visor Editor upload service (Cloudflare Worker).
// The editor POSTs the visor texture it just built; this checks it really is one of the editor's visor VTFs,
// stores it once (named by its hash) on the `uploads` branch of the STARWARSRP repo, and returns the link PAC3 loads.
// The GitHub token lives only here, as the GITHUB_TOKEN secret (fine-grained, Contents read/write on STARWARSRP only).

const REPO = 'yeezybeezydeezy/STARWARSRP', BRANCH = 'uploads';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const SIZES = ['256x128', '512x256', '1024x512'], FRAMES = [24, 48, 96], PAINT_SIZES = [256, 512, 1024];   // 1024 = server max
const EYE_SIZES = [128, 256, 512], EYE_FRAMES = [60, 100, 120, 150];   // Jedi editor eye animations: 5 s loops at 12/20/24/30 fps
const PER_HOUR = 20;   // uploads per visitor per hour (best effort: counted per Worker instance)
const recent = new Map();

const allowOrigin = o => o === 'https://yeezybeezydeezy.github.io' || o === 'null' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o || '');

function json(body, status, origin) {
  const h = { 'content-type': 'application/json' };
  if (allowOrigin(origin)) Object.assign(h, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}

// exactly the file the editor writes: VTF 7.2, DXT1, clamped, full mip chain, every frame, nothing extra
function checkVTF(b) {
  if (b.byteLength < 80) return 'too small';
  const d = new DataView(b), u8 = new Uint8Array(b);
  if (u8[0] !== 86 || u8[1] !== 84 || u8[2] !== 70 || u8[3] !== 0) return 'not a VTF';
  if (d.getUint32(4, true) !== 7 || d.getUint32(8, true) !== 2 || d.getUint32(12, true) !== 80) return 'wrong VTF version';
  const w = d.getUint16(16, true), h = d.getUint16(18, true), frames = d.getUint16(24, true);
  const paint = frames === 1 && w === h && PAINT_SIZES.includes(w);   // a helmet paint with the visor blacked out
  const eyes = w === h && EYE_SIZES.includes(w) && EYE_FRAMES.includes(frames);   // a Rodian eye animation
  if (!paint && !eyes && (!SIZES.includes(`${w}x${h}`) || !FRAMES.includes(frames))) return 'not a visor texture size';
  if (d.getUint32(52, true) !== 13 || d.getUint32(57, true) !== 0xFFFFFFFF) return 'not DXT1';
  let lw = w, lh = h, mips = 0, bytes = 80;
  for (;;) { mips++; bytes += Math.max(1, Math.ceil(lw / 4)) * Math.max(1, Math.ceil(lh / 4)) * 8 * frames; if (lw === 1 && lh === 1) break; lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); }
  if (u8[56] !== mips || b.byteLength !== bytes) return 'unexpected file layout';
  return null;
}

function b64(buf) {
  const u8 = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gh(env, method, path, body) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'visor-editor-upload', 'x-github-api-version': '2022-11-28' },
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return json({}, 204, origin);
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/upload') return json({ error: 'POST /upload only' }, 404, origin);

    const ip = req.headers.get('cf-connecting-ip') || '?', now = Date.now();
    const hits = (recent.get(ip) || []).filter(t => now - t < 3600e3);
    if (hits.length >= PER_HOUR) return json({ error: 'Too many uploads, try again in an hour' }, 429, origin);

    const len = +req.headers.get('content-length') || 0;
    if (len > 18e6) return json({ error: 'File too big' }, 413, origin);
    const buf = await req.arrayBuffer();
    const bad = checkVTF(buf);
    if (bad) return json({ error: 'Rejected: ' + bad }, 400, origin);

    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].slice(0, 10).map(x => x.toString(16).padStart(2, '0')).join('');
    const path = `visor_${hash}.vtf`;
    // same texture uploaded before: reuse it
    if ((await gh(env, 'GET', `contents/${path}?ref=${BRANCH}`)).ok) return json({ url: RAW + path, reused: true }, 200, origin);

    const content = b64(buf);
    for (let attempt = 0; attempt < 3; attempt++) {   // two uploads at once can race on the branch head: retry
      const r = await gh(env, 'PUT', `contents/${path}`, { message: `Visor texture ${hash}`, content, branch: BRANCH });
      if (r.ok || r.status === 422) {   // 422: someone just stored the same file
        hits.push(now); recent.set(ip, hits);
        return json({ url: RAW + path }, 200, origin);
      }
      if (r.status !== 409) return json({ error: 'GitHub said ' + r.status }, 502, origin);
    }
    return json({ error: 'GitHub was busy, try again' }, 503, origin);
  },
};
