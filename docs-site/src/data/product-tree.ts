/** Public editorial roadmap. Verify availability against capabilities.ts and source
 * before changing a status; planned/exploring entries carry no delivery dates. */
export const reviewedOn = '2026-10-08';
export const statuses = {
  shipped: 'Shipped',
  'in-progress': 'In progress',
  planned: 'Planned',
  exploring: 'Exploring',
} as const;
export const branches = [
  {
    id: 'protocols',
    label: 'Protocols',
    description: 'Speak the language of your stack.',
    symbol: '↔',
  },
  {
    id: 'security',
    label: 'Auth & Security',
    description: 'Your requests. Your credentials.',
    symbol: '◇',
  },
  {
    id: 'collections',
    label: 'Collections',
    description: 'Bring your work together.',
    symbol: '⊞',
  },
  {
    id: 'automation',
    label: 'Automation & Testing',
    description: 'From one request to repeatable runs.',
    symbol: '▷',
  },
  { id: 'ai', label: 'AI & Agents', description: 'Understand, experiment, evaluate.', symbol: '✳' },
  {
    id: 'platforms',
    label: 'Platforms & Integrations',
    description: 'Work wherever your code lives.',
    symbol: '⌘',
  },
] as const;
export type BranchId = (typeof branches)[number]['id'];
export type Status = keyof typeof statuses;
export type Platform =
  | 'Web'
  | 'Desktop'
  | 'Self-hosted'
  | 'CLI'
  | 'VS Code'
  | 'Chrome'
  | 'JetBrains';
export interface Milestone {
  title: string;
  done: boolean;
}
/** Delivery detail for unshipped work. Milestones are checked against the source
 * tree, not estimated, so progress is simply the share that are done. */
