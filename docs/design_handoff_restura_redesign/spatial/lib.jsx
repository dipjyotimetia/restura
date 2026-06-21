// Spatial · shared library — palettes, Floater, icons, mock data, helpers

const ACCENT_DEFAULT = '#4d9fff';

function makePalette(theme, accent) {
  if (theme === 'light') {
    return {
      name: 'light',
      bg: '#eef2fa',
      bgGlow: `radial-gradient(ellipse 70% 60% at 20% -10%, ${accent}29, transparent 60%), radial-gradient(ellipse 60% 50% at 90% 100%, rgba(167,139,250,0.18), transparent 60%), #eef2fa`,
      surface: '#ffffff',
      surfaceHi: '#fafbfd',
      surfaceLo: '#f3f5f9',
      text: '#0e1320',
      textMuted: 'rgba(14,19,32,0.6)',
      textDim: 'rgba(14,19,32,0.38)',
      line: 'rgba(14,19,32,0.07)',
      lineStrong: 'rgba(14,19,32,0.12)',
      accent,
      code: '#fbfcfe',
      hoverBg: 'rgba(14,19,32,0.04)',
      activeBg: `${accent}1f`,
      floatShadow:
        '0 1px 0 rgba(255,255,255,0.6) inset, 0 8px 24px rgba(20,30,60,0.08), 0 1px 3px rgba(20,30,60,0.05)',
      floatShadowLg:
        '0 1px 0 rgba(255,255,255,0.6) inset, 0 20px 50px rgba(20,30,60,0.15), 0 4px 12px rgba(20,30,60,0.08)',
      kbdBg: 'rgba(14,19,32,0.06)',
    };
  }
  return {
    name: 'dark',
    bg: '#06080f',
    bgGlow: `radial-gradient(ellipse 70% 60% at 20% -10%, ${accent}38, transparent 60%), radial-gradient(ellipse 60% 50% at 90% 100%, rgba(99,102,241,0.22), transparent 60%), #06080f`,
    surface: 'rgba(20,24,34,0.85)',
    surfaceHi: 'rgba(28,33,45,0.9)',
    surfaceLo: 'rgba(14,17,24,0.7)',
    text: '#eef1f9',
    textMuted: 'rgba(238,241,249,0.62)',
    textDim: 'rgba(238,241,249,0.36)',
    line: 'rgba(255,255,255,0.06)',
    lineStrong: 'rgba(255,255,255,0.12)',
    accent,
    code: '#0a0d14',
    hoverBg: 'rgba(255,255,255,0.04)',
    activeBg: `${accent}26`,
    floatShadow:
      '0 1px 0 rgba(255,255,255,0.05) inset, 0 12px 36px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4)',
    floatShadowLg:
      '0 1px 0 rgba(255,255,255,0.06) inset, 0 24px 60px rgba(0,0,0,0.65), 0 6px 18px rgba(0,0,0,0.5)',
    kbdBg: 'rgba(255,255,255,0.06)',
  };
}

