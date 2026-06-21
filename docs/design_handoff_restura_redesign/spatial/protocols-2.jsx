// Spatial · Realtime + agent protocols — WebSocket, SSE, MCP, Kafka

// ─── WebSocket ────────────────────────────────────────────────────────
function WebSocketView({ p }) {
  const events = [
    {
      dir: 'rx',
      ts: '20:14:08.412',
      size: '156 B',
      preview: '{"type":"connected","sessionId":"sess_8x"}',
    },
    {
      dir: 'tx',
      ts: '20:14:08.418',
      size: '48 B',
      preview: '{"type":"subscribe","channel":"orders"}',
    },
    {
      dir: 'rx',
      ts: '20:14:08.501',
      size: '92 B',
      preview: '{"type":"subscribed","channel":"orders"}',
    },
    {
      dir: 'rx',
      ts: '20:14:11.226',
      size: '218 B',
      preview: '{"type":"order.created","id":"ord_3Bm1Rfa"}',
    },
    {
      dir: 'rx',
      ts: '20:14:14.882',
      size: '186 B',
      preview: '{"type":"order.updated","id":"ord_7K9xQp2","status":"delivered"}',
      selected: true,
    },
    { dir: 'tx', ts: '20:14:15.012', size: '36 B', preview: '{"type":"ack","id":"ord_7K9xQp2"}' },
    {
      dir: 'rx',
      ts: '20:14:19.504',
      size: '198 B',
      preview: '{"type":"order.created","id":"ord_9Yp4Lzc"}',
    },
    { dir: 'rx', ts: '20:14:23.118', size: '64 B', preview: '{"type":"ping","seq":42}' },
    { dir: 'tx', ts: '20:14:23.125', size: '64 B', preview: '{"type":"pong","seq":42}' },
    {
      dir: 'rx',
      ts: '20:14:27.880',
      size: '224 B',
      preview: '{"type":"order.updated","id":"ord_3Bm1Rfa","status":"in_transit"}',
    },
  ];

  return (
    <React.Fragment>
      {/* connection bar */}
      <Floater
        p={p}
        radius={12}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 5,
          gap: 6,
        }}
      >
        <div
          style={{
            padding: '7px 14px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            fontWeight: 700,
            color: '#a78bfa',
            background: 'rgba(167,139,250,0.16)',
            borderRadius: 8,
          }}
        >
          WS
        </div>
        <div
          style={{
            flex: 1,
            padding: '0 12px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            color: p.text,
          }}
        >
          <span style={{ color: p.textDim }}>wss://</span>echo.restura.dev
          <span style={{ color: p.textDim }}>/live</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '4px 10px',
            borderRadius: 7,
            background: 'rgba(34,197,94,0.16)',
            boxShadow: '0 0 0 1px rgba(34,197,94,0.25), 0 0 16px rgba(34,197,94,0.2)',
            marginRight: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 8px #22c55e',
            }}
          />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11.5,
              fontWeight: 700,
              color: '#22c55e',
            }}
          >
            CONNECTED
          </span>
        </div>
        <button
          style={{
            padding: '8px 18px',
            borderRadius: 9,
            border: `1px solid #ef4444aa`,
            background: 'transparent',
            color: '#ef4444',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Disconnect
        </button>
      </Floater>

      {/* config row */}
      <Floater
        p={p}
        radius={12}
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          fontSize: 11.5,
          color: p.textMuted,
        }}
      >
        <Stat label="UPTIME" value="00:14:32" p={p} />
        <Stat label="↑" value="1.2 KB" p={p} />
        <Stat label="↓" value="14.8 KB" p={p} />
        <Stat label="LATENCY" value="38 ms" p={p} />
        <Stat label="PROTOCOL" value="graphql-ws" p={p} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span>auto-reconnect</span>
          <div
            style={{
              width: 26,
              height: 16,
              borderRadius: 999,
              padding: 2,
              background: p.accent,
              boxShadow: `0 0 8px ${p.accent}66`,
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#fff',
                transform: 'translateX(10px)',
              }}
            />
          </div>
        </div>
      </Floater>

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr',
          gap: 10,
          minHeight: 0,
        }}
      >
        {/* event stream */}
        <Floater
          p={p}
          radius={14}
          large
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${p.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Messages</span>
            <span
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                color: p.textMuted,
                padding: '1px 5px',
                borderRadius: 4,
                background: p.surfaceLo,
              }}
            >
              10
            </span>
            <div style={{ flex: 1 }} />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                borderRadius: 6,
                background: p.surfaceLo,
                border: `1px solid ${p.line}`,
                fontSize: 11,
                color: p.textMuted,
              }}
            >
              <SIcon.search size={11} />
              <span>Search…</span>
            </div>
            <div
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                background: p.surfaceLo,
                border: `1px solid ${p.line}`,
                fontSize: 11,
                color: p.textMuted,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              All <SIcon.chevron size={10} />
            </div>
            <SIcon.download size={13} style={{ color: p.textMuted, cursor: 'pointer' }} />
            <SIcon.trash size={13} style={{ color: p.textMuted, cursor: 'pointer' }} />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '36px 100px 60px 1fr',
              padding: '7px 14px',
              borderBottom: `1px solid ${p.line}`,
              gap: 12,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: p.textDim,
              textTransform: 'uppercase',
              background: p.surfaceLo,
            }}
          >
            <span>DIR</span>
            <span>TIME</span>
            <span>SIZE</span>
            <span>PREVIEW</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {events.map((e, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 100px 60px 1fr',
                  padding: '6px 14px',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: 11.5,
                  borderBottom: `1px solid ${p.line}`,
                  background: e.selected ? p.activeBg : 'transparent',
                  borderLeft: e.selected ? `2px solid ${p.accent}` : `2px solid transparent`,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    color: e.dir === 'rx' ? '#22c55e' : '#a78bfa',
                    fontWeight: 700,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                  }}
                >
                  {e.dir === 'rx' ? '← rx' : '→ tx'}
                </span>
                <span
                  style={{
                    color: p.textMuted,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                  }}
                >
                  {e.ts}
                </span>
                <span
                  style={{
                    color: p.textDim,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                  }}
                >
                  {e.size}
                </span>
                <span
                  style={{
                    color: p.text,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  dangerouslySetInnerHTML={{ __html: hlJSON(e.preview) }}
                />
              </div>
            ))}
          </div>
        </Floater>

        {/* selected message + composer */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <Floater
            p={p}
            radius={12}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              background: p.code,
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: `1px solid ${p.line}`,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>Selected message</span>
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  color: p.textDim,
                }}
              >
                20:14:14.882 · 186 B
              </span>
              <div style={{ flex: 1 }} />
              <SIcon.copy size={13} style={{ opacity: 0.55, cursor: 'pointer' }} />
            </div>
            <pre
              style={{
                flex: 1,
                margin: 0,
                padding: '12px 14px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                lineHeight: 1.55,
                color: p.text,
                overflow: 'auto',
              }}
              dangerouslySetInnerHTML={{
                __html: hlJSON(`{
  "type": "order.updated",
  "id": "ord_7K9xQp2",
  "previous_status": "in_transit",
  "status": "delivered",
  "delivered_at": "2026-05-20T20:14:14.882Z",
  "carrier": "DHL"
}`),
              }}
            />
          </Floater>

          <Floater
            p={p}
            radius={12}
            style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: `1px solid ${p.line}`,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontSize: 11.5,
              }}
            >
              <span style={{ fontWeight: 600, color: p.text }}>Compose</span>
              {['json', 'text', 'binary'].map((m, i) => (
                <span
                  key={m}
                  style={{
                    color: i === 0 ? p.text : p.textMuted,
                    fontWeight: i === 0 ? 600 : 500,
                    borderBottom: i === 0 ? `2px solid ${p.accent}` : 'none',
                    paddingBottom: 2,
                    cursor: 'pointer',
                  }}
                >
                  {m}
                </span>
              ))}
              <div style={{ flex: 1 }} />
              <span style={{ color: p.textDim }}>↑/↓ history</span>
            </div>
            <pre
              style={{
                margin: 0,
                padding: '12px 14px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                lineHeight: 1.55,
                color: p.text,
                background: p.code,
                borderBottom: `1px solid ${p.line}`,
                minHeight: 90,
              }}
              dangerouslySetInnerHTML={{
                __html: hlJSON(`{
  "type": "subscribe",
  "channel": "orders",
  "filter": { "user_id": 42 }
}`),
              }}
            />
            <div
              style={{
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <button
                style={{
                  padding: '7px 16px',
                  borderRadius: 8,
                  border: 0,
                  background: `linear-gradient(180deg, ${p.accent}, #3a85ee)`,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  boxShadow: `0 4px 12px ${p.accent}55`,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <SIcon.send size={12} /> Send <Kbd p={p}>⌘↵</Kbd>
              </button>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: p.textMuted }}>76 bytes · JSON valid</span>
            </div>
          </Floater>
        </div>
      </div>
    </React.Fragment>
  );
}