export interface Plan {
  /** What already exists in the codebase, in plain language. */
  today: string;
  milestones: readonly Milestone[];
}
export interface Feature {
  id: string;
  branch: BranchId;
  title: string;
  description: string;
  status: Status;
  platforms: readonly Platform[];
  prerequisites: readonly string[];
  href?: string;
  plan?: Plan;
}
const all: Platform[] = ['Web', 'Desktop', 'Self-hosted'];
const desktop: Platform[] = ['Desktop'];
const entry = (
  branch: BranchId,
  id: string,
  title: string,
  description: string,
  status: Status,
  platforms: readonly Platform[],
  href?: string,
  prerequisites: string[] = [],
  plan?: Plan
): Feature => ({
  branch,
  id,
  title,
  description,
  status,
  platforms,
  ...(href ? { href } : {}),
  prerequisites,
  ...(plan ? { plan } : {}),
});
const done = (title: string): Milestone => ({ title, done: true });
const todo = (title: string): Milestone => ({ title, done: false });
export const features: Feature[] = [
  entry(
    'protocols',
    'http',
    'HTTP / REST',
    'Send requests with all methods, body types, cookies, and code generation.',
    'shipped',
    all,
    '/protocols/http/'
  ),
  entry(
    'protocols',
    'graphql',
    'GraphQL',
    'Build queries, inspect schemas, and subscribe to live updates.',
    'shipped',
    all,
    '/protocols/graphql/'
  ),
  entry(
    'protocols',
    'grpc',
    'gRPC & reflection',
    'Discover services, send unary calls, and watch server streams. Web server streaming requires upstream CORS support.',
    'shipped',
    all,
    '/protocols/grpc/'
  ),
  entry(
    'protocols',
    'grpc-streaming',
    'Client & bidirectional streams',
    'Send multiple messages and exchange live gRPC streams through the desktop app.',
    'shipped',
    desktop,
    '/protocols/grpc/',
    ['grpc']
  ),
  entry(
    'protocols',
    'websocket',
    'WebSocket',
    'Connect, exchange messages, and inspect a complete conversation.',
    'shipped',
    all,
    '/protocols/websocket/'
  ),
  entry(
    'protocols',
    'socket-io',
    'Socket.IO',
    'Emit events, listen for replies, and inspect acknowledgements.',
    'shipped',
    all,
    '/protocols/socket-io/'
  ),
  entry(
    'protocols',
    'sse',
    'Server-Sent Events',
    'Inspect live event streams with reconnection.',
    'shipped',
    all,
    '/protocols/sse/'
  ),
  entry(
    'protocols',
    'kafka',
    'Kafka',
    'Produce, consume, and manage broker traffic with native desktop networking.',
    'shipped',
    desktop,
    '/protocols/kafka/'
  ),
  entry(
    'protocols',
    'mqtt',
    'MQTT',
    'Publish and subscribe with QoS and TLS on desktop.',
    'shipped',
    desktop,
    '/protocols/mqtt/'
  ),
  entry(
    'protocols',
    'mcp',
    'MCP client',
    'Connect to MCP servers and inspect their tools, resources, and messages.',
    'shipped',
    all,
    '/protocols/mcp/'
  ),
  entry(
    'protocols',
    'websocket-web-headers',
    'WebSocket headers on web',
    'Send custom handshake headers from the browser by relaying connections through the Restura server.',
    'planned',
    ['Web', 'Self-hosted'],
    '/protocols/websocket/',
    ['websocket'],
    {
      today:
        'The server-side ticket and relay routes exist behind the SSRF gate, but the web app still connects directly, so custom headers are dropped with a warning.',
      milestones: [
        done('Ticketed relay routes on the Worker and self-hosted server'),
        todo('Web app connects through the relay when headers are set'),
        todo('Header policy and end-to-end tests'),
      ],
    }
  ),
  entry(
    'security',
    'auth',
    'Request authentication',
    'Basic, Bearer, API key, OAuth 2.0, OAuth 1.0, AWS SigV4, and WSSE. Body-dependent signatures are applied at send time.',
    'shipped',
    all,
    '/guides/auth/'
  ),
  entry(
    'security',
    'local-storage',
    'Local-first storage',
    'Keep collections and history in IndexedDB on web and encrypted storage on desktop.',
    'shipped',
    all,
    '/architecture/security/'
  ),
  entry(
    'security',
    'secret-handles',
    'Desktop secret handles',
    'Keep migrated credential fields opaque to the renderer; resolve them only when sending from desktop.',
    'shipped',
    desktop,
    '/architecture/adrs/0007-secret-ref-pattern/'
  ),
  entry(
    'security',
    'native-tls',
    'mTLS & native networking',
    'Use client certificates, custom CAs, and SOCKS through desktop networking.',
    'shipped',
    desktop,
    '/reference/capability-matrix/'
  ),
  entry(
    'security',
    'digest-ntlm',
    'Digest & NTLM execution',
    'Complete challenge/response authentication on send. Saving a configuration does not yet perform the handshake; NTLM is expected to be desktop-only.',
    'planned',
    all,
    '/guides/auth/',
    [],
    {
      today:
        'Digest and NTLM settings are saved and validated, and the app warns that they are not applied. No backend performs the challenge/response handshake yet.',
      milestones: [
        done('Settings editors and validated configuration'),
        done('In-app notice that these schemes are not yet applied'),
        todo('Digest challenge/response in the shared protocol core'),
        todo('Retry-on-401 in the desktop and web proxies'),
        todo('NTLM handshake over a kept-alive desktop connection'),
      ],
    }
  ),
  entry(
    'security',
    'audit-logging',
    'Self-hosted audit logging',
    'Explore an operational audit trail for self-hosted deployments.',
    'exploring',
    ['Self-hosted'],
    undefined,
    [],
    {
      today:
        'Nothing yet. The self-hosted Node server and its middleware are the natural place to start.',
      milestones: [
        todo('Decide which events matter and how long to keep them'),
        todo('Structured audit events from the self-hosted server'),
        todo('Export to an operator-owned log sink'),
      ],
    }
  ),
  entry(
    'security',
    'web-passphrase',
    'Passphrase-protected web storage',
    'Encrypt the web app\u2019s local data with a passphrase only you know.',
    'planned',
    ['Web', 'Self-hosted'],
    '/architecture/security/',
    ['local-storage'],
    {
      today:
        'A passphrase key provider is implemented and documented as planned; there is no Settings screen to set or unlock it yet.',
      milestones: [
        done('Passphrase key provider in the storage layer'),
        todo('Settings \u2192 Security passphrase setup and unlock prompt'),
        todo('Re-encrypt existing browser data, with a recovery warning'),
        todo('Security regression tests'),
      ],
    }
  ),
  entry(
    'security',
    'secret-handle-management',
    'Secret handle management',
    'Bring the remaining credential fields onto desktop secret handles and manage them in one place.',
    'in-progress',
    desktop,
    '/architecture/adrs/0007-secret-ref-pattern/',
    ['secret-handles'],
    {
      today:
        'The handle store and send-time resolution are in place, and fields migrate one at a time. Importers do not yet offer conversion, and there is no list of stored handles.',
      milestones: [
        done('Handle store resolved only at send time'),
        todo('Offer to convert imported secrets into handles'),
        todo('Settings panel listing and deleting handles'),
        todo('Migrate the remaining credential fields'),
      ],
    }
  ),
  entry(
    'security',
    'pac-proxy',
    'PAC proxy scripts',
    'Route desktop traffic using your organisation\u2019s proxy auto-config script.',
    'planned',
    desktop,
    '/reference/capability-matrix/',
    ['native-tls'],
    {
      today:
        'Desktop networking has handler scaffolding, but proxy settings cannot choose PAC and the script is never loaded, so it is marked unsupported.',
      milestones: [
        done('Handler scaffolding in desktop networking'),
        todo('PAC option in proxy settings'),
        todo('Load the script through the desktop session proxy'),
        todo('PAC evaluation tests'),
      ],
    }
  ),
  entry(
    'collections',
    'collections',
    'Collections & folders',
    'Organize requests with folder hierarchy and inherited authentication.',
    'shipped',
    all,
    '/guides/collections/'
  ),
  entry(
    'collections',
    'environments',
    'Environments & variables',
    'Switch request context with scoped variables and reusable environments.',
    'shipped',
    all,
    '/guides/environments/'
  ),
  entry(
    'collections',
    'import-export',
    'Import & export',
    'Bring collections from Postman, Insomnia, Bruno, and other tools; share portable files.',
    'shipped',
    all,
    '/guides/import-export/'
  ),
  entry(
    'collections',
    'har-import',
    'HAR import',
    'Review browser traffic from a HAR file before importing requests.',
    'shipped',
    all,
    '/guides/import-export/',
    ['import-export']
  ),
  entry(
    'collections',
    'openapi-export',
    'OpenAPI export',
    'Export collections as an OpenAPI 3.0 specification.',
    'shipped',
    all,
    '/guides/import-export/',
    ['collections']
  ),
  entry(
    'collections',
    'git-collections',
    'Git-native OpenCollection',
    'Store collections as reviewable YAML files and work with Git on desktop.',
    'shipped',
    desktop,
    '/reference/opencollection/',
    ['collections']
  ),
  entry(
    'collections',
    'environment-export',
    'Standalone environment export',
    'Export an environment independently of a collection.',
    'planned',
    all,
    '/guides/environments/',
    [],
    {
      today:
        'Environments travel inside OpenCollection collection exports, and Postman environment files can be imported. There is no way to export one environment on its own.',
      milestones: [
        done('Environments included in collection exports'),
        done('Postman environment import'),
        todo('Export a single environment as Restura or Postman JSON'),
        todo('Choose whether secret values are included'),
        todo('Round-trip test against the importer'),
      ],
    }
  ),
  entry(
    'automation',
    'scripts',
    'Sandboxed scripts',
    'Run pre-request scripts and assertions in a bounded QuickJS sandbox with Postman compatibility.',
    'shipped',
    all,
    '/guides/scripts/'
  ),
  entry(
    'automation',
    'workflows',
    'Request workflows',
    'Chain saved requests with typed bindings, bounded control flow, timeouts, and cancellation through the normal request executor.',
    'shipped',
    all,
    '/guides/workflows/',
    ['http', 'collections']
  ),
  entry(
    'automation',
    'cli',
    'CLI collection runner',
    'Run portable collections in CI and publish JUnit, HTML, or JSON reports.',
    'shipped',
    ['CLI'],
    '/reference/cli/',
    ['collections']
  ),
  entry(
    'automation',
    'load-testing',
    'Load testing',
    'Run collections with configurable concurrency and duration.',
    'shipped',
    all,
    '/guides/load-testing/',
    ['collections']
  ),
  entry(
    'automation',
    'contracts',
    'Contract testing',
    'Attach an OpenAPI spec to a collection to generate mock routes today; validating live responses against it is being wired in.',
    'in-progress',
    all,
    '/guides/collections/',
    ['http'],
    {
      today:
        'Collections load and check an OpenAPI spec and turn it into mock-server routes. A tested response validator exists but nothing calls it yet, and the collection settings say so.',
      milestones: [
        done('Attach and validate an OpenAPI spec per collection'),
        done('Generate mock-server routes from the spec'),
        done('Response validator library with tests'),
        todo('Validate responses on send and show violations in the response panel'),
        todo('Report contract results in collection runs and CLI reports'),
      ],
    }
  ),
  entry(
    'automation',
    'mock-server',
    'Local mock server',
    'Stub responses on desktop when the real upstream is unavailable.',
    'shipped',
    desktop,
    '/guides/mock-server/'
  ),
  entry(
    'automation',
    'websocket-scripts',
    'WebSocket message scripts',
    'Extend scripting to incoming WebSocket messages.',
    'planned',
    all,
    '/protocols/websocket/',
    ['websocket', 'scripts'],
    {
      today:
        'The bounded QuickJS sandbox that runs HTTP scripts is shared and ready; the WebSocket client has no script hook yet.',
      milestones: [
        done('Bounded script sandbox shared across protocols'),
        todo('On-message script saved with WebSocket requests'),
        todo('Run per incoming frame with time and rate limits'),
        todo('rs.message and rs.ws.send scripting APIs'),
        todo('Script output and errors in the message log'),
      ],
    }
  ),
  entry(
    'automation',
    'scheduled-runs',
    'Scheduled test runs',
    'Explore running tests on a schedule rather than starting each run manually.',
    'exploring',
    ['Desktop', 'Self-hosted', 'CLI'],
    undefined,
    ['cli'],
    {
      today:
        'The CLI already produces JUnit, HTML, and JSON reports, so CI schedulers can run collections today.',
      milestones: [
        todo('Documented GitHub Actions and cron recipes'),
        todo('Decide whether an in-app scheduler is worth it'),
        todo('Run history and failure notifications'),
      ],
    }
  ),
  entry(
    'automation',
    'cli-parity',
    'CLI protocol parity',
    'Run more of what the app can send from CI: WebSocket requests, per-domain client certificates, and protobuf bodies.',
    'planned',
    ['CLI'],
    '/reference/cli/',
    ['cli'],
    {
      today:
        'A standalone WebSocket executor already exists in the CLI but nothing routes to it; per-domain certificates and protobuf bodies are documented as not yet supported.',
      milestones: [
        done('Standalone WebSocket executor'),
        todo('Run WebSocket requests in collection runs'),
        todo('Honour per-domain client certificates'),
        todo('Protobuf request bodies'),
      ],
    }
  ),
  entry(
    'ai',
    'ai-assistant',
    'Request-aware assistant',
    'Chat about the current request and response with supported AI providers. Request context is redacted before reaching a model.',
    'shipped',
    desktop,
    '/guides/ai-assistant/'
  ),
  entry(
    'ai',
    'ai-lab',
    'AI Lab',
    'Compare prompts and models, curate datasets, and run evaluations and Arena judging.',
    'shipped',
    desktop,
    '/guides/ai-lab/'
  ),
  entry(
    'ai',
    'agent-suites',
    'Agent evaluation suites',
    'Evaluate bounded multi-step agents with budgets, typed traces, and reliability reports. Tool and provider support varies by runtime.',
    'shipped',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/'
  ),
  entry(
    'ai',
    'mcp-server',
    'Restura as an MCP server',
    'Expose collections to agents through the desktop MCP server with execution approval.',
    'shipped',
    desktop,
    '/guides/mcp-server-mode/',
    ['collections']
  ),
  entry(
    'ai',
    'ai-web',
    'AI assistant on web',
    'Bring request-aware assistance to the browser with careful API-key handling.',
    'planned',
    ['Web', 'Self-hosted'],
    '/guides/ai-assistant/',
    ['ai-assistant'],
    {
      today:
        'Provider streaming, decoding, and redaction live in the backend-agnostic protocol core, and the chat panel exists. Only the desktop app has a transport for it.',
      milestones: [
        done('Provider decoders and redaction in the shared core'),
        done('Request-aware chat panel'),
        todo('Decide how browser users supply and protect API keys'),
        todo('Streaming /api/ai route with SSRF and rate limits'),
        todo('Web transport alongside the desktop bridge'),
      ],
    }
  ),
  entry(
    'ai',
    'natural-language',
    'Natural-language requests',
    'Explore turning a plain-language description into a request.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'The desktop assistant and AI Lab already generate requests from OpenAPI, which this would build on.',
      milestones: [
        todo('Prototype prompt-to-request with the desktop assistant'),
        todo('Review-before-send flow that never executes silently'),
        todo('Evaluate quality with AI Lab datasets'),
      ],
    }
  ),
  entry(
    'ai',
    'agent-providers',
    'More agent model providers',
    'Run agent suites against Gemini, Azure OpenAI, and Amazon Bedrock.',
    'planned',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/',
    ['agent-suites'],
    {
      today: 'Adapter profiles describe all three providers, but none has a shipped transport yet.',
      milestones: [
        done('Adapter profiles for Gemini, Azure OpenAI, and Bedrock'),
        todo('Gemini transport on desktop'),
        todo('Azure OpenAI transport'),
        todo('Bedrock with request signing'),
        todo('CLI parity'),
      ],
    }
  ),
  entry(
    'ai',
    'agent-sandboxes',
    'Agent code sandboxes',
    'Explore letting evaluated agents run code in an isolated sandbox.',
    'exploring',
    desktop,
    '/guides/ai-lab/',
    ['agent-suites'],
    {
      today:
        'The sandbox provider contract and registry are implemented; no provider ships, and the CLI refuses sandbox sources.',
      milestones: [
        done('Sandbox provider contract and registry'),
        todo('Threat model and design record'),
        todo('One local container provider on desktop'),
        todo('Approval and cancellation wiring'),
      ],
    }
  ),
  entry(
    'platforms',
    'web-app',
    'Web app',
    'Open Restura in your browser without creating an account.',
    'shipped',
    ['Web'],
    '/overview/platforms/'
  ),
  entry(
    'platforms',
    'desktop-app',
    'Desktop app',
    'Run on macOS, Windows, and Linux with native protocol and networking capabilities.',
    'shipped',
    desktop,
    '/overview/install/'
  ),
  entry(
    'platforms',
    'self-hosting',
    'Self-hosted Docker',
    'Serve the app and its API from one Node process on your infrastructure.',
    'shipped',
    ['Self-hosted'],
    '/self-hosting/docker/'
  ),
  entry(
    'platforms',
    'vscode',
    'VS Code extension',
    'Edit OpenCollection files, send requests, and use the CLI-backed Test Explorer.',
    'shipped',
    ['VS Code'],
    '/guides/vscode-extension/',
    ['cli']
  ),
  entry(
    'platforms',
    'browser-capture',
    'Browser capture',
    'Capture browser traffic with the Chrome extension, redact credentials, and export or send it to desktop.',
    'shipped',
    ['Chrome'],
    '/guides/browser-capture/'
  ),
  entry(
    'platforms',
    'accessibility',
    'Accessibility improvements',
    'Improve keyboard and screen-reader workflows, particularly the workflow builder and response viewer.',
    'in-progress',
    all,
    undefined,
    [],
    {
      today:
        'The October UX overhaul shipped a type-scale ratchet, labelled console controls, and announced responses. Automated checks and keyboard use of the workflow canvas are still missing.',
      milestones: [
        done('Type scale and contrast pass (#789)'),
        done('Labelled console buttons and announced responses (#764)'),
        todo('Automated axe checks for the workflow builder and response viewer'),
        todo('Keyboard-operable workflow canvas'),
        todo('Live regions for streaming responses'),
      ],
    }
  ),
  entry(
    'platforms',
    'test-coverage',
    'Protocol & IPC coverage',
    'Strengthen meaningful regression coverage at protocol and desktop IPC boundaries.',
    'in-progress',
    all,
    '/testing/overview/',
    [],
    {
      today:
        'The shared protocol core enforces coverage floors, a desktop end-to-end suite runs in CI, and a global uncovered-code budget can only shrink.',
      milestones: [
        done('Coverage floors on the shared protocol core'),
        done('Desktop end-to-end suite in CI'),
        done('Global uncovered-code budget that only ratchets down'),
        todo('Per-directory floors for desktop IPC and Worker handlers'),
        todo('Contract tests for IPC channel and validator parity'),
      ],
    }
  ),
  entry(
    'platforms',
    'jetbrains',
    'JetBrains integration',
    'Explore in-editor request execution for JetBrains IDEs.',
    'exploring',
    ['JetBrains'],
    undefined,
    [],
    {
      today:
        'No JetBrains code exists. The VS Code extension and CLI show the shape it could take.',
      milestones: [
        todo('Gauge demand from users'),
        todo('Reuse the CLI as the execution engine'),
        todo('Minimal plugin that runs OpenCollection files'),
      ],
    }
  ),
  entry(
    'platforms',
    'self-host-scale',
    'Self-hosted scale-out',
    'Explore running Restura\u2019s server across several instances: shared rate limits, a Helm chart, and upstream mTLS.',
    'exploring',
    ['Self-hosted'],
    '/self-hosting/docker/',
    ['self-hosting'],
    {
      today:
        'Single-instance self-hosting ships today; these are listed as out of scope for v1 and open to contributions.',
      milestones: [
        todo('Reference Helm chart'),
        todo('Pluggable shared rate-limit store'),
        todo('Optional upstream mTLS'),
      ],
    }
  ),
];

