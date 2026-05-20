// Spatial · Protocol views — HTTP / GraphQL / gRPC / WebSocket / SSE / MCP / Kafka

// ─── Shared sub-tab bar ───────────────────────────────────────────────
function SubTabBar({ p, items, active, onChange, right }) {
  return (
    <div style={{
      display: 'flex', padding: '0 6px', gap: 2, alignItems: 'flex-end',
      borderBottom: `1px solid ${p.line}`,
    }}>
      {items.map((t) => {
        const isActive = t.id === active || t.name === active;
        return (
          <div key={t.id || t.name} onClick={() => onChange && onChange(t.id || t.name)} style={{
            padding: '11px 12px', cursor: 'pointer',
            fontSize: 12.5, fontWeight: isActive ? 600 : 500,
            color: isActive ? p.text : p.textMuted,
            position: 'relative',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            {t.name}
            {t.count != null && (
              <span style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 9.5, fontWeight: 700,
                padding: '1px 5px', borderRadius: 4,
                background: isActive ? `${p.accent}29` : p.surfaceLo,
                color: isActive ? p.accent : p.textDim,
              }}>{t.count}</span>
            )}
            {t.tag && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                background: 'rgba(167,139,250,0.18)', color: '#a78bfa',
              }}>{t.tag}</span>
            )}
            {isActive && (
              <div style={{
                position: 'absolute', left: 8, right: 8, bottom: -1,
                height: 2, background: p.accent, borderRadius: 2,
                boxShadow: `0 0 8px ${p.accent}`,
              }} />
            )}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

// ─── Param row (toggle / key / value / desc) ──────────────────────────
function ParamRow({ p, row }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '28px 1fr 1.5fr 1fr 22px',
      gap: 10, alignItems: 'center',
      padding: '8px 10px', borderRadius: 9,
      background: p.surfaceLo, border: `1px solid ${p.line}`,
      fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
      opacity: row.on ? 1 : 0.55,
    }}>
      <div style={{
        width: 24, height: 14, borderRadius: 999, padding: 2,
        background: row.on ? p.accent : p.lineStrong,
        boxShadow: row.on ? `0 0 8px ${p.accent}88` : 'none',
        cursor: 'pointer', transition: 'background .15s',
      }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%', background: '#fff',
          transform: row.on ? 'translateX(10px)' : 'translateX(0)',
          transition: 'transform .15s',
        }} />
      </div>
      <div style={{ color: p.text }}>{row.k}</div>
      <div style={{ color: p.text }}>
        {String(row.v).split(/(\{\{[^}]+\}\})/).map((s, j) => s.startsWith('{{') ? (
          <span key={j} style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', padding: '0 4px', borderRadius: 4 }}>{s}</span>
        ) : <span key={j}>{s}</span>)}
      </div>
      <div style={{ color: p.textMuted, fontFamily: 'Geist, sans-serif', fontSize: 11.5 }}>{row.d}</div>
      <div style={{ color: p.textDim, textAlign: 'center', cursor: 'pointer' }}><SIcon.close size={12} /></div>
    </div>
  );
}

// ─── Add row CTA ──────────────────────────────────────────────────────
function AddRow({ p, label }) {
  return (
    <div style={{
      padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 12, color: p.textMuted, cursor: 'pointer',
    }}>
      <SIcon.plus size={12} /> {label}
    </div>
  );
}