// ─── SSE ──────────────────────────────────────────────────────────────
function SSEView({ p }) {
  const events = [
    { evt: 'message', id: '1', data: '{"type":"hello"}', ts: '0.014s' },
    { evt: 'progress', id: '2', data: '{"step":1,"total":5,"label":"Indexing"}', ts: '0.220s' },
    { evt: 'progress', id: '3', data: '{"step":2,"total":5,"label":"Analyzing"}', ts: '0.510s' },
    { evt: 'token', id: '4', data: '"Restura"', ts: '1.108s' },
    { evt: 'token', id: '5', data: '" delivers"', ts: '1.142s' },
    { evt: 'token', id: '6', data: '" REST"', ts: '1.188s' },
    { evt: 'token', id: '7', data: '","', ts: '1.224s' },
    { evt: 'token', id: '8', data: '" GraphQL"', ts: '1.291s' },
    { evt: 'progress', id: '9', data: '{"step":5,"total":5,"label":"Done"}', ts: '2.804s' },
    { evt: 'done', id: '10', data: '{"ok":true,"latency_ms":2804}', ts: '2.806s' },
  ];
  const EVT_COL = { message: '#9ca3af', progress: '#f59e0b', token: '#06b6d4', done: '#22c55e' };
  return (
    <React.Fragment>
      <UrlBar
        p={p}
        method="SSE"
        methodColor={METHOD_COL.SSE}
        url="https://api.restura.dev/v2/stream/answers"
        sendLabel="Stream"
      />

      <Floater
        p={p}
        radius={12}
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 22,
        }}
      >
        <Stat label="STREAMING" value="● live" p={p} accent="#22c55e" />
        <Stat label="EVENTS" value="10" p={p} />
        <Stat label="LAST-EVENT-ID" value="9" p={p} />
        <Stat label="AVG GAP" value="280 ms" p={p} />
        <Stat label="RECONNECT" value="auto" p={p} />
        <div style={{ flex: 1 }} />
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            border: `1px solid #ef4444aa`,
            background: 'transparent',
            color: '#ef4444',
            fontSize: 11.5,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Stop
        </button>
      </Floater>

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr',
          gap: 10,
          minHeight: 0,
        }}
      >
        {/* timeline */}
        <Floater
          p={p}
          radius={14}
          large
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${p.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Events</span>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: p.textMuted }}>
              {Object.entries(EVT_COL).map(([k, c]) => (
                <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />
                  {k}
                </span>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', position: 'relative', padding: '12px 0' }}>
            <div
              style={{
                position: 'absolute',
                left: 96,
                top: 0,
                bottom: 0,
                width: 1,
                background: p.line,
              }}
            />
            {events.map((e, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px 18px 1fr',
                  padding: '6px 14px 6px 0',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: p.textMuted,
                    textAlign: 'right',
                    paddingRight: 14,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {e.ts}
                </span>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: EVT_COL[e.evt],
                      boxShadow: `0 0 0 2px ${p.surface}, 0 0 8px ${EVT_COL[e.evt]}88`,
                    }}
                  />
                </div>
                <div style={{ paddingLeft: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 4,
                      letterSpacing: 0.4,
                      background: `${EVT_COL[e.evt]}29`,
                      color: EVT_COL[e.evt],
                    }}
                  >
                    {e.evt}
                  </span>
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10.5,
                      color: p.textDim,
                    }}
                  >
                    id={e.id}
                  </span>
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11.5,
                      color: p.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.data}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Floater>

        {/* assembled output + counters */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <Floater p={p} radius={12} style={{ padding: 14, flex: 1, overflow: 'auto' }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: p.textDim,
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              Assembled output
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.7, color: p.text }}>
              <span>Restura delivers REST, GraphQL</span>
              <span
                style={{
                  background: `${p.accent}33`,
                  borderRight: `2px solid ${p.accent}`,
                  animation: 'blink 1s infinite',
                }}
              >
                &nbsp;
              </span>
            </div>
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: p.textDim,
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Progress · 5 / 5
              </div>
              <div
                style={{ height: 6, borderRadius: 3, background: p.surfaceLo, overflow: 'hidden' }}
              >
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    background: `linear-gradient(90deg, ${p.accent}, #a78bfa)`,
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: p.textMuted,
                  marginTop: 6,
                  fontFamily: '"JetBrains Mono", monospace',
                }}
              >
                Indexing → Analyzing → Generating → Refining → Done
              </div>
            </div>
          </Floater>

          <Floater p={p} radius={12} style={{ padding: 14 }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: p.textDim,
                textTransform: 'uppercase',
                marginBottom: 10,
              }}
            >
              Counters
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {[
                ['Events', '10'],
                ['Bytes', '624'],
                ['Tokens', '5'],
                ['Reconnects', '0'],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: p.surfaceLo,
                    border: `1px solid ${p.line}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: p.textDim,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                    }}
                  >
                    {k}
                  </div>
                  <div
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 17,
                      fontWeight: 700,
                      color: p.text,
                    }}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </Floater>
        </div>
      </div>
    </React.Fragment>
  );
}

// ─── MCP ──────────────────────────────────────────────────────────────
function MCPView({ p }) {
  const tools = [
    {
      name: 'create_issue',
      desc: 'Open a new issue in a GitHub repository',
      args: 5,
      selected: true,
    },
    { name: 'list_issues', desc: 'List open issues for a repository', args: 3 },
    { name: 'add_comment', desc: 'Post a comment to an issue or PR', args: 3 },
    { name: 'merge_pr', desc: 'Merge a pull request when checks pass', args: 4 },
    { name: 'search_code', desc: 'Search code across a repository', args: 2 },
    { name: 'get_workflow_run', desc: 'Fetch a CI workflow run by id', args: 2 },
  ];
  return (
    <React.Fragment>
      <Floater
        p={p}
        radius={12}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 5,
          gap: 6,
        }}
      >
        <div
          style={{
            padding: '7px 14px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            fontWeight: 700,
            color: '#f59e0b',
            background: 'rgba(245,158,11,0.16)',
            borderRadius: 8,
          }}
        >
          MCP
        </div>
        <div
          style={{
            flex: 1,
            padding: '0 12px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            color: p.text,
          }}
        >
          https://mcp.restura.dev/v1/gh
        </div>
        <div
          style={{
            padding: '5px 10px',
            borderRadius: 7,
            background: p.surfaceLo,
            border: `1px solid ${p.line}`,
            fontSize: 11.5,
            color: p.textMuted,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Streamable HTTP <SIcon.chevron size={10} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 7,
            background: 'rgba(34,197,94,0.16)',
            boxShadow: '0 0 0 1px rgba(34,197,94,0.25)',
            marginLeft: 4,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              fontWeight: 700,
              color: '#22c55e',
            }}
          >
            CONNECTED
          </span>
        </div>
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            border: `1px solid ${p.lineStrong}`,
            background: 'transparent',
            color: p.text,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          Reconnect
        </button>
      </Floater>

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '300px 1fr 1fr',
          gap: 10,
          minHeight: 0,
        }}
      >
        {/* tools list */}
        <Floater
          p={p}
          radius={14}
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          <SubTabBar
            p={p}
            active="Tools"
            items={[
              { id: 'Tools', name: 'Tools', count: 6 },
              { id: 'Resources', name: 'Resources', count: 3 },
              { id: 'Prompts', name: 'Prompts', count: 2 },
              { id: 'Log', name: 'Log', count: 14 },
            ]}
          />
          <div
            style={{
              padding: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              overflow: 'auto',
              flex: 1,
            }}
          >
            {tools.map((t) => (
              <div
                key={t.name}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: t.selected ? p.activeBg : 'transparent',
                  border: t.selected ? `1px solid ${p.accent}55` : `1px solid transparent`,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <SIcon.sparkle size={12} style={{ color: t.selected ? p.accent : '#f59e0b' }} />
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: t.selected ? p.accent : p.text,
                    }}
                  >
                    {t.name}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 10,
                      color: p.textDim,
                      fontFamily: '"JetBrains Mono", monospace',
                    }}
                  >
                    {t.args} args
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: p.textMuted, marginTop: 3, marginLeft: 20 }}>
                  {t.desc}
                </div>
              </div>
            ))}
          </div>
        </Floater>

        {/* invoke form */}
        <Floater
          p={p}
          radius={14}
          large
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          <div
            style={{
              padding: '11px 14px',
              borderBottom: `1px solid ${p.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 13.5,
                fontWeight: 700,
                color: p.accent,
              }}
            >
              create_issue
            </span>
            <span style={{ fontSize: 11, color: p.textMuted }}>· arguments</span>
            <div style={{ flex: 1 }} />
            <button
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: 0,
                background: `linear-gradient(180deg, ${p.accent}, #3a85ee)`,
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                boxShadow: `0 4px 12px ${p.accent}55`,
              }}
            >
              <SIcon.play size={11} /> Invoke
            </button>
          </div>
          <div
            style={{
              flex: 1,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              overflow: 'auto',
            }}
          >
            {[
              { name: 'repo', type: 'string', value: 'restura/api', req: true },
              {
                name: 'title',
                type: 'string',
                value: 'Bug: timeout on large body uploads',
                req: true,
              },
              {
                name: 'body',
                type: 'string',
                value: 'When body exceeds 10MB the request times out at 30s.',
                multi: true,
              },
              { name: 'labels', type: 'string[]', value: '["bug", "performance"]' },
              { name: 'assignee', type: 'string', value: '' },
            ].map((f) => (
              <div key={f.name}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 12,
                      fontWeight: 600,
                      color: p.text,
                    }}
                  >
                    {f.name}
                  </span>
                  <span
                    style={{
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10.5,
                      color: p.textDim,
                    }}
                  >
                    {f.type}
                  </span>
                  {f.req && (
                    <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 600 }}>
                      required
                    </span>
                  )}
                </div>
                <div
                  style={{
                    padding: f.multi ? '10px 12px' : '8px 10px',
                    borderRadius: 7,
                    background: p.surfaceLo,
                    border: `1px solid ${p.line}`,
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 12,
                    color: f.value ? p.text : p.textDim,
                    minHeight: f.multi ? 60 : 'auto',
                  }}
                >
                  {f.value || `<empty>`}
                </div>
              </div>
            ))}
          </div>
        </Floater>

        {/* result */}
        <Floater
          p={p}
          radius={14}
          large
          style={{
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: p.code,
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: '11px 14px',
              borderBottom: `1px solid ${p.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: p.text }}>Result</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 8px',
                borderRadius: 6,
                background: 'rgba(34,197,94,0.16)',
                color: '#22c55e',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e' }} />
              isError: false
            </span>
            <div style={{ flex: 1 }} />
            <Stat label="time" value="312 ms" p={p} />
            <Stat label="size" value="1.8 KB" p={p} />
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: '12px 14px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              lineHeight: 1.55,
              color: p.text,
              overflow: 'auto',
            }}
            dangerouslySetInnerHTML={{
              __html: hlJSON(`{
  "content": [
    {
      "type": "text",
      "text": "Issue #284 created in restura/api"
    }
  ],
  "structured": {
    "issue": {
      "id": 284,
      "number": 284,
      "url": "https://github.com/restura/api/issues/284",
      "state": "open",
      "labels": ["bug", "performance"],
      "created_at": "2026-05-20T20:14:08Z",
      "author": "restura-bot"
    }
  },
  "isError": false
}`),
            }}
          />
        </Floater>
      </div>
    </React.Fragment>
  );
}

// ─── Kafka ────────────────────────────────────────────────────────────
function KafkaView({ p }) {
  const messages = [
    {
      p: 0,
      off: '8421',
      ts: '20:14:08.412',
      key: 'ord_7K9xQp2',
      val: '{"type":"order.delivered","amount":248.50}',
    },
    {
      p: 1,
      off: '5108',
      ts: '20:14:11.226',
      key: 'ord_3Bm1Rfa',
      val: '{"type":"order.created","amount":89.00}',
    },
    {
      p: 0,
      off: '8422',
      ts: '20:14:14.882',
      key: 'ord_7K9xQp2',
      val: '{"type":"order.updated","status":"delivered"}',
      sel: true,
    },
    {
      p: 2,
      off: '2284',
      ts: '20:14:19.504',
      key: 'ord_9Yp4Lzc',
      val: '{"type":"order.created","amount":42.10}',
    },
    {
      p: 1,
      off: '5109',
      ts: '20:14:23.118',
      key: 'ord_3Bm1Rfa',
      val: '{"type":"order.updated","status":"in_transit"}',
    },
    {
      p: 0,
      off: '8423',
      ts: '20:14:27.880',
      key: 'ord_4Mp2Qxy',
      val: '{"type":"order.created","amount":312.00}',
    },
    {
      p: 2,
      off: '2285',
      ts: '20:14:31.022',
      key: 'ord_9Yp4Lzc',
      val: '{"type":"payment.captured","amount":42.10}',
    },
  ];
  const PART_COL = ['#4d9fff', '#22c55e', '#f59e0b'];
  return (
    <React.Fragment>
      <Floater
        p={p}
        radius={12}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 5,
          gap: 6,
        }}
      >
        <div
          style={{
            padding: '7px 14px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            fontWeight: 700,
            color: '#f472b6',
            background: 'rgba(244,114,182,0.18)',
            borderRadius: 8,
          }}
        >
          Kafka
        </div>
        <div
          style={{
            flex: 1,
            padding: '0 12px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            color: p.text,
          }}
        >
          kafka.restura.dev:9092 <span style={{ color: p.textDim }}>·</span> topic:{' '}
          <span style={{ color: '#f472b6' }}>order-events</span>
        </div>
        <div
          style={{
            padding: '5px 10px',
            borderRadius: 7,
            background: p.surfaceLo,
            border: `1px solid ${p.line}`,
            fontSize: 11.5,
            color: p.textMuted,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Consume <SIcon.chevron size={10} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 7,
            background: 'rgba(34,197,94,0.16)',
            boxShadow: '0 0 0 1px rgba(34,197,94,0.25)',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              fontWeight: 700,
              color: '#22c55e',
            }}
          >
            SUBSCRIBED
          </span>
        </div>
        <button
          style={{
            padding: '7px 14px',
            borderRadius: 8,
            border: `1px solid ${p.lineStrong}`,
            background: 'transparent',
            color: p.text,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          Pause
        </button>
      </Floater>

      <Floater
        p={p}
        radius={12}
        style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 22 }}
      >
        <Stat label="PARTITIONS" value="3" p={p} />
        <Stat label="CONSUMER ID" value="restura-cli-7f3" p={p} />
        <Stat label="LAG" value="0" p={p} accent="#22c55e" />
        <Stat label="OFFSET RESET" value="latest" p={p} />
        <Stat label="MSG/SEC" value="14.2" p={p} />
        <div style={{ flex: 1 }} />
        {/* per-partition pills */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                padding: '3px 8px',
                borderRadius: 6,
                background: `${PART_COL[i]}1f`,
                color: PART_COL[i],
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 10.5,
                fontWeight: 700,
              }}
            >
              P{i} · {[8423, 5109, 2285][i]}
            </div>
          ))}
        </div>
      </Floater>

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1.6fr 1fr',
          gap: 10,
          minHeight: 0,
        }}
      >
        {/* message log */}
        <Floater
          p={p}
          radius={14}
          large
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 80px 110px 130px 1fr',
              padding: '8px 14px',
              borderBottom: `1px solid ${p.line}`,
              gap: 12,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: p.textDim,
              textTransform: 'uppercase',
              background: p.surfaceLo,
            }}
          >
            <span>PART</span>
            <span>OFFSET</span>
            <span>TIME</span>
            <span>KEY</span>
            <span>VALUE</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 80px 110px 130px 1fr',
                  padding: '7px 14px',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: 11.5,
                  borderBottom: `1px solid ${p.line}`,
                  background: m.sel ? p.activeBg : 'transparent',
                  borderLeft: m.sel ? `2px solid ${p.accent}` : `2px solid transparent`,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 4,
                    color: PART_COL[m.p],
                    background: `${PART_COL[m.p]}22`,
                    display: 'inline-block',
                    width: 'fit-content',
                  }}
                >
                  P{m.p}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: p.textMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {m.off}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: p.textDim,
                  }}
                >
                  {m.ts}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11,
                    color: p.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.key}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 11.5,
                    color: p.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  dangerouslySetInnerHTML={{ __html: hlJSON(m.val) }}
                />
              </div>
            ))}
          </div>
        </Floater>

        {/* detail */}
        <Floater
          p={p}
          radius={14}
          large
          style={{
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: p.code,
          }}
        >
          <div
            style={{
              padding: '11px 14px',
              borderBottom: `1px solid ${p.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: p.text }}>
              Message · P0 / 8422
            </span>
            <div style={{ flex: 1 }} />
            <SIcon.copy size={13} style={{ opacity: 0.55, cursor: 'pointer' }} />
          </div>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${p.line}` }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: p.textDim,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Headers
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '4px 14px',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11.5,
              }}
            >
              <span style={{ color: p.textMuted }}>content-type</span>{' '}
              <span style={{ color: p.text }}>application/json</span>
              <span style={{ color: p.textMuted }}>schema-id</span>{' '}
              <span style={{ color: p.text }}>42</span>
              <span style={{ color: p.textMuted }}>trace-id</span>{' '}
              <span style={{ color: p.text }}>tr_4f3a91c8</span>
            </div>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: '12px 14px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              lineHeight: 1.55,
              color: p.text,
              overflow: 'auto',
            }}
            dangerouslySetInnerHTML={{
              __html: hlJSON(`{
  "type": "order.updated",
  "id": "ord_7K9xQp2",
  "previous_status": "in_transit",
  "status": "delivered",
  "delivered_at": "2026-05-20T20:14:14.882Z",
  "carrier": "DHL",
  "amount": 248.50,
  "currency": "USD"
}`),
            }}
          />
        </Floater>
      </div>
    </React.Fragment>
  );
}

Object.assign(window, { WebSocketView, SSEView, MCPView, KafkaView });