/** Share of verified milestones that are done, 0–1; null when there is no plan. */
export function progress(feature: Feature): number | null {
  const milestones = feature.plan?.milestones ?? [];
  if (!milestones.length) return null;
  return milestones.filter((milestone) => milestone.done).length / milestones.length;
}

/** Notable merged work, newest first. Each entry cites its pull request. */
export interface Highlight {
  date: string;
  title: string;
  pr: number;
  branch: BranchId;
}
export const highlights: readonly Highlight[] = [
  {
    date: '2026-10-03',
    title: 'Workflow canvas undo/redo, full screen, and theming',
    pr: 792,
    branch: 'automation',
  },
  {
    date: '2026-10-03',
    title: 'Opt-in sample collection and drop-anywhere import',
    pr: 793,
    branch: 'collections',
  },
  {
    date: '2026-10-03',
    title: 'Globals editor, scope inspector, and folder variables',
    pr: 791,
    branch: 'collections',
  },
  {
    date: '2026-10-02',
    title: 'Response viewer: timing breakdown, JSON tree, compare, and cancel',
    pr: 785,
    branch: 'protocols',
  },
  {
    date: '2026-10-02',
    title: '“Open as” protocol switch and resizable SSE/WebSocket settings',
    pr: 788,
    branch: 'protocols',
  },
  {
    date: '2026-10-02',
    title: 'Type-scale ratchet and accessibility fixes',
    pr: 789,
    branch: 'platforms',
  },
  {
    date: '2026-10-01',
    title: 'Daily-driver URL bar, variables, navigation, and editors',
    pr: 780,
    branch: 'platforms',
  },
  {
    date: '2026-10-01',
    title: 'Variables resolved inside request bodies',
    pr: 779,
    branch: 'protocols',
  },
  {
    date: '2026-09-30',
    title: 'AI prompt caching, cache-aware cost, and latest models',
    pr: 766,
    branch: 'ai',
  },
  {
    date: '2026-09-30',
    title: 'GraphQL introspection and OAuth 2.0 refresh through the shared executor',
    pr: 772,
    branch: 'protocols',
  },
];

