// Spatial · Application shell — state, window chrome, tab strip, body routing.
// This is the entry point that composes everything.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "#4d9fff",
  "density": "balanced",
  "glassIntensity": 1,
  "showStars": true,
  "sidebar": "left"
}/*EDITMODE-END*/;

// ─── Open tabs (mock state) ──────────────────────────────────────────
const INITIAL_TABS = [
  { id: 't1', proto: 'HTTP',  name: 'List orders',     reqId: 'list-orders',   dirty: false, active: true  },
  { id: 't2', proto: 'gRPC',  name: 'EchoService',     reqId: 'orders-grpc',   dirty: true,  active: false },
  { id: 't3', proto: 'WS',    name: 'orders/live',     reqId: 'live-orders',   dirty: false, active: false },
  { id: 't4', proto: 'GQL',   name: 'GetUserOrders',   reqId: 'orders-gql',    dirty: false, active: false },
  { id: 't5', proto: 'SSE',   name: 'agents/answer',   reqId: 'agent-stream',  dirty: false, active: false },
  { id: 't6', proto: 'MCP',   name: 'gh-tools server', reqId: 'gh-mcp',        dirty: false, active: false },
  { id: 't7', proto: 'Kafka', name: 'order-events',    reqId: 'kafka-events',  dirty: false, active: false },
];

// ─── Tab strip ───────────────────────────────────────────────────────
function TabStrip({ p, tabs, onSelect, onClose, onNew }) {
  return (
    <Floater p={p} radius={12} style={{ display: 'flex', alignItems: 'center', padding: 4, gap: 2, overflow: 'hidden', minWidth: 0, position: 'relative' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2, overflow: 'auto', minWidth: 0, scrollbarWidth: 'none' }}>
        {tabs.map((t) => (
          <div key={t.id} onClick={() => onSelect(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
            background: t.active ? p.activeBg : 'transparent',
            fontSize: 12, color: t.active ? p.text : p.textMuted,
            fontWeight: t.active ? 600 : 500,
            boxShadow: t.active ? `inset 0 0 0 1px ${p.accent}44` : 'none',
            flexShrink: 0,
          }}>
            <ProtoChip proto={t.proto} />
            <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            {t.dirty && <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.accent, boxShadow: `0 0 6px ${p.accent}` }} />}
            <SIcon.close size={11} onClick={(e) => { e.stopPropagation(); onClose(t.id); }} style={{ opacity: 0.5 }} />
          </div>
        ))}
        <div onClick={onNew} style={{
          width: 28, height: 28, borderRadius: 8, marginLeft: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: p.textMuted, cursor: 'pointer', flexShrink: 0,
        }}><SIcon.plus size={13} /></div>
      </div>
    </Floater>
  );
}

// ─── Window chrome with macOS traffic lights ─────────────────────────
function WindowChrome({ p, env, onOpenSettings, onOpenPalette, scale }) {
  return (
    <div style={{
      height: 44, flexShrink: 0, padding: '0 14px',
      display: 'flex', alignItems: 'center', gap: 12,
      position: 'relative',
    }}>
      {/* traffic lights */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.15)' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.15)' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.15)' }} />
      </div>
      <div style={{ fontSize: 12, color: p.textMuted, opacity: 0.7, marginLeft: 4 }}>Restura</div>

      {/* center: env pill */}
      <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <Floater p={p} radius={9} style={{
          padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11.5, color: p.textMuted,
        }}>
          <SIcon.globe size={12} style={{ color: env.color }} />
          <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>{env.host}</span>
          <span style={{ color: p.textDim }}>·</span>
          <span style={{ color: env.color, fontWeight: 600 }}>{env.name}</span>
        </Floater>
      </div>

      <div style={{ flex: 1 }} />

      {/* right: actions */}
      <div onClick={onOpenPalette} style={{
        height: 30, padding: '0 10px', borderRadius: 9,
        background: p.surfaceLo, border: `1px solid ${p.line}`,
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11.5, color: p.textMuted, cursor: 'pointer',
      }}>
        <SIcon.search size={12} />
        <span>Search</span>
        <Kbd p={p}>⌘K</Kbd>
      </div>
      <div style={{
        width: 30, height: 30, borderRadius: 9,
        background: p.surfaceLo, border: `1px solid ${p.line}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: p.textMuted, cursor: 'pointer',
      }}><SIcon.sparkle size={14} /></div>
      <div onClick={onOpenSettings} style={{
        width: 30, height: 30, borderRadius: 9,
        background: p.surfaceLo, border: `1px solid ${p.line}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: p.textMuted, cursor: 'pointer',
      }}><SIcon.cog size={14} /></div>
    </div>
  );
}

