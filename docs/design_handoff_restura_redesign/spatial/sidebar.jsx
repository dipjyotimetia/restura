// Spatial · Sidebar — Collections / History / Workflows + Env switcher

function Sidebar({ p, sidebarTab, setSidebarTab, activeReqId, onSelectRequest, env, onOpenEnv }) {
  return (
    <Floater
      p={p}
      radius={14}
      style={{
        width: 268,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
      }}
    >
      {/* org / workspace header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px 10px' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: `linear-gradient(135deg, ${p.accent}, #a78bfa)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
            boxShadow: `0 6px 18px ${p.accent}55`,
          }}
        >
          R
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: p.text }}>Restura</div>
          <div style={{ fontSize: 10.5, color: p.textMuted }}>Personal · 24 requests</div>
        </div>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: p.textMuted,
            cursor: 'pointer',
          }}
        >
          <SIcon.more size={14} />
        </div>
      </div>

      {/* search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '8px 10px',
          borderRadius: 9,
          background: p.surfaceLo,
          border: `1px solid ${p.line}`,
        }}
      >
        <SIcon.search size={13} style={{ opacity: 0.55 }} />
        <span style={{ fontSize: 12, color: p.textDim }}>Quick find…</span>
        <div style={{ flex: 1 }} />
        <Kbd p={p}>⌘K</Kbd>
      </div>

      {/* segmented tabs */}
      <div
        style={{
          display: 'flex',
          padding: 3,
          marginTop: 2,
          borderRadius: 9,
          background: p.surfaceLo,
        }}
      >
        {[
          { k: 'collections', label: 'Collections', icon: 'folder' },
          { k: 'history', label: 'History', icon: 'history' },
          { k: 'workflows', label: 'Workflows', icon: 'workflow' },
        ].map((t) => (
          <div
            key={t.k}
            onClick={() => setSidebarTab(t.k)}
            style={{
              flex: 1,
              padding: '5px 0',
              borderRadius: 6,
              textAlign: 'center',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              color: t.k === sidebarTab ? p.text : p.textMuted,
              background:
                t.k === sidebarTab
                  ? p.name === 'dark'
                    ? 'rgba(255,255,255,0.08)'
                    : '#fff'
                  : 'transparent',
              boxShadow:
                t.k === sidebarTab && p.name === 'light' ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
            }}
          >
            <span style={{ display: 'flex' }}>{SIcon[t.icon]({ size: 12 })}</span>
            {t.label}
          </div>
        ))}
      </div>

      {/* content */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          marginTop: 4,
        }}
      >
        {sidebarTab === 'collections' && (
          <CollectionsView p={p} activeReqId={activeReqId} onSelectRequest={onSelectRequest} />
        )}
        {sidebarTab === 'history' && <HistoryView p={p} />}
        {sidebarTab === 'workflows' && <WorkflowsView p={p} />}
      </div>

      {/* env footer */}
      <div
        onClick={onOpenEnv}
        style={{
          padding: '10px 10px',
          borderRadius: 10,
          background: p.surfaceLo,
          border: `1px solid ${p.line}`,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: env.color,
            boxShadow: `0 0 0 3px ${env.color}26`,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: p.text }}>{env.name}</div>
          <div
            style={{
              fontSize: 10,
              color: p.textDim,
              fontFamily: '"JetBrains Mono", monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {env.host}
          </div>
        </div>
        <SIcon.chevron size={12} style={{ opacity: 0.5 }} />
      </div>
    </Floater>
  );
}

function CollectionsView({ p, activeReqId, onSelectRequest }) {
  const [open, setOpen] = React.useState(() =>
    Object.fromEntries(DATA.collections.map((c) => [c.id, c.open]))
  );

  return (
    <React.Fragment>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px 6px',
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: p.textDim,
            textTransform: 'uppercase',
          }}
        >
          5 collections
        </span>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            color: p.textMuted,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SIcon.plus size={13} />
        </div>
      </div>
      {DATA.collections.map((c) => (
        <React.Fragment key={c.id}>
          <div
            onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 10px',
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: 500,
              color: p.text,
              background: open[c.id] ? p.hoverBg : 'transparent',
              cursor: 'pointer',
            }}
          >
            <SIcon.chevron
              size={11}
              style={{
                transform: open[c.id] ? 'rotate(0deg)' : 'rotate(-90deg)',
                opacity: 0.5,
                transition: 'transform .12s',
              }}
            />
            <SIcon.folder size={13} style={{ color: open[c.id] ? p.accent : p.textMuted }} />
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.name}
            </span>
            <span style={{ fontSize: 10.5, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>
              {c.count}
            </span>
          </div>
          {open[c.id] &&
            c.children &&
            c.children.map((ch) => (
              <div
                key={ch.id}
                onClick={() => onSelectRequest(ch)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 10px 5px 28px',
                  borderRadius: 7,
                  fontSize: 12,
                  color: ch.id === activeReqId ? p.text : p.textMuted,
                  fontWeight: ch.id === activeReqId ? 600 : 500,
                  background: ch.id === activeReqId ? p.activeBg : 'transparent',
                  position: 'relative',
                  cursor: 'pointer',
                }}
              >
                {ch.id === activeReqId && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 18,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 3,
                      height: 14,
                      borderRadius: 2,
                      background: p.accent,
                      boxShadow: `0 0 8px ${p.accent}`,
                    }}
                  />
                )}
                <MethodChip method={ch.method} />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ch.name}
                </span>
                {ch.proto !== 'HTTP' && <ProtoChip proto={ch.proto} />}
              </div>
            ))}
        </React.Fragment>
      ))}
    </React.Fragment>
  );
}