// ─── URL bar (shared across HTTP-like protocols) ──────────────────────
function UrlBar({ p, method, methodColor, url, sendLabel = 'Send', onSend, methods }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <Floater p={p} radius={12} style={{
        flex: 1, display: 'flex', alignItems: 'center', padding: 5, gap: 2,
      }}>
        <div style={{
          padding: '7px 14px',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 12, fontWeight: 700,
          color: methodColor.fg, background: methodColor.bg,
          borderRadius: 8, display: 'flex', alignItems: 'center', gap: 5,
          cursor: methods ? 'pointer' : 'default',
        }}>
          {method} {methods && <SIcon.chevron size={10} />}
        </div>
        <div style={{
          flex: 1, padding: '0 12px',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 13, color: p.text,
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>
          {url.split(/(\{\{[^}]+\}\})/).map((s, i) => s.startsWith('{{') ? (
            <span key={i} style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', padding: '0 4px', borderRadius: 4 }}>{s}</span>
          ) : <span key={i} style={{ color: s.startsWith('http') || s.startsWith('ws') ? p.textDim : i % 2 === 0 ? p.text : p.text }}>{s}</span>)}
        </div>
        <div style={{ display: 'flex', gap: 2, paddingRight: 4 }}>
          <div style={{ padding: 6, color: p.textMuted, cursor: 'pointer' }}><SIcon.copy size={13} /></div>
          <div style={{ padding: 6, color: p.textMuted, cursor: 'pointer' }}><SIcon.history size={13} /></div>
          <div style={{ padding: 6, color: p.textMuted, cursor: 'pointer' }}><SIcon.link size={13} /></div>
        </div>
      </Floater>
      <button onClick={onSend} style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '0 22px', height: 40, borderRadius: 12, border: 0,
        background: `linear-gradient(180deg, ${p.accent}, #3a85ee)`,
        color: '#fff', fontSize: 13, fontWeight: 600,
        boxShadow: `0 8px 24px ${p.accent}55, inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 1px ${p.accent}aa`,
        cursor: 'pointer',
      }}>
        <SIcon.send size={13} />
        {sendLabel}
        <Kbd p={p}>⌘↵</Kbd>
      </button>
    </div>
  );
}

// ─── Response panel (HTTP) ────────────────────────────────────────────
function ResponsePanel({ p, status = 200, ms = 114, size = '1.42 KB', body = DATA.responseJson }) {
  const [tab, setTab] = React.useState('Body');
  const [view, setView] = React.useState('Pretty');
  return (
    <Floater p={p} radius={14} large style={{
      flex: 1.2, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0,
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: `1px solid ${p.line}`,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <StatusPill code={status} p={p} />
        <Stat label="Time" value={`${ms} ms`} p={p} />
        <Stat label="Size" value={size} p={p} />
        <Stat label="HTTP" value="2.0" p={p} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: p.textDim, textTransform: 'uppercase' }}>Waterfall</span>
          <div style={{
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', width: 220,
            background: p.surfaceLo,
          }}>
            {DATA.timing.map((t, i) => (
              <div key={i} title={`${t.label} ${t.ms}ms`} style={{
                width: `${(t.ms / 110) * 100}%`, background: t.color,
                boxShadow: t.label === 'Wait (TTFB)' ? `inset 0 0 6px ${t.color}` : 'none',
              }} />
            ))}
          </div>
        </div>
      </div>

      <SubTabBar p={p} active={tab} onChange={setTab}
        items={[
          { id: 'Body',    name: 'Body' },
          { id: 'Headers', name: 'Headers', count: 6 },
          { id: 'Cookies', name: 'Cookies' },
          { id: 'Timeline',name: 'Timeline' },
          { id: 'Tests',   name: 'Tests' },
        ]}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 0' }}>
            {['Pretty', 'Raw', 'Preview'].map((m) => (
              <div key={m} onClick={() => setView(m)} style={{
                padding: '4px 9px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                background: m === view ? p.hoverBg : 'transparent',
                color: m === view ? p.text : p.textMuted, cursor: 'pointer',
              }}>{m}</div>
            ))}
            <div style={{ padding: 5, color: p.textMuted, cursor: 'pointer' }}><SIcon.copy /></div>
            <div style={{ padding: 5, color: p.textMuted, cursor: 'pointer' }}><SIcon.download /></div>
          </div>
        }
      />

      {tab === 'Body' && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, background: p.code }}>
          <div style={{
            width: 40, padding: '12px 10px', textAlign: 'right',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5,
            color: p.textDim, borderRight: `1px solid ${p.line}`,
            fontVariantNumeric: 'tabular-nums',
          }}>{body.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <pre style={{
            flex: 1, margin: 0, padding: '12px 16px',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
            color: p.text, overflow: 'auto',
          }} dangerouslySetInnerHTML={{ __html: hlJSON(body) }} />
        </div>
      )}
      {tab === 'Headers' && (
        <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
          {DATA.headers.map(([k, v], i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '200px 1fr',
              padding: '6px 0', borderBottom: i < DATA.headers.length - 1 ? `1px solid ${p.line}` : 'none',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
            }}>
              <span style={{ color: p.textMuted }}>{k}</span>
              <span style={{ color: p.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'Timeline' && (
        <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
          {DATA.timing.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ width: 110, fontSize: 11.5, color: p.textMuted }}>{t.label}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 4, background: p.surfaceLo, position: 'relative', overflow: 'hidden' }}>
                <div style={{ width: `${(t.ms / 60) * 100}%`, height: '100%', background: t.color }} />
              </div>
              <span style={{ width: 60, textAlign: 'right', fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, color: p.text, fontVariantNumeric: 'tabular-nums' }}>{t.ms} ms</span>
            </div>
          ))}
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: p.surfaceLo, fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, color: p.textMuted }}>
            Total: <span style={{ color: p.text, fontWeight: 600 }}>110 ms</span> · Server-Timing: db;dur=42, cache;dur=2, compute;dur=14
          </div>
        </div>
      )}
      {(tab === 'Cookies' || tab === 'Tests') && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: p.textMuted, fontSize: 13, padding: 30, textAlign: 'center' }}>
          {tab === 'Cookies' ? 'No cookies on this response.' : 'No tests defined. Add assertions in the Scripts tab.'}
        </div>
      )}
    </Floater>
  );
}