// ─── Console drawer (bottom) ────────────────────────────────────────
const CONSOLE_LOGS = [
  { lvl: 'info',  ts: '20:14:08.412', src: 'http',   msg: 'GET https://api.restura.dev/v2/users/42/orders → 200 OK in 114ms' },
  { lvl: 'debug', ts: '20:14:08.418', src: 'env',    msg: 'Resolved {{userId}} = 42 from environment "production"' },
  { lvl: 'debug', ts: '20:14:08.418', src: 'auth',   msg: 'Attached Bearer token from vault (sk_live_••••••••)' },
  { lvl: 'info',  ts: '20:14:08.526', src: 'tests',  msg: '✓ status is 200' },
  { lvl: 'info',  ts: '20:14:08.526', src: 'tests',  msg: '✓ has 2 orders' },
  { lvl: 'warn',  ts: '20:14:09.102', src: 'http',   msg: 'X-RateLimit-Remaining low: 4982 / 10000' },
  { lvl: 'error', ts: '20:14:14.882', src: 'ws',     msg: 'Schema mismatch: expected `status` to be string, got null on orders[1]' },
  { lvl: 'debug', ts: '20:14:14.882', src: 'history',msg: 'Saved response to history (req_4f3a91c8e2b6)' },
  { lvl: 'info',  ts: '20:14:23.118', src: 'ws',     msg: '← ping seq=42, replied with pong' },
];
const LVL_COL = { info: '#06b6d4', debug: '#94a3b8', warn: '#f59e0b', error: '#ef4444' };

