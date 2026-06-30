/**
 * Generate Chrome Web Store listing assets for Restura Capture at the exact
 * dimensions the dashboard requires, as 24-bit PNGs with NO alpha channel
 * (the Web Store rejects PNGs with alpha). Run: `node scripts/gen-store-assets.mjs`
 *
 * Outputs to ../store-assets/:
 *   screenshot-1280x800.png   — required listing screenshot (extension UI mock)
 *   small-promo-440x280.png   — small promo tile
 *   marquee-1400x560.png      — marquee promo tile
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'store-assets');

// Brand: single cobalt mark (#4aa0ff → #1162e0). Protocol accents mirror the
// side-panel RequestList badge colors so the promo matches the product.
const COBALT_A = '#4aa0ff';
const COBALT_B = '#1162e0';
const PROTO = {
  rest: '#127eee',
  graphql: '#e535ab',
  'grpc-web': '#2bb673',
  websocket: '#8b5cf6',
  sse: '#f59e0b',
};
const FONT = 'Helvetica, Arial, sans-serif';

/** The Routing-R brand chip (from public/icon.svg), placed + scaled. Unique
 *  gradient id per call so multiple chips on one canvas don't collide. */
function markChip(x, y, size, id) {
  const s = size / 96;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${COBALT_A}"/><stop offset="100%" stop-color="${COBALT_B}"/>
    </linearGradient></defs>
    <rect width="96" height="96" rx="22.08" fill="url(#${id})"/>
    <rect x="1" y="1" width="94" height="94" rx="21.08" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>
    <path d="M34 23 V73" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M34 23 H49 a14 14 0 0 1 0 28 H34" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M45 51 L64 73" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="65" cy="74" r="2.6" fill="#fff"/>
  </g>`;
}

/** A protocol pill (uppercase label on its accent color). */
function pill(x, y, label, color, w) {
  return `<g transform="translate(${x},${y})">
    <rect width="${w}" height="26" rx="13" fill="${color}"/>
    <text x="${w / 2}" y="17.5" font-family="${FONT}" font-size="12" font-weight="700"
      letter-spacing="0.6" fill="#fff" text-anchor="middle">${label.toUpperCase()}</text>
  </g>`;
}

const ESC = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Deep navy → cobalt diagonal backdrop with a faint dot grid. */
function backdrop(w, h) {
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a1020"/><stop offset="55%" stop-color="#0e1a36"/>
      <stop offset="100%" stop-color="#15346e"/>
    </linearGradient>
    <radialGradient id="glow" cx="78%" cy="18%" r="55%">
      <stop offset="0%" stop-color="#1162e0" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#1162e0" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="1.2" cy="1.2" r="1.2" fill="#ffffff" fill-opacity="0.05"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#dots)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>`;
}

/** A small "capture panel" mock used as a hero visual on the marquee. */
function capturePanel(x, y, w, h) {
  const rows = [
    { p: 'rest', m: 'GET', path: '/api/users', s: 200 },
    { p: 'graphql', m: 'POST', path: '/graphql', s: 200 },
    { p: 'websocket', m: 'WS', path: '/ws/live', s: 101 },
    { p: 'sse', m: 'GET', path: '/events/stream', s: 200 },
    { p: 'grpc-web', m: 'POST', path: '/svc.User/Get', s: 200 },
  ];
  const rowH = 46;
  const body = rows
    .map((r, i) => {
      const ry = 58 + i * rowH;
      const w0 = r.p === 'grpc-web' ? 66 : r.p.length * 8 + 22;
      return `<g transform="translate(20,${ry})">
        ${pill(0, 2, r.p, PROTO[r.p], w0)}
        <text x="${w0 + 14}" y="20" font-family="${FONT}" font-size="14" font-weight="700" fill="#cfe0ff">${r.m}</text>
        <text x="${w0 + 64}" y="20" font-family="${FONT}" font-size="14" fill="#9fb4d8">${ESC(r.path)}</text>
        <text x="${w - 50}" y="20" font-family="${FONT}" font-size="13" fill="#5f7aa6" text-anchor="end">${r.s}</text>
        <rect x="-4" y="${rowH - 8}" width="${w - 32}" height="1" fill="#ffffff" fill-opacity="0.06"/>
      </g>`;
    })
    .join('');
  return `<g transform="translate(${x},${y})">
    <rect width="${w}" height="${h}" rx="16" fill="#0c1426" stroke="#ffffff" stroke-opacity="0.10"/>
    <g transform="translate(20,22)">
      <circle cx="6" cy="6" r="5" fill="#ff5f56"/><circle cx="24" cy="6" r="5" fill="#ffbd2e"/><circle cx="42" cy="6" r="5" fill="#27c93f"/>
      <text x="64" y="11" font-family="${FONT}" font-size="13" font-weight="600" fill="#9fb4d8">Capture — current tab</text>
      <circle cx="${w - 30}" cy="6" r="5" fill="#ff5f56"/>
    </g>
    ${body}
  </g>`;
}