// Layout is editorial grouping, not a claim that adjacent features depend on
// each other. Actual prerequisites are drawn separately when a node is selected.
// Every map coordinate derives from these values; the page and script share them.
export const nodeWidth = 276;
export const nodeHeight = 62;
export const layout = {
  margin: 36,
  columnPitch: 316,
  rootTop: 14,
  rootLinkY: 78,
  headingY: 118,
  rowPitch: 76,
} as const;
/** Branch lines bend under the heading and reach the first card at this offset. */
export const firstRowY = layout.headingY + 93;
export const columnX = (index: number) => layout.margin + index * layout.columnPitch;
export const mapWidth = 2 * layout.margin + (branches.length - 1) * layout.columnPitch + nodeWidth;
export const rootX = mapWidth / 2;
export function featureGrid(feature: Feature): { column: number; row: number } {
  return {
    column: branches.findIndex((branch) => branch.id === feature.branch),
    row: features
      .filter((item) => item.branch === feature.branch)
      .findIndex((item) => item.id === feature.id),
  };
}
export function featurePosition(feature: Feature): { x: number; y: number } {
  const { column, row } = featureGrid(feature);
  return { x: columnX(column), y: firstRowY + row * layout.rowPitch };
}
export const mapHeight =
  firstRowY +
  Math.max(
    ...branches.map((branch) => features.filter((feature) => feature.branch === branch.id).length)
  ) *
    layout.rowPitch;