function HistoryView({ p }) {
  const [filter, setFilter] = React.useState('All');
  const filters = ['All', 'GET', 'POST', 'Errors', 'Pinned'];
  // group by relative day buckets
  const groups = [
    { label: 'Today', items: DATA.history.slice(0, 6) },
    { label: 'Yesterday', items: DATA.history.slice(6, 9) },
    { label: 'Earlier', items: DATA.history.slice(9) },
  ];
  return (
    <React.Fragment>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '2px 4px 6px',
          flexWrap: 'wrap',
        }}
      >
        {filters.map((f) => (
          <div
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '3px 9px',
              borderRadius: 6,
              fontSize: 10.5,
              fontWeight: 600,
              color: f === filter ? p.text : p.textMuted,
              background: f === filter ? p.hoverBg : 'transparent',
              cursor: 'pointer',
            }}
          >
            {f}
          </div>
        ))}
      </div>
      {groups.map((g) => (
        <React.Fragment key={g.label}>
          <div
            style={{
              padding: '8px 10px 4px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: p.textDim,
              textTransform: 'uppercase',
            }}
          >
            {g.label}
          </div>
          {g.items.map((h) => {
            const ok = h.status < 300;
            return (
              <div
                key={h.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
                className="hist-row"
              >
                <MethodChip method={h.method} />
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '1px 5px',
                    borderRadius: 4,
                    background: ok
                      ? 'rgba(34,197,94,0.16)'
                      : h.status >= 500
                        ? 'rgba(239,68,68,0.18)'
                        : 'rgba(245,158,11,0.16)',
                    color: ok ? '#22c55e' : h.status >= 500 ? '#ef4444' : '#f59e0b',
                  }}
                >
                  {h.status}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11.5,
                    color: p.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h.path}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10.5,
                    color: p.textDim,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {h.ms}ms
                </span>
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </React.Fragment>
  );
}

function WorkflowsView({ p }) {
  return (
    <React.Fragment>
      <div style={{ padding: '4px 8px 6px', display: 'flex', alignItems: 'center' }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: p.textDim,
            textTransform: 'uppercase',
          }}
        >
          3 workflows
        </span>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            color: p.textMuted,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SIcon.plus size={13} />
        </div>
      </div>
      {DATA.workflows.map((w) => {
        const ok = w.last === 'passed';
        return (
          <div
            key={w.id}
            style={{
              padding: '9px 10px',
              borderRadius: 9,
              background: p.surfaceLo,
              border: `1px solid ${p.line}`,
              marginBottom: 6,
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SIcon.workflow size={13} style={{ color: p.accent }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: p.text, flex: 1 }}>
                {w.name}
              </span>
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: ok ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.18)',
                  color: ok ? '#22c55e' : '#ef4444',
                }}
              >
                {ok ? 'PASS' : 'FAIL'}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginTop: 6,
                fontSize: 10.5,
                color: p.textMuted,
                fontFamily: '"JetBrains Mono", monospace',
              }}
            >
              <span>{w.steps} steps</span>
              <span>·</span>
              <span>{w.runs} runs</span>
              <span>·</span>
              <span>{ok ? 'last run 14m ago' : 'last run 1h ago'}</span>
            </div>
            {/* steps strip */}
            <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
              {Array.from({ length: w.steps }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    background: ok
                      ? i < w.steps - 1
                        ? '#22c55e'
                        : '#22c55e'
                      : i < 2
                        ? '#22c55e'
                        : i === 2
                          ? '#ef4444'
                          : p.line,
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </React.Fragment>
  );
}

Object.assign(window, { Sidebar });