async function rasterize(svg, w, h, file) {
  // flatten() composites away any alpha → 24-bit RGB, exactly what the Store wants.
  await sharp(Buffer.from(svg))
    .resize(w, h)
    .flatten({ background: '#0a1020' })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(join(OUT, file));
  console.log(`✓ ${file}  (${w}×${h}, 24-bit, no alpha)`);
}

/* ----------------------------- Marquee 1400×560 ---------------------------- */
function marquee() {
  const W = 1400,
    H = 560;
  const protos = ['rest', 'graphql', 'websocket', 'sse', 'grpc-web'];
  let px = 96;
  const pills = protos
    .map((p) => {
      const label = p === 'rest' ? 'HTTP' : p === 'grpc-web' ? 'gRPC-web' : p;
      const w = label.length * 9 + 26;
      const g = pill(px, 372, label, PROTO[p], w);
      px += w + 12;
      return g;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${backdrop(W, H)}
    ${markChip(96, 96, 96, 'm1')}
    <text x="212" y="146" font-family="${FONT}" font-size="64" font-weight="800" fill="#ffffff" letter-spacing="-1">Restura Capture</text>
    <text x="214" y="190" font-family="${FONT}" font-size="24" font-weight="600" fill="#7fa8e6" letter-spacing="0.3">Postman Interceptor, for every protocol</text>
    <text x="96" y="262" font-family="${FONT}" font-size="25" fill="#c8d8f5">Capture real browser traffic across every</text>
    <text x="96" y="298" font-family="${FONT}" font-size="25" fill="#c8d8f5">protocol — secrets redacted, export to HAR.</text>
    ${pills}
    ${capturePanel(862, 96, 442, 368)}
  </svg>`;
}

/* --------------------------- Small promo 440×280 --------------------------- */
function smallPromo() {
  const W = 440,
    H = 280;
  const dots = ['rest', 'graphql', 'grpc-web', 'websocket', 'sse']
    .map((p, i) => `<circle cx="${162 + i * 30}" cy="232" r="7" fill="${PROTO[p]}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${backdrop(W, H)}
    ${markChip(W / 2 - 40, 44, 80, 's1')}
    <text x="${W / 2}" y="166" font-family="${FONT}" font-size="34" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-0.5">Restura Capture</text>
    <text x="${W / 2}" y="198" font-family="${FONT}" font-size="16" fill="#8fb0e8" text-anchor="middle">Multi-protocol traffic → collections</text>
    ${dots}
  </svg>`;
}

/* --------------------------- Screenshot 1280×800 --------------------------- */
function screenshot() {
  const W = 1280,
    H = 800;
  // A faithful mock of the side-panel UI (sidepanel/main.tsx + RequestList.tsx),
  // framed as a docked panel on the brand backdrop.
  const rows = [
    { p: 'rest', m: 'GET', path: '/api/users', s: 200 },
    { p: 'rest', m: 'POST', path: '/api/login', s: 201 },
    { p: 'graphql', m: 'POST', path: '/graphql', s: 200 },
    { p: 'websocket', m: 'WS', path: '/ws/live', s: 101 },
    { p: 'sse', m: 'GET', path: '/events/stream', s: 200 },
    { p: 'grpc-web', m: 'POST', path: '/user.UserService/Get', s: 200 },
    { p: 'rest', m: 'GET', path: '/api/orders?status=open', s: 200 },
    { p: 'graphql', m: 'POST', path: '/graphql', s: 200 },
  ];
  const panelX = 648,
    panelY = 92,
    panelW = 512,
    panelH = 616;
  const buttons = ['Export OpenCollection', 'Export HAR', 'Send to Desktop', 'Clear'];
  let bx = 0;
  const btnRow = buttons
    .map((b) => {
      const w = b.length * 7.2 + 22;
      const g = `<g transform="translate(${bx},0)">
        <rect width="${w}" height="30" rx="7" fill="#eef2f9" stroke="#d3dcea"/>
        <text x="${w / 2}" y="19.5" font-family="${FONT}" font-size="12.5" font-weight="600" fill="#2a3b57" text-anchor="middle">${ESC(b)}</text>
      </g>`;
      bx += w + 8;
      return g;
    })
    .join('');
  const list = rows
    .map((r, i) => {
      const ry = 150 + i * 52;
      const w0 = r.p === 'grpc-web' ? 70 : r.p.length * 8 + 22;
      return `<g transform="translate(20,${ry})">
        ${pill(0, 4, r.p, PROTO[r.p], w0)}
        <text x="${w0 + 16}" y="22" font-family="${FONT}" font-size="15" font-weight="700" fill="#1f2d45">${r.m}</text>
        <text x="${w0 + 70}" y="22" font-family="${FONT}" font-size="15" fill="#3c5170">${ESC(r.path)}</text>
        <text x="${panelW - 40}" y="22" font-family="${FONT}" font-size="14" fill="#8a9bb6" text-anchor="end">${r.s}</text>
        <rect x="-6" y="44" width="${panelW - 28}" height="1" fill="#eceff5"/>
      </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${backdrop(W, H)}
    <text x="96" y="168" font-family="${FONT}" font-size="38" font-weight="800" fill="#ffffff" letter-spacing="-0.5">See every request,</text>
    <text x="96" y="214" font-family="${FONT}" font-size="38" font-weight="800" fill="#ffffff" letter-spacing="-0.5">across every protocol.</text>
    <text x="98" y="284" font-family="${FONT}" font-size="20" fill="#9fb8e6">Live capture in the side panel — filter, inspect,</text>
    <text x="98" y="314" font-family="${FONT}" font-size="20" fill="#9fb8e6">and export to a Restura collection or HAR.</text>
    <g transform="translate(96,372)">
      ${['rest', 'graphql', 'websocket', 'sse', 'grpc-web']
        .map((p, i) => `<circle cx="${12 + i * 34}" cy="12" r="9" fill="${PROTO[p]}"/>`)
        .join('')}
      <text x="190" y="17" font-family="${FONT}" font-size="15" fill="#7e98c8">HTTP · GraphQL · WebSocket · SSE · gRPC-web</text>
    </g>

    <!-- side panel card -->
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="18" fill="#ffffff"/>
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="18" fill="none" stroke="#ffffff" stroke-opacity="0.5"/>
    <g transform="translate(${panelX},${panelY})">
      <text x="20" y="44" font-family="${FONT}" font-size="20" font-weight="800" fill="#16223a">Restura Capture</text>
      <circle cx="194" cy="38" r="6" fill="#ef4444"/>
      <text x="208" y="43" font-family="${FONT}" font-size="13" font-weight="600" fill="#ef4444">Capturing</text>
      <!-- filter row -->
      <rect x="20" y="62" width="${panelW - 150}" height="32" rx="8" fill="#f4f6fb" stroke="#e2e8f2"/>
      <text x="34" y="83" font-family="${FONT}" font-size="13" fill="#9aa7bd">Filter URL…</text>
      <rect x="${panelW - 122}" y="62" width="102" height="32" rx="8" fill="#f4f6fb" stroke="#e2e8f2"/>
      <text x="${panelW - 110}" y="83" font-family="${FONT}" font-size="13" fill="#5b6b86">all ▾</text>
      <!-- action buttons -->
      <g transform="translate(20,108)">${btnRow}</g>
      ${list}
    </g>
  </svg>`;
}

await rasterize(screenshot(), 1280, 800, 'screenshot-1280x800.png');
await rasterize(smallPromo(), 440, 280, 'small-promo-440x280.png');
await rasterize(marquee(), 1400, 560, 'marquee-1400x560.png');
console.log(`\nAssets written to ${OUT}`);