export function rootLinkPath(column: number): string {
  const x = columnX(column) + nodeWidth / 2;
  const { rootLinkY: start, headingY: end } = layout;
  const span = end - start;
  return `M${rootX} ${start} C${rootX} ${start + span * 0.6} ${x} ${start + span * 0.35} ${x} ${end}`;
}
export function branchLinePath(column: number, bottom: number): string {
  const x = columnX(column);
  const middle = x + nodeWidth / 2;
  const bend = layout.headingY + 81;
  return `M${middle} ${layout.headingY + 67} Q${middle} ${bend} ${middle - 16} ${bend} H${x + 4} Q${x - 12} ${bend} ${x - 12} ${bend + 16} V${bottom}`;
}
export const twigPath = (x: number, y: number) => `M${x - 12} ${y + nodeHeight / 2} H${x}`;

/** Show the whole map when that costs little scale; otherwise fit the width (wide
 * screens have more width than height to give) and let at most half a viewport of
 * height overflow for panning. 88px keeps the top margin and floating controls clear. */
export function fitScale(viewportWidth: number, viewportHeight: number): number {
  const width = (viewportWidth - 52) / mapWidth;
  // Phones can't show six columns legibly: frame one readable column instead,
  // with the next one peeking in to invite a horizontal pan.
  if (viewportWidth < 640)
    return Math.min(1, (viewportWidth - 24) / (layout.columnPitch + layout.margin));
  const height = (viewportHeight - 88) / mapHeight;
  const scale =
    height >= width * 0.75
      ? Math.min(width, height)
      : Math.min(width, (viewportHeight * 1.5) / mapHeight);
  return Math.max(0.1, Math.min(1, scale));
}

/** Prefix matching on words supports typing without matching HAR in "share".
 * Prefer name matches over descriptions; retain editorial order for ties. */
export function findFeatures(
  query: string,
  status: Status | 'all' = 'all',
  branch: BranchId | 'all' = 'all'
): Feature[] {
  const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words(query);
  return features
    .filter(
      (feature) =>
        (status === 'all' || feature.status === status) &&
        (branch === 'all' || feature.branch === branch)
    )
    .map((feature) => {
      const titleWords = words(feature.title);
      const allWords = [...titleWords, ...words(feature.description)];
      const matches = terms.every((term) => allWords.some((word) => word.startsWith(term)));
      const nameMatches = terms.filter((term) =>
        titleWords.some((word) => word.startsWith(term))
      ).length;
      return { feature, matches, score: nameMatches };
    })
    .filter((item) => item.matches)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.feature);
}