// ─── HTTP ─────────────────────────────────────────────────────────────
function HttpView({ p }) {
  const [sub, setSub] = React.useState('Params');
  const params = [
    { on: true,  k: 'limit',  v: '20',                     d: 'Page size' },
    { on: true,  k: 'status', v: 'delivered,in_transit',   d: 'Filter status' },
    { on: false, k: 'sort',   v: '-created_at',            d: 'Sort descending' },
  ];
  const headers = [
    { on: true,  k: 'Authorization', v: 'Bearer {{token}}', d: 'API token' },
    { on: true,  k: 'X-Workspace',   v: 'restura-personal',  d: '' },
    { on: true,  k: 'Accept',        v: 'application/json',  d: '' },
    { on: false, k: 'Accept-Encoding', v: 'gzip, br',        d: '' },
  ];

  return (
    <React.Fragment>
      <UrlBar p={p} method="GET" methodColor={METHOD_COL.GET}
        url="https://api.restura.dev/v2/users/{{userId}}/orders" methods
      />

      <div style={{ flex: 1, display: 'flex', gap: 10, minHeight: 0 }}>
        {/* request panel */}
        <Floater p={p} radius={14} style={{
          flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0,
        }}>
          <SubTabBar p={p} active={sub} onChange={setSub}
            items={[
              { id: 'Params',   name: 'Params',   count: 3 },
              { id: 'Headers',  name: 'Headers',  count: 4 },
              { id: 'Body',     name: 'Body' },
              { id: 'Auth',     name: 'Auth',     tag: 'Bearer' },
              { id: 'Scripts',  name: 'Scripts' },
              { id: 'Settings', name: 'Settings' },
            ]}
          />
          <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
            {sub === 'Params' && (
              <React.Fragment>
                {params.map((r, i) => <ParamRow key={i} p={p} row={r} />)}
                <AddRow p={p} label="Add parameter" />
              </React.Fragment>
            )}
            {sub === 'Headers' && (
              <React.Fragment>
                {headers.map((r, i) => <ParamRow key={i} p={p} row={r} />)}
                <AddRow p={p} label="Add header" />
              </React.Fragment>
            )}
            {sub === 'Body' && <BodyEditor p={p} />}
            {sub === 'Auth' && <AuthEditor p={p} />}
            {sub === 'Scripts' && <ScriptsEditor p={p} />}
            {sub === 'Settings' && <RequestSettings p={p} />}
          </div>
        </Floater>

        <ResponsePanel p={p} />
      </div>
    </React.Fragment>
  );
}

