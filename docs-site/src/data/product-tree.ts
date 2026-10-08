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
export type Platform = 'Web' | 'Desktop' | 'Self-hosted' | 'CLI' | 'VS Code' | 'Chrome';
export interface Feature {
  id: string;
  branch: BranchId;
  title: string;
  description: string;
  status: Status;
  platforms: readonly Platform[];
  prerequisites: readonly string[];
  href?: string;
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
  prerequisites: string[] = []
): Feature => ({
  branch,
  id,
  title,
  description,
  status,
  platforms,
  ...(href ? { href } : {}),
  prerequisites,
});
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
    'Complete challenge/response authentication on send. Saving a configuration does not yet implement the handshake.',
    'planned',
    all,
    '/guides/auth/'
  ),
  entry(
    'security',
    'audit-logging',
    'Self-hosted audit logging',
    'Explore an operational audit trail for self-hosted deployments.',
    'exploring',
    ['Self-hosted']
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
    '/guides/environments/'
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
    'Validate HTTP responses against imported OpenAPI specifications.',
    'shipped',
    all,
    '/architecture/overview/',
    ['http']
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
    ['websocket', 'scripts']
  ),
  entry(
    'automation',
    'scheduled-runs',
    'Scheduled test runs',
    'Explore running tests on a schedule rather than starting each run manually.',
    'exploring',
    ['Desktop', 'Self-hosted', 'CLI'],
    undefined,
    ['cli']
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
    ['ai-assistant']
  ),
  entry(
    'ai',
    'natural-language',
    'Natural-language requests',
    'Explore turning a plain-language description into a request.',
    'exploring',
    all
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
    all
  ),
  entry(
    'platforms',
    'test-coverage',
    'Protocol & IPC coverage',
    'Strengthen meaningful regression coverage at protocol and desktop IPC boundaries.',
    'in-progress',
    all,
    '/testing/overview/'
  ),
  entry(
    'platforms',
    'jetbrains',
    'JetBrains integration',
    'Explore in-editor request execution for JetBrains IDEs.',
    'exploring',
    ['Desktop']
  ),
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