// ─── Floater ──────────────────────────────────────────────────────────
function Floater({ p, children, style, radius = 14, large, hover, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: p.surface,
        borderRadius: radius,
        border: `1px solid ${p.line}`,
        boxShadow: large ? p.floatShadowLg : p.floatShadow,
        backdropFilter: p.name === 'dark' ? 'blur(24px) saturate(180%)' : 'none',
        WebkitBackdropFilter: p.name === 'dark' ? 'blur(24px) saturate(180%)' : 'none',
        transition: 'transform .15s, box-shadow .15s, background .12s',
        cursor: onClick || hover ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────
const SIcon = {
  send: (p) => svg(p, 'M22 2L11 13|M22 2L15 22L11 13L2 9L22 2Z'),
  search: (p) => svg(p, 'circ:11,11,7|M21 21l-4.3-4.3'),
  plus: (p) => svg(p, 'M12 5v14M5 12h14'),
  folder: (p) => svg(p, 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z'),
  history: (p) => svg(p, 'M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8|M3 3v5h5|M12 7v5l4 2'),
  workflow: (p) =>
    svg(p, 'rect:3,3,6,6|rect:15,3,6,6|rect:9,15,6,6|M6 9v2a2 2 0 002 2h8a2 2 0 002-2V9'),
  globe: (p) => svg(p, 'circ:12,12,9|M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18'),
  bolt: (p) => svg(p, 'M13 2L3 14h7l-1 8L19 10h-7l1-8z'),
  chevron: (p) => svg(p, 'M6 9l6 6 6-6', 2.4),
  arrow: (p) => svg(p, 'M9 6l6 6-6 6', 2.4),
  cog: (p) =>
    svg(
      p,
      'circ:12,12,3|M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z'
    ),
  link: (p) =>
    svg(
      p,
      'M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07L11.6 4.6|M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07L12.4 19.4'
    ),
  copy: (p) => svg(p, 'rect:9,9,13,13|M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1'),
  download: (p) => svg(p, 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4|M7 10l5 5 5-5|M12 15V3'),
  star: (p) =>
    svg(
      p,
      'M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2Z'
    ),
  close: (p) => svg(p, 'M18 6L6 18M6 6l12 12'),
  play: (p) => (
    <svg
      width={p?.size || 14}
      height={p?.size || 14}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={p?.style}
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  ),
  pause: (p) => svg(p, 'rect:6,5,4,14|rect:14,5,4,14'),
  stop: (p) => svg(p, 'rect:5,5,14,14'),
  sparkle: (p) =>
    svg(
      p,
      'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8'
    ),
  command: (p) =>
    svg(
      p,
      'M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z'
    ),
  filter: (p) => svg(p, 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z'),
  refresh: (p) =>
    svg(
      p,
      'M23 4v6h-6|M1 20v-6h6|M3.51 9a9 9 0 0114.85-3.36L23 10|M1 14l4.64 4.36A9 9 0 0020.49 15'
    ),
  trash: (p) =>
    svg(p, 'M3 6h18|M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2'),
  more: (p) => svg(p, 'circ:5,12,1|circ:12,12,1|circ:19,12,1'),
  check: (p) => svg(p, 'M20 6L9 17l-5-5'),
  clock: (p) => svg(p, 'circ:12,12,10|M12 6v6l4 2'),
  zap: (p) => svg(p, 'M13 2L3 14h7l-1 8L19 10h-7l1-8z'),
  branch: (p) => svg(p, 'circ:6,3,3|circ:6,18,3|circ:18,6,3|M18 9v6a3 3 0 01-3 3H6'),
  shield: (p) => svg(p, 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  database: (p) =>
    svg(
      p,
      'ellipse:12,5,9,3|M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5|M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6'
    ),
  layers: (p) => svg(p, 'M12 2L2 7l10 5 10-5-10-5z|M2 17l10 5 10-5|M2 12l10 5 10-5'),
};

function svg(props, path, sw) {
  const size = props?.size || 14;
  const parts = path.split('|');
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw || 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={props?.style}
    >
      {parts.map((part, i) => {
        if (part.startsWith('circ:')) {
          const [cx, cy, r] = part.slice(5).split(',').map(Number);
          return <circle key={i} cx={cx} cy={cy} r={r} />;
        }
        if (part.startsWith('rect:')) {
          const [x, y, w, h] = part.slice(5).split(',').map(Number);
          return <rect key={i} x={x} y={y} width={w} height={h} rx={1} />;
        }
        if (part.startsWith('ellipse:')) {
          const [cx, cy, rx, ry] = part.slice(8).split(',').map(Number);
          return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} />;
        }
        return <path key={i} d={part} />;
      })}
    </svg>
  );
}

// ─── Method chip ──────────────────────────────────────────────────────
const METHOD_COL = {
  GET: { fg: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
  POST: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.16)' },
  PUT: { fg: '#3b82f6', bg: 'rgba(59,130,246,0.16)' },
  PATCH: { fg: '#a855f7', bg: 'rgba(168,85,247,0.16)' },
  DEL: { fg: '#ef4444', bg: 'rgba(239,68,68,0.16)' },
  DELETE: { fg: '#ef4444', bg: 'rgba(239,68,68,0.16)' },
  HEAD: { fg: '#06b6d4', bg: 'rgba(6,182,212,0.16)' },
  WS: { fg: '#a78bfa', bg: 'rgba(167,139,250,0.16)' },
  SSE: { fg: '#06b6d4', bg: 'rgba(6,182,212,0.16)' },
  MCP: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.16)' },
  GQL: { fg: '#e879a4', bg: 'rgba(232,121,164,0.16)' },
  Unary: { fg: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
};

function MethodChip({ method, big, p }) {
  const c = METHOD_COL[method] || METHOD_COL.GET;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: big ? 11.5 : 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        color: c.fg,
        background: c.bg,
        padding: big ? '4px 9px' : '2px 6px',
        borderRadius: big ? 7 : 5,
      }}
    >
      {method}
    </span>
  );
}

const PROTO_COL = {
  HTTP: '#4d9fff',
  gRPC: '#22c55e',
  WS: '#a78bfa',
  GQL: '#e879a4',
  MCP: '#f59e0b',
  SSE: '#06b6d4',
  Kafka: '#f472b6',
};

function ProtoChip({ proto, p }) {
  const c = PROTO_COL[proto] || ACCENT_DEFAULT;
  return (
    <span
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 9.5,
        fontWeight: 700,
        color: c,
        letterSpacing: 0.6,
        padding: '2px 6px',
        borderRadius: 4,
        background: `${c}1f`,
      }}
    >
      {proto}
    </span>
  );
}