// ─── HTTP sub-panels ──────────────────────────────────────────────────
function BodyEditor({ p }) {
  const [type, setType] = React.useState('JSON');
  const body = `{
  "items": [
    { "sku": "REST-001", "qty": 2 }
  ],
  "shipping_address_id": "addr_92h",
  "coupon": "{{coupon}}"
}`;
  return (
    <React.Fragment>
      <div style={{ display: 'flex', gap: 2, padding: 2, alignSelf: 'flex-start', borderRadius: 8, background: p.surfaceLo }}>
        {['none', 'JSON', 'form-data', 'x-www-form-urlencoded', 'GraphQL', 'raw', 'binary'].map((t) => (
          <div key={t} onClick={() => setType(t)} style={{
            padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
            background: t === type ? (p.name === 'dark' ? 'rgba(255,255,255,0.07)' : '#fff') : 'transparent',
            color: t === type ? p.text : p.textMuted, cursor: 'pointer',
            boxShadow: t === type && p.name === 'light' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
          }}>{t}</div>
        ))}
      </div>
      <div style={{
        flex: 1, marginTop: 6, borderRadius: 10,
        background: p.code, border: `1px solid ${p.line}`,
        display: 'flex', minHeight: 240, overflow: 'hidden',
      }}>
        <div style={{
          width: 40, padding: '10px 10px', textAlign: 'right',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5,
          color: p.textDim, borderRight: `1px solid ${p.line}`,
          fontVariantNumeric: 'tabular-nums',
        }}>{body.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
        <pre style={{
          flex: 1, margin: 0, padding: '10px 14px',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
          color: p.text, overflow: 'auto',
        }} dangerouslySetInnerHTML={{ __html: hlJSON(body) }} />
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: p.textMuted, padding: '4px 4px 0' }}>
        <span>JSON · 117 bytes</span><span>·</span>
        <span style={{ color: '#22c55e' }}>valid</span><span>·</span>
        <span>{'1 variable: {{coupon}}'}</span>
      </div>
    </React.Fragment>
  );
}

