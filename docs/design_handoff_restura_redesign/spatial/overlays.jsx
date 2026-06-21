// Spatial · Overlays — Command palette (⌘K) and Settings drawer

// ─── Command palette ─────────────────────────────────────────────────
function CommandPalette({ p, open, onClose, onSelect }) {
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(1);
  const inputRef = React.useRef(null);

  const items = React.useMemo(
    () => [
      {
        group: 'Requests',
        kind: 'req',
        method: 'POST',
        name: 'Create order',
        path: 'Restura API · Orders',
        go: 'create-order',
      },
      {
        group: 'Requests',
        kind: 'req',
        method: 'GET',
        name: 'List orders',
        path: 'Restura API · Orders',
        recent: true,
        go: 'list-orders',
      },
      {
        group: 'Requests',
        kind: 'req',
        method: 'PATCH',
        name: 'Update order status',
        path: 'Restura API · Orders',
        go: 'update-order',
      },
      {
        group: 'Requests',
        kind: 'req',
        method: 'GET',
        name: 'Get order by id',
        path: 'Restura API · Orders',
        go: 'get-order',
      },
      { group: 'Actions', kind: 'act', icon: 'send', name: 'Send current request', shortcut: '⌘↵' },
      { group: 'Actions', kind: 'act', icon: 'copy', name: 'Copy as cURL', shortcut: '⌘⇧C' },
      { group: 'Actions', kind: 'act', icon: 'history', name: 'Open last response in tab' },
      { group: 'Actions', kind: 'act', icon: 'globe', name: 'Switch environment → staging' },
      { group: 'New', kind: 'new', proto: 'HTTP', name: 'New HTTP request' },
      { group: 'New', kind: 'new', proto: 'gRPC', name: 'New gRPC request' },
      { group: 'New', kind: 'new', proto: 'MCP', name: 'New MCP connection' },
      { group: 'Settings', kind: 'set', icon: 'cog', name: 'Open settings…', shortcut: '⌘,' },
      { group: 'Settings', kind: 'set', icon: 'sparkle', name: 'Toggle theme · dark ↔ light' },
    ],
    []
  );

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);
  React.useEffect(() => {
    setIdx(1);
  }, [q]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, items.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onSelect && onSelect(items[idx]);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, idx, items, onClose, onSelect]);

  if (!open) return null;

  const filtered = q
    ? items.filter(
        (it) =>
          it.name.toLowerCase().includes(q.toLowerCase()) ||
          (it.path && it.path.toLowerCase().includes(q.toLowerCase()))
      )
    : items;

  // group rows
  const groups = ['Requests', 'Actions', 'New', 'Settings'];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: p.name === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxHeight: 480,
          background: p.surfaceHi,
          borderRadius: 14,
          border: `1px solid ${p.lineStrong}`,
          boxShadow: p.floatShadowLg,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backdropFilter: 'blur(40px) saturate(180%)',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderBottom: `1px solid ${p.line}`,
          }}
        >
          <SIcon.search size={15} style={{ color: p.textMuted }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search requests, actions, settings…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 0,
              outline: 0,
              fontFamily: 'Geist, sans-serif',
              fontSize: 14,
              color: p.text,
            }}
          />
          <Kbd p={p}>ESC</Kbd>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {groups.map((g) => {
            const inGroup = filtered.filter((x) => x.group === g);
            if (!inGroup.length) return null;
            return (
              <React.Fragment key={g}>
                <div
                  style={{
                    padding: '8px 16px 4px',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.7,
                    color: p.textDim,
                    textTransform: 'uppercase',
                  }}
                >
                  {g}
                </div>
                {inGroup.map((it) => {
                  const gIdx = filtered.indexOf(it);
                  const highlighted = gIdx === idx;
                  return (
                    <div
                      key={it.name}
                      onMouseEnter={() => setIdx(gIdx)}
                      onClick={() => {
                        onSelect && onSelect(it);
                        onClose();
                      }}
                      style={{
                        padding: '8px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        background: highlighted ? p.activeBg : 'transparent',
                        borderLeft: highlighted ? `2px solid ${p.accent}` : `2px solid transparent`,
                        fontSize: 12.5,
                        cursor: 'pointer',
                      }}
                    >
                      {it.method && <MethodChip method={it.method} />}
                      {it.proto && <ProtoChip proto={it.proto} />}
                      {it.icon && (
                        <span style={{ color: p.textMuted, display: 'flex' }}>
                          {SIcon[it.icon]({ size: 14 })}
                        </span>
                      )}
                      <span style={{ color: p.text, fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {it.name}
                      </span>
                      {it.path && (
                        <span
                          style={{
                            color: p.textDim,
                            fontSize: 11,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            minWidth: 0,
                          }}
                        >
                          {it.path}
                        </span>
                      )}
                      {it.recent && (
                        <span
                          style={{
                            fontSize: 9.5,
                            color: p.textDim,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: p.surfaceLo,
                            letterSpacing: 0.5,
                            fontWeight: 600,
                          }}
                        >
                          RECENT
                        </span>
                      )}
                      <div style={{ flex: 1 }} />
                      {it.shortcut && <Kbd p={p}>{it.shortcut}</Kbd>}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: p.textMuted, fontSize: 13 }}>
              No matches for "{q}"
            </div>
          )}
        </div>

        <div
          style={{
            padding: '10px 16px',
            borderTop: `1px solid ${p.line}`,
            display: 'flex',
            gap: 18,
            fontSize: 10.5,
            color: p.textDim,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Kbd p={p}>↑↓</Kbd> navigate
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Kbd p={p}>↵</Kbd> select
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Kbd p={p}>⌘↵</Kbd> in new tab
          </span>
          <div style={{ flex: 1 }} />
          <span>{filtered.length} results</span>
        </div>
      </div>
    </div>
  );
}

// ─── Settings drawer ─────────────────────────────────────────────────
function SettingsDrawer({ p, open, onClose, theme, accent, onThemeChange, onAccentChange }) {
  const [section, setSection] = React.useState('General');
  if (!open) return null;

  const sections = [
    { name: 'General', icon: 'cog' },
    { name: 'Appearance', icon: 'sparkle' },
    { name: 'Requests', icon: 'send' },
    { name: 'Proxy', icon: 'globe' },
    { name: 'Certificates', icon: 'shield' },
    { name: 'Secrets', icon: 'link' },
    { name: 'Shortcuts', icon: 'command' },
    { name: 'About', icon: 'star' },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        background: p.name === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.18)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          height: '100%',
          background: p.surfaceHi,
          borderLeft: `1px solid ${p.lineStrong}`,
          boxShadow: '-30px 0 80px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(40px) saturate(180%)',
          animation: 'slideIn .25s cubic-bezier(.2,.7,.3,1)',
        }}
      >
        <div
          style={{
            height: 56,
            flexShrink: 0,
            padding: '0 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderBottom: `1px solid ${p.line}`,
          }}
        >
          <SIcon.cog size={16} style={{ color: p.textMuted }} />
          <span style={{ fontSize: 16, fontWeight: 700, color: p.text }}>Settings</span>
          <div style={{ flex: 1 }} />
          <div
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: p.textMuted,
              cursor: 'pointer',
              background: p.surfaceLo,
            }}
          >
            <SIcon.close size={14} />
          </div>
        </div>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: 0 }}>
          {/* sections nav */}
          <div
            style={{
              padding: 12,
              borderRight: `1px solid ${p.line}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {sections.map((s) => (
              <div
                key={s.name}
                onClick={() => setSection(s.name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: s.name === section ? 600 : 500,
                  color: s.name === section ? p.text : p.textMuted,
                  background: s.name === section ? p.activeBg : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{ color: s.name === section ? p.accent : p.textMuted, display: 'flex' }}
                >
                  {SIcon[s.icon]({ size: 14 })}
                </span>
                {s.name}
              </div>
            ))}
          </div>

          {/* section content */}
          <div style={{ padding: 28, overflow: 'auto' }}>
            {section === 'General' && (
              <React.Fragment>
                <H1 p={p}>General</H1>
                <SectionLabel p={p}>History</SectionLabel>
                <ToggleField
                  p={p}
                  on={true}
                  label="Auto-save to history"
                  hint="Every send is captured for replay"
                />
                <ToggleField
                  p={p}
                  on={true}
                  label="Sync across devices"
                  hint="Encrypted with workspace key"
                />
                <FieldRow p={p} label="Max history items" hint="Older items are dropped">
                  <Stepper p={p} value="500" />
                </FieldRow>
                <SectionLabel p={p}>Updates</SectionLabel>
                <ToggleField
                  p={p}
                  on={true}
                  label="Check for updates automatically"
                  hint="Notify when a new version is available"
                />
                <FieldRow
                  p={p}
                  label="Release channel"
                  hint="Beta gets new features ~2 weeks earlier"
                >
                  <Segmented p={p} value="Stable" options={['Stable', 'Beta', 'Nightly']} />
                </FieldRow>
              </React.Fragment>
            )}

            {section === 'Appearance' && (
              <React.Fragment>
                <H1 p={p}>Appearance</H1>
                <SectionLabel p={p}>Theme</SectionLabel>
                <FieldRow p={p} label="Mode" hint="Match system, or pin a fixed mode">
                  <Segmented
                    p={p}
                    value={theme}
                    options={['light', 'dark']}
                    onChange={onThemeChange}
                  />
                </FieldRow>
                <FieldRow p={p} label="Accent color" hint="Used for buttons, focus rings, links">
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['#4d9fff', '#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4'].map((c) => (
                      <div
                        key={c}
                        onClick={() => onAccentChange(c)}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 7,
                          background: c,
                          cursor: 'pointer',
                          boxShadow:
                            c === accent
                              ? `0 0 0 2px ${p.surface}, 0 0 0 4px ${c}`
                              : 'inset 0 0 0 0.5px rgba(0,0,0,0.15)',
                        }}
                      />
                    ))}
                  </div>
                </FieldRow>
                <FieldRow p={p} label="Density" hint="Tighter rows fit more on screen">
                  <Segmented p={p} value="Balanced" options={['Compact', 'Balanced', 'Comfy']} />
                </FieldRow>
                <SectionLabel p={p}>Editor</SectionLabel>
                <FieldRow p={p} label="Font family" hint="Code editor & response viewer">
                  <Segmented
                    p={p}
                    value="JetBrains Mono"
                    options={['JetBrains Mono', 'SF Mono', 'Berkeley Mono']}
                  />
                </FieldRow>
                <FieldRow p={p} label="Font size">
                  <Stepper p={p} value="13 px" />
                </FieldRow>
                <ToggleField p={p} on={true} label="Show line numbers" hint="In every code block" />
                <ToggleField p={p} on={true} label="Highlight matching brackets" />
              </React.Fragment>
            )}

            {section === 'Requests' && (
              <React.Fragment>
                <H1 p={p}>Requests</H1>
                <SectionLabel p={p}>Defaults</SectionLabel>
                <ToggleField
                  p={p}
                  on={true}
                  label="Follow redirects"
                  hint="Resolve 3xx chain up to 10 hops"
                />
                <ToggleField
                  p={p}
                  on={false}
                  label="Verify SSL certificate"
                  hint="Allow self-signed for dev environments"
                />
                <FieldRow p={p} label="Default timeout" hint="Abort if no response within…">
                  <Stepper p={p} value="30 000 ms" />
                </FieldRow>
                <FieldRow p={p} label="Default content-type">
                  <Segmented p={p} value="JSON" options={['JSON', 'form', 'none']} />
                </FieldRow>
              </React.Fragment>
            )}

            {section === 'Proxy' && (
              <React.Fragment>
                <H1 p={p}>Proxy</H1>
                <ToggleField
                  p={p}
                  on={false}
                  label="Use proxy server"
                  hint="Route all requests through a proxy"
                />
                <FieldRow p={p} label="HTTP proxy">
                  <TextField p={p} value="http://proxy.corp:8080" />
                </FieldRow>
                <FieldRow p={p} label="HTTPS proxy">
                  <TextField p={p} value="http://proxy.corp:8080" />
                </FieldRow>
                <FieldRow p={p} label="No proxy" hint="Comma-separated hostnames">
                  <TextField p={p} value="localhost, *.local" />
                </FieldRow>
              </React.Fragment>
            )}

            {section === 'Shortcuts' && (
              <React.Fragment>
                <H1 p={p}>Shortcuts</H1>
                {[
                  ['Command palette', '⌘ K'],
                  ['Send request', '⌘ ↵'],
                  ['New request', '⌘ N'],
                  ['Close tab', '⌘ W'],
                  ['Reopen closed tab', '⌘ ⇧ T'],
                  ['Toggle sidebar', '⌘ \\'],
                  ['Toggle response panel', '⌘ J'],
                  ['Switch to next tab', '⌘ ⌥ →'],
                  ['Copy as cURL', '⌘ ⇧ C'],
                  ['Open settings', '⌘ ,'],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '11px 0',
                      borderBottom: `1px solid ${p.line}`,
                    }}
                  >
                    <span style={{ fontSize: 13, color: p.text }}>{k}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {v.split(' ').map((part, i) => (
                        <Kbd key={i} p={p}>
                          {part}
                        </Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </React.Fragment>
            )}

            {(section === 'Certificates' || section === 'Secrets' || section === 'About') && (
              <React.Fragment>
                <H1 p={p}>{section}</H1>
                <div style={{ color: p.textMuted, fontSize: 13, padding: '24px 0' }}>
                  {section === 'About' ? (
                    <React.Fragment>
                      Restura v1.4.2 · macOS · Electron 28
                      <br />
                      <br />
                      Made for people who poke at APIs all day.
                    </React.Fragment>
                  ) : (
                    'Coming soon — manage trusted CAs, client certificates, and signed-in vault entries here.'
                  )}
                </div>
              </React.Fragment>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const H1 = ({ p, children }) => (
  <div style={{ fontSize: 22, fontWeight: 700, color: p.text, marginBottom: 22 }}>{children}</div>
);
const SectionLabel = ({ p, children }) => (
  <div
    style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.7,
      color: p.textDim,
      textTransform: 'uppercase',
      marginTop: 18,
      marginBottom: 10,
    }}
  >
    {children}
  </div>
);
const FieldRow = ({ p, label, hint, children }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      alignItems: 'center',
      gap: 24,
      padding: '12px 0',
      borderBottom: `1px solid ${p.line}`,
    }}
  >
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: p.text }}>{label}</div>
      {hint && <div style={{ fontSize: 11.5, color: p.textMuted, marginTop: 2 }}>{hint}</div>}
    </div>
    <div>{children}</div>
  </div>
);
const ToggleField = ({ p, on, label, hint }) => (
  <FieldRow p={p} label={label} hint={hint}>
    <div
      style={{
        width: 36,
        height: 22,
        borderRadius: 999,
        padding: 2,
        background: on ? p.accent : p.lineStrong,
        boxShadow: on ? `0 4px 10px ${p.accent}55` : 'none',
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transform: on ? 'translateX(14px)' : 'translateX(0)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'transform .15s',
        }}
      />
    </div>
  </FieldRow>
);
const Segmented = ({ p, options, value, onChange }) => (
  <div
    style={{
      display: 'flex',
      padding: 2,
      borderRadius: 8,
      background: p.surfaceLo,
      border: `1px solid ${p.line}`,
    }}
  >
    {options.map((o) => (
      <div
        key={o}
        onClick={() => onChange && onChange(o)}
        style={{
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 6,
          cursor: 'pointer',
          color: o === value ? p.text : p.textMuted,
          background:
            o === value ? (p.name === 'dark' ? 'rgba(255,255,255,0.07)' : '#fff') : 'transparent',
          boxShadow: o === value && p.name === 'light' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
        }}
      >
        {o}
      </div>
    ))}
  </div>
);
const Stepper = ({ p, value }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: '4px 4px 4px 12px',
      borderRadius: 8,
      background: p.surfaceLo,
      border: `1px solid ${p.line}`,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      fontWeight: 600,
    }}
  >
    <span style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 10 }}>
      <div style={{ padding: '0 4px', cursor: 'pointer' }}>
        <SIcon.chevron size={10} style={{ transform: 'rotate(180deg)' }} />
      </div>
      <div style={{ padding: '0 4px', cursor: 'pointer' }}>
        <SIcon.chevron size={10} />
      </div>
    </div>
  </div>
);
const TextField = ({ p, value }) => (
  <div
    style={{
      padding: '7px 10px',
      borderRadius: 8,
      background: p.surfaceLo,
      border: `1px solid ${p.line}`,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      color: p.text,
      minWidth: 280,
    }}
  >
    {value}
  </div>
);

// ─── Env switcher popover ────────────────────────────────────────────
function EnvSwitcher({ p, open, onClose, env, onChange }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        background: 'transparent',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 20,
          bottom: 50,
          width: 320,
          background: p.surfaceHi,
          borderRadius: 14,
          border: `1px solid ${p.lineStrong}`,
          boxShadow: p.floatShadowLg,
          backdropFilter: 'blur(40px) saturate(180%)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${p.line}`,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: p.textDim,
            textTransform: 'uppercase',
          }}
        >
          Switch environment
        </div>
        {DATA.envs.map((e) => {
          const active = e.id === env.id;
          return (
            <div
              key={e.id}
              onClick={() => {
                onChange(e);
                onClose();
              }}
              style={{
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                background: active ? p.activeBg : 'transparent',
                borderLeft: active ? `2px solid ${p.accent}` : `2px solid transparent`,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: e.color,
                  boxShadow: `0 0 0 3px ${e.color}26`,
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: p.text }}>{e.name}</div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: p.textDim,
                    fontFamily: '"JetBrains Mono", monospace',
                  }}
                >
                  {e.host} · {e.vars} vars
                </div>
              </div>
              {active && <SIcon.check size={14} style={{ color: p.accent }} />}
            </div>
          );
        })}
        <div
          style={{
            padding: '10px 14px',
            borderTop: `1px solid ${p.line}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: p.textMuted,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <SIcon.plus size={13} /> New environment
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CommandPalette, SettingsDrawer, EnvSwitcher });