// ─── Kbd ──────────────────────────────────────────────────────────────
function Kbd({ children, p }) {
  return (
    <kbd
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 4,
        background: p.kbdBg,
        color: p.textMuted,
        border: `1px solid ${p.line}`,
        fontWeight: 500,
      }}
    >
      {children}
    </kbd>
  );
}

// ─── Status pill ──────────────────────────────────────────────────────
function StatusPill({ code, p }) {
  const c = code < 300 ? '#22c55e' : code < 400 ? '#06b6d4' : code < 500 ? '#f59e0b' : '#ef4444';
  const label = code < 300 ? 'OK' : code < 400 ? 'REDIR' : code < 500 ? 'CLIENT' : 'SERVER';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '4px 10px',
        borderRadius: 7,
        background: `${c}29`,
        boxShadow: `0 0 0 1px ${c}33, 0 0 16px ${c}22`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12,
          fontWeight: 700,
          color: c,
        }}
      >
        {code} {label}
      </span>
    </div>
  );
}

// ─── Tiny stat ────────────────────────────────────────────────────────
function Stat({ label, value, p, accent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span
        style={{
          fontSize: 10.5,
          color: p.textDim,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12.5,
          color: accent || p.text,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── JSON syntax highlighting ─────────────────────────────────────────
function hlJSON(src) {
  const C = {
    key: '#79b8ff',
    str: '#a5d6a7',
    num: '#ffab70',
    bool: '#c792ea',
    punct: '#94a3b8',
    var: '#f59e0b',
  };
  let s = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*(?:[eE][-+]?\d+)?/g,
    (m, str, colon, kw) => {
      if (str) {
        if (colon)
          return `<span style="color:${C.key}">${str}</span><span style="color:${C.punct}">${colon}</span>`;
        return `<span style="color:${C.str}">${str}</span>`;
      }
      if (kw) return `<span style="color:${C.bool}">${kw}</span>`;
      return `<span style="color:${C.num}">${m}</span>`;
    }
  );
  s = s.replace(/([{}\[\],])/g, `<span style="color:${C.punct}">$1</span>`);
  s = s.replace(/&lt;([a-z_]+)&gt;/g, `<span style="color:${C.var}">&lt;$1&gt;</span>`);
  return s;
}

function hlGraphQL(src) {
  let s = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(
    /\b(query|mutation|subscription|fragment|on)\b/g,
    `<span style="color:#c792ea">$1</span>`
  );
  s = s.replace(/(\$[a-zA-Z_][a-zA-Z0-9_]*)/g, `<span style="color:#ffab70">$1</span>`);
  s = s.replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, `<span style="color:#79b8ff">$1</span>`);
  s = s.replace(/(#[^\n]*)/g, `<span style="color:#64748b;font-style:italic">$1</span>`);
  return s;
}

// ─── Mock data ────────────────────────────────────────────────────────
const DATA = {
  collections: [
    {
      id: 'restura-api',
      name: 'Restura API',
      count: 14,
      open: true,
      children: [
        { id: 'list-orders', proto: 'HTTP', method: 'GET', name: 'List orders' },
        { id: 'create-order', proto: 'HTTP', method: 'POST', name: 'Create order' },
        { id: 'get-order', proto: 'HTTP', method: 'GET', name: 'Get order' },
        { id: 'update-order', proto: 'HTTP', method: 'PATCH', name: 'Update status' },
        { id: 'cancel-order', proto: 'HTTP', method: 'DEL', name: 'Cancel order' },
        { id: 'orders-gql', proto: 'GQL', method: 'POST', name: 'GetUserOrders (GQL)' },
        { id: 'orders-grpc', proto: 'gRPC', method: 'Unary', name: 'OrderService/Get' },
      ],
    },
    {
      id: 'realtime',
      name: 'Realtime',
      count: 4,
      open: true,
      children: [
        { id: 'live-orders', proto: 'WS', method: 'WS', name: 'orders/live' },
        { id: 'agent-stream', proto: 'SSE', method: 'SSE', name: 'agents/answer' },
        { id: 'kafka-events', proto: 'Kafka', method: 'Kafka', name: 'order-events' },
      ],
    },
    {
      id: 'agents',
      name: 'Agents & Tools',
      count: 5,
      children: [{ id: 'gh-mcp', proto: 'MCP', method: 'MCP', name: 'gh-tools server' }],
    },
    { id: 'auth-users', name: 'Auth & Users', count: 7 },
    { id: 'webhooks', name: 'Webhooks', count: 4 },
  ],

  history: [
    {
      id: 'h1',
      method: 'GET',
      status: 200,
      path: '/v2/users/42/orders',
      ms: 114,
      ts: '2m ago',
      favorite: true,
    },
    { id: 'h2', method: 'POST', status: 201, path: '/v2/orders', ms: 246, ts: '8m ago' },
    { id: 'h3', method: 'GET', status: 404, path: '/v2/users/9999', ms: 62, ts: '14m ago' },
    {
      id: 'h4',
      method: 'PATCH',
      status: 200,
      path: '/v2/orders/ord_7K9xQp2',
      ms: 188,
      ts: '22m ago',
    },
    { id: 'h5', method: 'GET', status: 200, path: '/v2/health', ms: 18, ts: '1h ago' },
    { id: 'h6', method: 'POST', status: 500, path: '/v2/webhooks/replay', ms: 1842, ts: '2h ago' },
    { id: 'h7', method: 'GET', status: 200, path: '/v2/auth/me', ms: 44, ts: '3h ago' },
    { id: 'h8', method: 'POST', status: 200, path: '/graphql', ms: 312, ts: '3h ago' },
    { id: 'h9', method: 'DEL', status: 204, path: '/v2/orders/ord_2Lk', ms: 220, ts: '4h ago' },
    { id: 'h10', method: 'GET', status: 200, path: '/v2/users/42/orders', ms: 98, ts: 'yesterday' },
  ],

  workflows: [
    { id: 'wf1', name: 'Order lifecycle smoke', steps: 5, runs: 12, last: 'passed' },
    { id: 'wf2', name: 'Auth + checkout flow', steps: 8, runs: 47, last: 'passed' },
    { id: 'wf3', name: 'Webhook replay loop', steps: 3, runs: 4, last: 'failed' },
  ],

  envs: [
    {
      id: 'prod',
      name: 'production',
      color: '#22c55e',
      vars: 8,
      host: 'api.restura.dev',
      active: true,
    },
    { id: 'staging', name: 'staging', color: '#f59e0b', vars: 8, host: 'staging.restura.dev' },
    { id: 'local', name: 'local', color: '#06b6d4', vars: 6, host: 'localhost:8080' },
    { id: 'preview', name: 'pr-284', color: '#a78bfa', vars: 8, host: 'pr-284.restura.dev' },
  ],

  responseJson: `{
  "ok": true,
  "user_id": 42,
  "orders": [
    {
      "id": "ord_7K9xQp2",
      "status": "delivered",
      "total": 248.50,
      "currency": "USD",
      "items": 3,
      "created_at": "2026-05-14T09:21:08Z"
    },
    {
      "id": "ord_3Bm1Rfa",
      "status": "in_transit",
      "total": 89.00,
      "currency": "USD",
      "items": 1,
      "created_at": "2026-05-18T14:02:55Z"
    }
  ],
  "pagination": {
    "next": "cursor:eyJpZCI6Mn0",
    "has_more": true
  }
}`,

  headers: [
    ['content-type', 'application/json; charset=utf-8'],
    ['x-request-id', 'req_4f3a91c8e2b6'],
    ['x-ratelimit-remaining', '4982'],
    ['x-ratelimit-reset', '1747805700'],
    ['cache-control', 'no-store, max-age=0'],
    ['server', 'restura-edge/1.4.2'],
  ],
  timing: [
    { label: 'DNS', ms: 6, color: '#9ca3af' },
    { label: 'TCP', ms: 12, color: '#9ca3af' },
    { label: 'TLS', ms: 24, color: '#9ca3af' },
    { label: 'Request', ms: 4, color: '#7dd3fc' },
    { label: 'Wait (TTFB)', ms: 56, color: ACCENT_DEFAULT },
    { label: 'Download', ms: 8, color: '#a78bfa' },
  ],
};

Object.assign(window, {
  ACCENT_DEFAULT,
  makePalette,
  Floater,
  SIcon,
  MethodChip,
  ProtoChip,
  Kbd,
  StatusPill,
  Stat,
  hlJSON,
  hlGraphQL,
  DATA,
  METHOD_COL,
  PROTO_COL,
});