function AuthEditor({ p }) {
  const types = ['Inherit', 'No Auth', 'Bearer', 'Basic', 'API Key', 'OAuth 2.0', 'AWS Sig v4'];
  const [active, setActive] = React.useState('Bearer');
  return (
    <div style={{ display: 'flex', gap: 14, padding: 4 }}>
      {/* auth type picker */}
      <div style={{
        width: 160, borderRadius: 10, padding: 6,
        background: p.surfaceLo, border: `1px solid ${p.line}`,
        display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'flex-start',
      }}>
        {types.map((t) => (
          <div key={t} onClick={() => setActive(t)} style={{
            padding: '7px 10px', borderRadius: 7,
            fontSize: 12, fontWeight: t === active ? 600 : 500,
            color: t === active ? p.text : p.textMuted,
            background: t === active ? p.activeBg : 'transparent',
            cursor: 'pointer',
          }}>{t}</div>
        ))}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: p.text, marginBottom: 6 }}>Bearer token</div>
        <div style={{ fontSize: 11.5, color: p.textMuted, marginBottom: 12 }}>The token will be sent as the value of <code style={{ background: p.surfaceLo, padding: '1px 5px', borderRadius: 3, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>Authorization: Bearer &lt;token&gt;</code>.</div>
        <div style={{
          padding: '10px 12px', borderRadius: 9,
          background: p.surfaceLo, border: `1px solid ${p.line}`,
          fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5,
        }}>
          <span style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', padding: '0 4px', borderRadius: 4 }}>{`{{token}}`}</span>
          <span style={{ color: p.textDim, marginLeft: 8 }}>= <span style={{ color: '#22c55e' }}>sk_live_••••••••••</span></span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          <div style={{ padding: '6px 10px', borderRadius: 7, background: p.surfaceLo, border: `1px solid ${p.line}`, fontSize: 11, color: p.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            <SIcon.refresh size={11} /> Refresh
          </div>
          <div style={{ padding: '6px 10px', borderRadius: 7, background: p.surfaceLo, border: `1px solid ${p.line}`, fontSize: 11, color: p.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            <SIcon.shield size={11} /> Vault
          </div>
        </div>
      </div>
    </div>
  );
}

function ScriptsEditor({ p }) {
  const [phase, setPhase] = React.useState('post-response');
  const code = `// Runs after every response on this request.
pm.test("status is 200", () => {
  expect(restura.response.status).toEqual(200);
});

pm.test("has 2 orders", () => {
  expect(restura.response.json().orders).toHaveLength(2);
});

// Cache the first order id for the next request in this run.
restura.env.set("orderId", restura.response.json().orders[0].id);`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {['pre-request', 'post-response'].map((s) => (
          <div key={s} onClick={() => setPhase(s)} style={{
            padding: '6px 12px', borderRadius: 7,
            fontSize: 11.5, fontWeight: 600,
            background: s === phase ? p.activeBg : p.surfaceLo,
            color: s === phase ? p.accent : p.textMuted,
            border: `1px solid ${s === phase ? p.accent + '55' : p.line}`,
            cursor: 'pointer',
          }}>{s}</div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: p.textMuted }}>2 tests · 3 assertions</div>
      </div>
      <div style={{
        flex: 1, borderRadius: 10, background: p.code,
        border: `1px solid ${p.line}`, padding: 14,
        fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.6,
        color: p.text, whiteSpace: 'pre',
        minHeight: 240,
      }}>{code.split('\n').map((line, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span style={{ width: 28, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
          <span dangerouslySetInnerHTML={{ __html: line
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/(\/\/[^\n]*)/g, `<span style="color:#64748b;font-style:italic">$1</span>`)
            .replace(/("[^"]*")/g, `<span style="color:#a5d6a7">$1</span>`)
            .replace(/\b(const|let|var|function|return|if|else)\b/g, `<span style="color:#c792ea">$1</span>`)
            .replace(/\b(pm|restura|expect|test)\b/g, `<span style="color:#79b8ff">$1</span>`)
          }} />
        </div>
      ))}</div>
    </div>
  );
}

function RequestSettings({ p }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 8, maxWidth: 480 }}>
      {[
        { k: 'Follow redirects',          desc: 'Resolve 3xx chain up to 10 hops',         on: true },
        { k: 'Verify SSL certificate',    desc: 'Allow self-signed for dev environments',  on: false },
        { k: 'Encode URL automatically',  desc: 'Percent-encode special characters in path', on: true },
        { k: 'Send cookies',              desc: 'Attach cookies from this environment',    on: true },
        { k: 'Save responses to history', desc: 'Captured for replay & diffing',           on: true },
      ].map((s) => (
        <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: p.text }}>{s.k}</div>
            <div style={{ fontSize: 11.5, color: p.textMuted }}>{s.desc}</div>
          </div>
          <div style={{
            width: 36, height: 22, borderRadius: 999, padding: 2,
            background: s.on ? p.accent : p.lineStrong,
            boxShadow: s.on ? `0 4px 10px ${p.accent}55` : 'none',
            cursor: 'pointer',
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', background: '#fff',
              transform: s.on ? 'translateX(14px)' : 'translateX(0)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── GraphQL ──────────────────────────────────────────────────────────
function GraphQLView({ p }) {
  const query = `query GetUserOrders($userId: ID!, $first: Int = 20) {
  user(id: $userId) {
    id
    name
    orders(first: $first, status: [DELIVERED, IN_TRANSIT]) {
      edges {
        node {
          id
          total
          currency
          status
          createdAt
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
  const variables = `{
  "userId": "42",
  "first": 10
}`;
  const respBody = `{
  "data": {
    "user": {
      "id": "42",
      "name": "Ada Lovelace",
      "orders": {
        "edges": [
          { "node": { "id": "ord_7K9xQp2", "total": 248.50, "status": "DELIVERED" } },
          { "node": { "id": "ord_3Bm1Rfa", "total":  89.00, "status": "IN_TRANSIT" } }
        ],
        "pageInfo": { "hasNextPage": true }
      }
    }
  },
  "extensions": { "tracing": { "duration": 89234567 } }
}`;
  const types = [
    { name: 'Query', kind: 'OBJECT', color: '#a78bfa', fields: ['user(id): User', 'orders(...): OrderConn', 'me: User'] },
    { name: 'User',  kind: 'OBJECT', color: '#4d9fff', fields: ['id: ID!', 'name: String', 'orders(...): OrderConn'] },
    { name: 'Order', kind: 'OBJECT', color: '#22c55e', fields: ['id: ID!', 'total: Float!', 'currency: Currency', 'status: OrderStatus'] },
    { name: 'OrderStatus', kind: 'ENUM', color: '#f59e0b', fields: ['PENDING', 'DELIVERED', 'IN_TRANSIT', 'CANCELLED'] },
  ];
  return (
    <React.Fragment>
      <UrlBar p={p} method="POST" methodColor={METHOD_COL.POST} url="https://api.restura.dev/graphql" sendLabel="Run" />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '220px 1fr 1fr', gap: 10, minHeight: 0 }}>
        {/* schema explorer */}
        <Floater p={p} radius={14} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <SIcon.layers size={13} style={{ color: p.accent }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: p.text }}>Schema</span>
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
              color: '#22c55e', padding: '1px 5px', borderRadius: 4,
              background: 'rgba(34,197,94,0.16)',
            }}>LOADED</span>
            <div style={{ flex: 1 }} />
            <SIcon.refresh size={12} style={{ color: p.textMuted, cursor: 'pointer' }} />
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px', borderRadius: 7,
            background: p.surfaceLo, border: `1px solid ${p.line}`,
          }}>
            <SIcon.search size={12} style={{ opacity: 0.55 }} />
            <span style={{ fontSize: 12, color: p.textDim }}>Filter types…</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto', marginTop: 4 }}>
            {types.map((t) => (
              <div key={t.name} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 4px' }}>
                  <span style={{
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 8.5, fontWeight: 700,
                    letterSpacing: 0.5, padding: '2px 4px', borderRadius: 3,
                    color: t.color, background: `${t.color}26`,
                  }}>{t.kind}</span>
                  <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, fontWeight: 600, color: p.text }}>{t.name}</span>
                </div>
                {t.fields.map((f, j) => (
                  <div key={j} style={{
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
                    color: p.textMuted, padding: '3px 8px 3px 22px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{f}</div>
                ))}
              </div>
            ))}
          </div>
        </Floater>

        {/* query editor + variables */}
        <Floater p={p} radius={14} large style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: p.code, minHeight: 0 }}>
          <SubTabBar p={p} active="Query" items={[
            { id: 'Query', name: 'Query' },
            { id: 'Variables', name: 'Variables', count: 2 },
            { id: 'Headers', name: 'Headers', count: 3 },
          ]} right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 8 }}>
              <span style={{ fontSize: 10.5, color: p.textMuted, cursor: 'pointer' }}>Prettify</span>
              <span style={{ fontSize: 10.5, color: p.textMuted, cursor: 'pointer' }}>SDL</span>
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, color: p.textDim }}>237 B</span>
            </div>
          }/>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <pre style={{
              flex: 1, margin: 0, padding: '12px 14px',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
              color: p.text, overflow: 'auto', whiteSpace: 'pre',
            }} dangerouslySetInnerHTML={{ __html: hlGraphQL(query) }} />
            <div style={{ borderTop: `1px solid ${p.line}`, padding: '8px 14px', fontSize: 11, color: p.textDim, display: 'flex', alignItems: 'center', gap: 10 }}>
              <SIcon.chevron size={11} style={{ transform: 'rotate(0deg)' }} /> Variables
              <span style={{ color: '#22c55e' }}>● valid</span>
            </div>
            <pre style={{
              margin: 0, padding: '4px 14px 12px',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 12, lineHeight: 1.55,
              color: p.text, whiteSpace: 'pre',
            }} dangerouslySetInnerHTML={{ __html: hlJSON(variables) }} />
          </div>
        </Floater>

        {/* response */}
        <Floater p={p} radius={14} large style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: p.code, minHeight: 0 }}>
          <div style={{ padding: '11px 14px', borderBottom: `1px solid ${p.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusPill code={200} p={p} />
            <Stat label="time" value="89 ms" p={p} />
            <Stat label="size" value="1.2 KB" p={p} />
            <div style={{ flex: 1 }} />
            <SIcon.copy size={13} style={{ opacity: 0.55, cursor: 'pointer' }} />
            <SIcon.download size={13} style={{ opacity: 0.55, cursor: 'pointer' }} />
          </div>
          <pre style={{
            flex: 1, margin: 0, padding: '12px 14px',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
            color: p.text, overflow: 'auto',
          }} dangerouslySetInnerHTML={{ __html: hlJSON(respBody) }} />
        </Floater>
      </div>
    </React.Fragment>
  );
}

// ─── gRPC ─────────────────────────────────────────────────────────────
function GrpcView({ p }) {
  const reqJson = `{
  "message": "<message>",
  "count": 1,
  "metadata": {
    "trace_id": "{{trace}}"
  }
}`;
  const respJson = `{
  "reply": "Hello from echo.v1",
  "received_at": "2026-05-20T20:14:08Z",
  "count": 1,
  "server": "restura-grpc-edge/0.9"
}`;
  const services = [
    { name: 'echo.v1.EchoService',  methods: 4, open: true },
    { name: 'orders.v2.OrderQuery', methods: 6 },
    { name: 'orders.v2.OrderMutation', methods: 5 },
    { name: 'auth.v1.AuthService',  methods: 3 },
  ];
  const methods = [
    { name: 'UnaryEcho',         kind: 'U', sel: true },
    { name: 'ServerStreamEcho',  kind: 'S' },
    { name: 'ClientStreamEcho',  kind: 'C' },
    { name: 'BidiStreamEcho',    kind: 'B' },
  ];
  return (
    <React.Fragment>
      <UrlBar p={p} method="Unary" methodColor={METHOD_COL.GET} url="echo.restura.dev:443" sendLabel="Invoke" methods />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr 1.1fr', gap: 10, minHeight: 0 }}>
        {/* service tree */}
        <Floater p={p} radius={14} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <SIcon.bolt size={13} style={{ color: '#22c55e' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Reflection</span>
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
              color: '#22c55e', padding: '1px 5px', borderRadius: 4,
              background: 'rgba(34,197,94,0.16)',
            }}>READY</span>
          </div>
          <div style={{ padding: '0 14px 10px', fontSize: 11, color: p.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
            4 services · 18 methods
          </div>
          <div style={{ flex: 1, padding: '6px 8px', overflow: 'auto' }}>
            {services.map((s) => (
              <div key={s.name}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '6px 8px', borderRadius: 7,
                  background: s.open ? p.hoverBg : 'transparent',
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                  cursor: 'pointer',
                }}>
                  <SIcon.chevron size={10} style={{ opacity: 0.5, transform: s.open ? 'rotate(0)' : 'rotate(-90deg)' }} />
                  <span style={{ color: p.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  <span style={{ fontSize: 10, color: p.textDim }}>{s.methods}</span>
                </div>
                {s.open && methods.map((m) => (
                  <div key={m.name} style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '5px 8px 5px 28px', borderRadius: 7,
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5,
                    background: m.sel ? p.activeBg : 'transparent',
                    color: m.sel ? p.text : p.textMuted,
                    position: 'relative', cursor: 'pointer', marginBottom: 1,
                  }}>
                    {m.sel && <div style={{
                      position: 'absolute', left: 22, top: '50%', transform: 'translateY(-50%)',
                      width: 3, height: 12, borderRadius: 2, background: p.accent,
                      boxShadow: `0 0 6px ${p.accent}`,
                    }} />}
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                      padding: '1px 4px', borderRadius: 3,
                      color: '#22c55e', background: 'rgba(34,197,94,0.16)',
                    }}>{m.kind}</span>
                    <span>{m.name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: `1px solid ${p.line}`, display: 'flex', gap: 8 }}>
            <button style={{
              flex: 1, padding: '7px 10px', borderRadius: 8,
              border: `1px solid ${p.lineStrong}`, background: 'transparent',
              color: p.text, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
              <SIcon.download size={12} />
              Upload .proto
            </button>
          </div>
        </Floater>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <Floater p={p} radius={12} style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 14, fontWeight: 700, color: p.accent }}>UnaryEcho</span>
              <span style={{ fontSize: 11, color: p.textMuted }}>· Single request, single response</span>
            </div>
            <div style={{ display: 'flex', gap: 22, fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5 }}>
              <span><span style={{ color: p.textDim }}>in </span><span style={{ color: '#a78bfa' }}>EchoRequest</span></span>
              <span style={{ color: p.textDim }}>→</span>
              <span><span style={{ color: p.textDim }}>out</span> <span style={{ color: '#a78bfa' }}>EchoReply</span></span>
              <div style={{ flex: 1 }} />
              <span style={{ color: p.textMuted, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}>Show schema</span>
            </div>
          </Floater>

          <Floater p={p} radius={12} large style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: p.code, minHeight: 0 }}>
            <SubTabBar p={p} active="Message" items={[
              { id: 'Message',  name: 'Message' },
              { id: 'Metadata', name: 'Metadata', count: 3 },
              { id: 'Auth',     name: 'Auth' },
              { id: 'Settings', name: 'Settings' },
              { id: 'Scripts',  name: 'Scripts' },
            ]} />
            <div style={{ padding: '6px 14px 0', fontSize: 11, color: p.textMuted }}>
              Request message as JSON. Use <span style={{ color: '#f59e0b' }}>{`{{variable}}`}</span> for environment variables.
            </div>
            <pre style={{
              flex: 1, margin: 0, padding: '8px 14px',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
              color: p.text, overflow: 'auto',
            }} dangerouslySetInnerHTML={{ __html: hlJSON(reqJson) }} />
          </Floater>
        </div>

        <Floater p={p} radius={12} large style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: p.code, minHeight: 0 }}>
          <div style={{ padding: '11px 14px', borderBottom: `1px solid ${p.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Response</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 8px', borderRadius: 6,
              background: 'rgba(34,197,94,0.16)', color: '#22c55e',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 11, fontWeight: 700,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e' }} />
              OK · 0
            </span>
            <div style={{ flex: 1 }} />
            <Stat label="time" value="23 ms" p={p} />
          </div>
          <pre style={{
            margin: 0, padding: '12px 14px',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, lineHeight: 1.55,
            color: p.text,
          }} dangerouslySetInnerHTML={{ __html: hlJSON(respJson) }} />
          <div style={{ borderTop: `1px solid ${p.line}`, padding: 14 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: p.textDim, textTransform: 'uppercase', marginBottom: 8 }}>Trailers</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5 }}>
              <span style={{ color: p.textMuted }}>grpc-status</span>      <span style={{ color: '#22c55e' }}>0 (OK)</span>
              <span style={{ color: p.textMuted }}>grpc-message</span>     <span style={{ color: p.text }}>—</span>
              <span style={{ color: p.textMuted }}>x-server-trace</span>   <span style={{ color: p.text }}>tr_4f3a91c8</span>
              <span style={{ color: p.textMuted }}>content-type</span>     <span style={{ color: p.text }}>application/grpc</span>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ borderTop: `1px solid ${p.line}`, padding: 14, display: 'flex', gap: 18 }}>
            <Stat label="size" value="124 B" p={p} />
            <Stat label="frames" value="2" p={p} />
            <Stat label="compr" value="gzip" p={p} />
          </div>
        </Floater>
      </div>
    </React.Fragment>
  );
}

Object.assign(window, {
  SubTabBar, ParamRow, AddRow, UrlBar, ResponsePanel,
  HttpView, GraphQLView, GrpcView,
});