function ConsoleDrawer({ p, open, onToggle }) {
  const [filter, setFilter] = React.useState('all');
  const counts = CONSOLE_LOGS.reduce((a, l) => ({ ...a, [l.lvl]: (a[l.lvl] || 0) + 1 }), {});
  const logs = filter === 'all' ? CONSOLE_LOGS : CONSOLE_LOGS.filter((l) => l.lvl === filter);
  return (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderTop: `1px solid ${p.line}`,
      background: p.name === 'dark' ? 'rgba(0,0,0,0.25)' : 'rgba(14,19,32,0.02)',
    }}>
      <div onClick={onToggle} style={{
        height: 32, padding: '0 14px',
        display: 'flex', alignItems: 'center', gap: 12,
        cursor: 'pointer', userSelect: 'none',
      }}>
        <SIcon.chevron size={12} style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', opacity: 0.6, transition: 'transform .15s' }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7, color: p.textDim, textTransform: 'uppercase' }}>Console</span>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, color: p.textMuted, padding: '1px 5px', borderRadius: 4, background: p.surfaceLo }}>{CONSOLE_LOGS.length}</span>
        <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: p.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
          {['error', 'warn', 'info', 'debug'].map((l) => counts[l] ? (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: LVL_COL[l] }} />
              {counts[l]}
            </span>
          ) : null)}
        </div>
        <div style={{ flex: 1 }} />
        {!open && <span style={{ fontSize: 11, color: p.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>last: <span style={{ color: '#ef4444' }}>error</span> · 14m ago</span>}
        {open && (
          <div onClick={(e) => e.stopPropagation()} style={{
            display: 'flex', gap: 4, alignItems: 'center',
            padding: '3px 8px', borderRadius: 6,
            background: p.surfaceLo, border: `1px solid ${p.line}`,
            fontSize: 10.5, color: p.textMuted,
          }}>
            <SIcon.filter size={10} />
            {['all', 'error', 'warn', 'info', 'debug'].map((f) => (
              <span key={f} onClick={() => setFilter(f)} style={{
                padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
                fontWeight: f === filter ? 700 : 500,
                color: f === filter ? p.text : p.textMuted,
                background: f === filter ? p.hoverBg : 'transparent',
              }}>{f}</span>
            ))}
          </div>
        )}
        {open && <SIcon.download size={12} style={{ color: p.textMuted, cursor: 'pointer' }} />}
        {open && <SIcon.trash    size={12} style={{ color: p.textMuted, cursor: 'pointer' }} />}
      </div>
      {open && (
        <div style={{
          height: 200, overflow: 'auto', padding: '4px 0',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, lineHeight: 1.5,
          borderTop: `1px solid ${p.line}`,
          background: p.name === 'dark' ? 'rgba(0,0,0,0.35)' : 'rgba(14,19,32,0.025)',
        }}>
          {logs.map((l, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '110px 60px 70px 1fr',
              gap: 12, padding: '4px 14px', alignItems: 'baseline',
            }}>
              <span style={{ color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>{l.ts}</span>
              <span style={{ color: LVL_COL[l.lvl], fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{l.lvl}</span>
              <span style={{ color: p.textMuted }}>[{l.src}]</span>
              <span style={{ color: p.text }} dangerouslySetInnerHTML={{ __html: l.msg
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/(\d+\s*ms\b)/g, `<span style="color:${p.accent};font-weight:600">$1</span>`)
                .replace(/\b(200 OK|201 Created)\b/g, `<span style="color:#22c55e;font-weight:600">$1</span>`)
                .replace(/\b(404|500)\b/g, `<span style="color:#ef4444;font-weight:600">$1</span>`)
                .replace(/(✓)/g, `<span style="color:#22c55e">$1</span>`)
                .replace(/(\{\{[^}]+\}\})/g, `<span style="color:#f59e0b">$1</span>`)
              }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Status bar (bottom) ─────────────────────────────────────────────
function StatusBar({ p, env }) {
  return (
    <div style={{
      height: 28, flexShrink: 0, padding: '0 16px',
      display: 'flex', alignItems: 'center', gap: 16,
      fontSize: 11, color: p.textMuted,
      borderTop: `1px solid ${p.line}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: env.color, boxShadow: `0 0 6px ${env.color}` }} />
        {env.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><SIcon.bolt size={11} /> 14 requests</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Auto-save</div>
      <div style={{ flex: 1 }} />
      <div>HTTP/2 · TLS 1.3</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>v1.4.2</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Kbd p={p}>⌘K</Kbd> Palette
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const p = makePalette(t.theme, t.accent);

  const [tabs, setTabs] = React.useState(INITIAL_TABS);
  const [sidebarTab, setSidebarTab] = React.useState('collections');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [envOpen, setEnvOpen] = React.useState(false);
  const [env, setEnv] = React.useState(DATA.envs[0]);
  const [consoleOpen, setConsoleOpen] = React.useState(false);

  // Global keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
      if (mod && e.key === ',') { e.preventDefault(); setSettingsOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeTab = tabs.find((x) => x.active) || tabs[0];

  const onSelectTab = (id) => setTabs(tabs.map((x) => ({ ...x, active: x.id === id })));
  const onCloseTab  = (id) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((x) => x.id === id);
    const remaining = tabs.filter((x) => x.id !== id);
    const wasActive = tabs[idx].active;
    if (wasActive && remaining.length) {
      const nextIdx = Math.max(0, idx - 1);
      remaining[nextIdx] = { ...remaining[nextIdx], active: true };
    }
    setTabs(remaining);
  };
  const onNewTab = () => {
    const id = `t${Date.now()}`;
    setTabs([...tabs.map((x) => ({ ...x, active: false })), {
      id, proto: 'HTTP', method: 'GET', name: 'New request', reqId: '', dirty: true, active: true,
    }]);
  };

  const onSelectRequest = (req) => {
    // open in new tab or switch to existing
    const existing = tabs.find((x) => x.reqId === req.id);
    if (existing) { onSelectTab(existing.id); return; }
    const newTab = { id: `t${Date.now()}`, proto: req.proto, name: req.name, reqId: req.id, dirty: false, active: true };
    setTabs([...tabs.map((x) => ({ ...x, active: false })), newTab]);
  };

  const onPaletteSelect = (it) => {
    if (it.kind === 'set' && it.name.includes('theme')) {
      setTweak('theme', t.theme === 'dark' ? 'light' : 'dark');
    } else if (it.kind === 'set' && it.name.includes('settings')) {
      setSettingsOpen(true);
    } else if (it.go) {
      const req = DATA.collections.flatMap((c) => c.children || []).find((r) => r.id === it.go);
      if (req) onSelectRequest(req);
    }
  };

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden', position: 'relative',
      background: p.bg, borderRadius: 16,
      boxShadow: p.name === 'dark'
        ? `0 0 0 1px rgba(255,255,255,0.06), 0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px ${t.accent}1f`
        : `0 0 0 1px rgba(0,0,0,0.08), 0 40px 100px rgba(20,30,60,0.25)`,
      color: p.text, fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      {/* aurora background */}
      <div style={{ position: 'absolute', inset: 0, background: p.bgGlow }} />
      {p.name === 'dark' && t.showStars && <StarField />}

      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <WindowChrome p={p} env={env}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <div style={{ flex: 1, display: 'flex', gap: 12, padding: '0 14px 12px', minHeight: 0 }}>
          {t.sidebar === 'left' && (
            <Sidebar p={p} sidebarTab={sidebarTab} setSidebarTab={setSidebarTab}
              activeReqId={activeTab.reqId}
              onSelectRequest={onSelectRequest}
              env={env} onOpenEnv={() => setEnvOpen(true)}
            />
          )}

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <TabStrip p={p} tabs={tabs}
              onSelect={onSelectTab} onClose={onCloseTab} onNew={onNewTab}
            />
            <ProtocolBody p={p} proto={activeTab.proto} />
          </div>

          {t.sidebar === 'right' && (
            <Sidebar p={p} sidebarTab={sidebarTab} setSidebarTab={setSidebarTab}
              activeReqId={activeTab.reqId}
              onSelectRequest={onSelectRequest}
              env={env} onOpenEnv={() => setEnvOpen(true)}
            />
          )}
        </div>

        <ConsoleDrawer p={p} open={consoleOpen} onToggle={() => setConsoleOpen((o) => !o)} />
        <StatusBar p={p} env={env} />
      </div>

      <CommandPalette p={p} open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={onPaletteSelect}
      />
      <SettingsDrawer p={p} open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={t.theme} accent={t.accent}
        onThemeChange={(v) => setTweak('theme', v)}
        onAccentChange={(v) => setTweak('accent', v)}
      />
      <EnvSwitcher p={p} open={envOpen}
        onClose={() => setEnvOpen(false)}
        env={env} onChange={setEnv}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={['dark', 'light']}
          onChange={(v) => setTweak('theme', v)} />
        <TweakColor label="Accent" value={t.accent}
          options={['#4d9fff', '#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4']}
          onChange={(v) => setTweak('accent', v)} />

        <TweakSection label="Layout" />
        <TweakRadio label="Sidebar" value={t.sidebar} options={['left', 'right']}
          onChange={(v) => setTweak('sidebar', v)} />
        <TweakRadio label="Density" value={t.density} options={['compact', 'balanced', 'comfy']}
          onChange={(v) => setTweak('density', v)} />

        <TweakSection label="Atmosphere" />
        <TweakToggle label="Star field" value={t.showStars}
          onChange={(v) => setTweak('showStars', v)} />
        <TweakSlider label="Glass intensity" value={t.glassIntensity}
          min={0} max={2} step={0.1}
          onChange={(v) => setTweak('glassIntensity', v)} />
      </TweaksPanel>
    </div>
  );
}

// ─── Route protocol view ─────────────────────────────────────────────
function ProtocolBody({ p, proto }) {
  const inner = (() => {
    switch (proto) {
      case 'HTTP':  return <HttpView p={p} />;
      case 'GQL':   return <GraphQLView p={p} />;
      case 'gRPC':  return <GrpcView p={p} />;
      case 'WS':    return <WebSocketView p={p} />;
      case 'SSE':   return <SSEView p={p} />;
      case 'MCP':   return <MCPView p={p} />;
      case 'Kafka': return <KafkaView p={p} />;
      default:      return <HttpView p={p} />;
    }
  })();
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0,
    }}>{inner}</div>
  );
}

// ─── Decorative star field ───────────────────────────────────────────
function StarField() {
  const stars = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 40; i++) {
      arr.push({
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.random() < 0.85 ? 0.5 : 1,
        opacity: 0.3 + Math.random() * 0.6,
      });
    }
    return arr;
  }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {stars.map((s, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${s.x}%`, top: `${s.y}%`,
          width: s.size, height: s.size, borderRadius: '50%',
          background: '#fff', opacity: s.opacity,
          boxShadow: s.size > 0.5 ? '0 0 3px rgba(255,255,255,0.6)' : 'none',
        }} />
      ))}
    </div>
  );
}

// ─── Stage: scale 1440×900 design to fit viewport, letterboxed ──────
function Stage({ children, width = 1440, height = 900 }) {
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const fit = () => {
      const s = Math.min(window.innerWidth / width, window.innerHeight / height);
      setScale(s);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [width, height]);
  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#000', overflow: 'hidden',
    }}>
      <div style={{
        width, height, transform: `scale(${scale})`, transformOrigin: 'center',
        flexShrink: 0,
      }}>{children}</div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Stage><App /></Stage>);
