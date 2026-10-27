/** Public editorial roadmap. Verify availability against capabilities.ts and source
 * before changing a status; planned/exploring entries carry no delivery dates. */
export const reviewedOn = '2026-10-12';
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
  /** GitHub issue that delivers this milestone. */
  issue?: number;
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
  /** Same-branch feature this one is drawn under on the map. */
  parent?: string;
  href?: string;
  plan?: Plan;
  tracking?: Tracking;
}
/** Where the work for a feature is tracked on GitHub. Public issues only — never
 * reference private security advisories here. */
export interface Tracking {
  /** Epic that groups the feature's open gaps. */
  epic?: number;
  /** Issues that deliver or fix the feature. */
  issues?: readonly number[];
  /** Repository label whose open audit issues are the feature's known gaps. */
  label?: string;
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
const todo = (title: string, issue?: number): Milestone => ({
  title,
  done: false,
  ...(issue ? { issue } : {}),
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
    'Build queries, inspect schemas, and subscribe to live updates. On web, subscriptions connect straight from the browser rather than through the Restura server.',
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
    'Inspect live event streams and resume with Last-Event-ID when you reconnect.',
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
    'Connect to MCP servers and inspect their tools, resources, and messages. The legacy HTTP+SSE transport and local stdio servers, started after a consent prompt, are desktop-only.',
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
        todo('Web app connects through the relay when headers are set', 898),
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
    'Challenge/response authentication on send. Digest is answered on every platform; NTLM is still saved-only and is expected to be desktop-only.',
    'in-progress',
    all,
    '/guides/auth/',
    [],
    {
      today:
        'Digest (RFC 7616: MD5, SHA-256 and their -sess variants, qop=auth) is answered by one retry after a 401 challenge in the shared protocol core, so web, self-hosted, desktop and the CLI all send it. NTLM settings are saved and validated, and the app warns that NTLM is not applied.',
      milestones: [
        done('Settings editors and validated configuration'),
        done('In-app notice for schemes that are not yet applied'),
        done('Digest challenge/response in the shared protocol core'),
        done('Retry-on-401 in the desktop and web proxies'),
        todo('NTLM handshake over a kept-alive desktop connection', 1069),
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
    'Import Postman, Insomnia, Bruno, Hoppscotch, OpenAPI, curl, and .http files; export portable OpenCollection, Postman, Insomnia or Bruno files.',
    'shipped',
    all,
    '/guides/import-export/'
  ),
  entry(
    'collections',
    'postman-v3',
    'Postman v2 / v3 import and v3 export',
    'Import Postman v2.x and v3 (folder, zip or file) with an import report, export Postman v3 as a folder or zip, and run Postman inputs from the CLI.',
    'shipped',
    all,
    '/guides/import-export/',
    ['import-export']
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
        todo('Run per incoming frame with time and rate limits', 899),
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
        todo('Run WebSocket requests in collection runs', 881),
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
    'Let agents like Claude read your collections through a local MCP server you control. The server runs today but exposes nothing until data sync and consent controls land.',
    'in-progress',
    desktop,
    '/guides/mcp-server-mode/',
    ['collections'],
    {
      today:
        'Launching the desktop app with --mcp-server starts a stdio MCP server with read-only, redacted tools. It deliberately sees no collections, environments, or history yet, so every tool call is refused.',
      milestones: [
        done('Headless stdio server (restura --mcp-server)'),
        done('Read-only tools with input validation and deep redaction'),
        done('Fail-closed consent model: every surface hidden by default'),
        todo('Sync collections, environments, and history to the headless server'),
        todo('Settings screen for per-collection and per-surface consent'),
        todo('Optional local HTTP transport with a one-time token'),
      ],
    }
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
    'Run agent suites and evals against Azure OpenAI, Amazon Bedrock, and Gemini.',
    'planned',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/',
    ['agent-suites'],
    {
      today: 'Adapter profiles describe all three providers, but none has a shipped transport yet.',
      milestones: [
        done('Adapter profiles for Gemini, Azure OpenAI, and Bedrock'),
        todo('Azure OpenAI transport on desktop and CLI', 1044),
        todo('Bedrock with request signing on desktop and CLI', 1044),
        todo('Gemini transport on desktop and CLI', 1044),
      ],
    }
  ),
  entry(
    'ai',
    'agent-sandboxes',
    'Agent code sandboxes',
    'Explore letting evaluated agents run code in an isolated sandbox, starting with the built-in script sandbox.',
    'exploring',
    desktop,
    '/guides/ai-lab/',
    ['agent-suites'],
    {
      today:
        'The sandbox provider contract and registry are implemented; no provider ships, and the CLI refuses sandbox sources.',
      milestones: [
        done('Sandbox provider contract and registry'),
        todo('Script sandbox provider on desktop and CLI', 1042),
        todo('Threat model and design record'),
        todo('Opt-in local container provider on desktop', 1055),
      ],
    }
  ),
  entry(
    'ai',
    'a2a-tools',
    'Remote agents as tools',
    'Let agent suites call remote agents over the Agent2Agent (A2A) protocol as tools.',
    'planned',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/',
    ['agent-suites'],
    {
      today: 'Suites can declare an A2A tool source, but no client is wired on desktop or the CLI.',
      milestones: [
        done('A2A tool source in the suite schema'),
        todo('Shared A2A client behind the outbound address guard', 1043),
        todo('Desktop adapter with approval for remote calls', 1043),
        todo('CLI adapter', 1043),
      ],
    }
  ),
  entry(
    'ai',
    'decision-models',
    'Decision models',
    'Test decision models such as Cloudflare Clef and TypeSafe Jev, which answer typed questions with calibrated probabilities, and use them as fast eval scorers.',
    'planned',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/',
    ['ai-lab'],
    {
      today:
        'AI Lab supports text-generation providers only; there is no decision-model provider or scorer.',
      milestones: [
        todo('SystemOne-compatible provider, local Clef first', 1049),
        todo('Typed-questions mode in the Playground', 1049),
        todo('Decision scorer for evals', 1050),
      ],
    }
  ),
  entry(
    'ai',
    'agent-approval-gate',
    'Risk-scored tool approvals',
    'Explore letting a decision model score the risk of an agent tool call before asking you to approve it.',
    'exploring',
    desktop,
    undefined,
    ['agent-suites'],
    {
      today: 'Every non-read agent tool call needs a manual approval.',
      milestones: [
        todo('Design record and security review', 1056),
        todo('Risk questions over the pending call', 1056),
        todo('Auto-approve or escalate by threshold', 1056),
      ],
    }
  ),
  entry(
    'ai',
    'cli-evals',
    'Dataset evals in CI',
    'Run AI Lab dataset evals, including judge scorers, from the CLI with a pass threshold as the exit code.',
    'planned',
    ['CLI'],
    undefined,
    ['ai-lab', 'cli'],
    {
      today: 'The CLI runs agent suites only and refuses judge scorers.',
      milestones: [
        todo('Design record for judges in the CLI', 1048),
        todo('Eval run command with desktop provider parity', 1045),
        todo('Per-eval pass threshold as the exit code', 1024),
      ],
    }
  ),
  entry(
    'ai',
    'model-drift-watch',
    'Model drift watch',
    'Explore re-running saved evals on a schedule and alerting when a provider update lowers your pass rate.',
    'exploring',
    desktop,
    undefined,
    ['ai-lab', 'scheduled-runs'],
    {
      today: 'Eval reports compare a run against the previous run of the same eval, on demand.',
      milestones: [
        todo('Per-eval pass threshold', 1024),
        todo('Scheduled eval runs on desktop', 1053),
        todo('Regression alerts', 1053),
      ],
    }
  ),
  entry(
    'ai',
    'api-explorer-agent',
    'API explorer agent',
    'Explore an agent that probes an API from its schema and saves each failure as a request and an eval case.',
    'exploring',
    desktop,
    undefined,
    ['agent-suites'],
    {
      today:
        'Agents can call saved requests as tools, and evals can be generated from OpenAPI specs.',
      milestones: [
        todo('Schema-driven probing with approvals', 1054),
        todo('Failures saved as requests', 1054),
        todo('Failures saved as eval cases', 1054),
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
  // Shipped capabilities verified in source on 2026-10-08 that had no entry yet.
  entry(
    'protocols',
    'code-generation',
    'Code generation',
    'Turn a request into curl, JavaScript, Node.js, Python, Go, PHP, or Ruby, with generators for GraphQL, WebSocket, SSE, and MCP too.',
    'shipped',
    all,
    '/protocols/http/'
  ),
  entry(
    'protocols',
    'network-console',
    'Network console',
    'Inspect every exchange, frame, and script log, and compare a response with the previous one.',
    'shipped',
    all,
    '/protocols/http/'
  ),
  entry(
    'protocols',
    'kafka-schema-registry',
    'Kafka Schema Registry',
    'Encode and decode Avro, Protobuf, and JSON Schema messages, and inspect topics and consumer groups.',
    'shipped',
    desktop,
    '/protocols/kafka/'
  ),
  entry(
    'security',
    'proxy-settings',
    'Proxies & bypass rules',
    'Route desktop traffic through HTTP, HTTPS, SOCKS4, or SOCKS5 proxies with authentication and a bypass list.',
    'shipped',
    desktop,
    '/overview/platforms/'
  ),
  entry(
    'security',
    'external-secrets',
    'Cloud secret providers',
    'Resolve secrets from AWS Secrets Manager, Google Secret Manager, and Azure Key Vault at send time, on desktop and in the CLI.',
    'shipped',
    ['Desktop', 'CLI'],
    '/guides/environments/'
  ),
  entry(
    'collections',
    'globals-scopes',
    'Globals & variable scopes',
    'Edit global and folder variables, and see which scope supplies each value.',
    'shipped',
    all,
    '/guides/environments/'
  ),
  entry(
    'collections',
    'tabs-history',
    'Tabs & request history',
    'Work across request tabs, reopen closed ones, and revisit anything you have sent.',
    'shipped',
    all,
    '/guides/collections/'
  ),
  entry(
    'collections',
    'collection-docs',
    'Collection documentation',
    'Generate readable Markdown or HTML documentation from a collection.',
    'shipped',
    all,
    '/guides/collections/'
  ),
  entry(
    'automation',
    'collection-runner',
    'Data-driven collection runs',
    'Run a collection or folder in the app with iterations and CSV or JSON data rows, then review the saved run history.',
    'shipped',
    all,
    '/guides/collections/',
    ['collections']
  ),
  entry(
    'automation',
    'cli-workflows',
    'Workflows from the CLI',
    'Run request workflows headlessly in CI, with explicit opt-in for mutating calls.',
    'shipped',
    ['CLI'],
    '/reference/cli/',
    ['cli', 'workflows']
  ),
  entry(
    'ai',
    'ai-arena',
    'Arena & Elo leaderboard',
    'Judge models head to head and rank them with an Elo leaderboard and win-rate matrix.',
    'shipped',
    desktop,
    '/guides/ai-lab/'
  ),
  entry(
    'ai',
    'eval-generation',
    'Generated eval datasets',
    'Generate eval cases from an OpenAPI spec or a red-team generator, or import them from request history.',
    'shipped',
    desktop,
    '/guides/ai-lab/'
  ),
  entry(
    'ai',
    'agent-telemetry',
    'Agent telemetry export',
    'Send metadata-only agent traces to OTLP or Langfuse endpoints you configure.',
    'shipped',
    ['Desktop', 'CLI'],
    '/guides/ai-lab/'
  ),
  entry(
    'platforms',
    'command-palette',
    'Command palette & shortcuts',
    'Jump to any request, action, or setting from the keyboard.',
    'shipped',
    all,
    '/guides/keyboard-shortcuts/'
  ),
  entry(
    'platforms',
    'desktop-updates',
    'Auto-update & deep links',
    'Keep the desktop app current on a stable or beta channel, and open it from restura:// links.',
    'shipped',
    desktop,
    '/guides/electron-updates/'
  ),
  // Ideas under exploration: directions informed by comparable API clients,
  // checked against the source so none duplicates something that already ships.
  entry(
    'protocols',
    'nats',
    'NATS & JetStream',
    'Publish, subscribe, and make request-reply calls against NATS, including JetStream consumers.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'Kafka and MQTT clients ship on desktop behind broker address guards; NATS has no client yet.',
      milestones: [
        todo('Core publish and subscribe'),
        todo('JetStream consumers'),
        todo('TLS and credentials authentication'),
      ],
    }
  ),
  entry(
    'protocols',
    'amqp',
    'AMQP / RabbitMQ',
    'Browse exchanges and queues, and publish or consume AMQP 0-9-1 messages.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'No AMQP client exists yet; the broker connection guards used by Kafka and MQTT would apply.',
      milestones: [
        todo('Connect and publish'),
        todo('Consume with acknowledgements'),
        todo('Exchange and queue browser'),
      ],
    }
  ),
  entry(
    'protocols',
    'http3',
    'HTTP/3 & WebTransport',
    'Send requests over QUIC and open WebTransport sessions, showing the negotiated protocol.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today: 'Desktop HTTP records the negotiated ALPN protocol; there is no QUIC transport.',
      milestones: [
        todo('HTTP/3 requests'),
        todo('Alt-Svc negotiation'),
        todo('WebTransport streams'),
      ],
    }
  ),
  entry(
    'security',
    'vault-providers',
    '1Password & Vault',
    'Add 1Password and HashiCorp Vault alongside the cloud secret providers.',
    'exploring',
    ['Desktop', 'CLI'],
    undefined,
    [],
    {
      today:
        'AWS, Google, and Azure secret providers ship; the provider list is a closed set in the profile schema.',
      milestones: [
        todo('Pluggable provider interface'),
        todo('1Password adapter'),
        todo('HashiCorp Vault adapter'),
      ],
    }
  ),
  entry(
    'security',
    'workspace-trust',
    'Workspace trust',
    'Ask before running scripts or agent tools from a freshly cloned collection.',
    'exploring',
    ['Desktop', 'CLI'],
    undefined,
    [],
    {
      today: 'Scripts run in a bounded QuickJS sandbox; there is no per-workspace trust decision.',
      milestones: [todo('Trust model'), todo('Desktop trust prompt'), todo('CLI trust flag')],
    }
  ),
  entry(
    'collections',
    'asyncapi-import',
    'AsyncAPI import',
    'Turn AsyncAPI channels into Kafka, MQTT, WebSocket, and SSE requests.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'Collections can record an AsyncAPI spec kind, but no importer reads AsyncAPI documents.',
      milestones: [
        todo('Spec parser'),
        todo('Channel-to-request mapping'),
        todo('Server and binding variables'),
      ],
    }
  ),
  entry(
    'collections',
    'team-sync',
    'Account-free team sync',
    'Share collections and environments with teammates through an encrypted relay you host, with no cloud account.',
    'exploring',
    ['Desktop', 'Self-hosted'],
    undefined,
    [],
    {
      today: 'Teams share collections through Git today; there is no live sync.',
      milestones: [
        todo('Sync design record'),
        todo('Encrypted relay'),
        todo('Conflict resolution view'),
      ],
    }
  ),
  entry(
    'automation',
    'visual-assertions',
    'Visual assertion builder',
    'Add status, JSONPath, schema, and latency checks without writing a script.',
    'exploring',
    all,
    undefined,
    [],
    {
      today: 'Assertions are written as scripts in the sandbox; there is no no-code builder.',
      milestones: [todo('Assertion schema'), todo('Builder interface'), todo('CLI report parity')],
    }
  ),
  entry(
    'automation',
    'mock-from-traffic',
    'Mocks from recordings',
    'Generate mock routes from recorded traffic and request history, with replay matching rules.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today: 'The mock server serves hand-written and OpenAPI-generated routes only.',
      milestones: [
        todo('Recordings to routes'),
        todo('Matching rules'),
        todo('Record and replay mode'),
      ],
    }
  ),
  entry(
    'automation',
    'api-monitors',
    'Uptime monitors',
    'Run collections on a schedule from a self-hosted server and alert on failures.',
    'exploring',
    ['Self-hosted', 'CLI'],
    undefined,
    [],
    {
      today: 'Collections run on demand in the app and the CLI; nothing runs on a schedule.',
      milestones: [
        todo('Monitor definitions'),
        todo('Alert channels'),
        todo('Run history dashboard'),
      ],
    }
  ),
  entry(
    'ai',
    'ai-tests-from-traffic',
    'AI tests from traffic',
    'Draft assertions and regression suites from recorded traffic, with secrets redacted first.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'AI Lab generates eval cases from OpenAPI specs and history; request test suites are written by hand.',
      milestones: [
        todo('Traffic selection and redaction', 1029),
        todo('Assertion drafting'),
        todo('Review and accept'),
        todo('Re-run on model or prompt changes', 1051),
      ],
    }
  ),
  entry(
    'platforms',
    'plugin-api',
    'Plugin API',
    'Extend Restura with sandboxed plugins for custom auth, importers, and panels.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'Extension points are internal; scripts already run in a QuickJS sandbox a plugin host could reuse.',
      milestones: [
        todo('Manifest and permissions'),
        todo('Sandboxed host interface'),
        todo('Local plugin loader'),
      ],
    }
  ),
  entry(
    'protocols',
    'streaming-timeline',
    'Unified streaming timeline',
    'See WebSocket, Socket.IO, SSE, Kafka, and MQTT traffic in one filterable, exportable timeline.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'The console already mirrors WebSocket and SSE frames; each protocol otherwise keeps its own message log.',
      milestones: [
        done('Console mirrors WebSocket and SSE frames'),
        todo('Shared timeline event model'),
        todo('Kafka, MQTT, and Socket.IO sources'),
        todo('Filter, correlate, and export'),
      ],
    }
  ),
  entry(
    'automation',
    'stream-assertions',
    'Stream assertions',
    'Assert on streamed frames and events in the app, such as a match within the first N events.',
    'exploring',
    ['Web', 'Desktop', 'Self-hosted', 'CLI'],
    undefined,
    ['websocket'],
    {
      today:
        'The CLI exposes SSE stream events to test scripts; in the app, scripts run for HTTP, GraphQL and every gRPC call type (gRPC stream tests see all messages via rs.response.messages).',
      milestones: [
        done('CLI stream-event script context'),
        todo('In-app stream script hook', 899),
        todo('Assert-within-N-events helpers'),
        todo('WebSocket, MQTT, and Kafka sources'),
      ],
    }
  ),
  entry(
    'protocols',
    'message-templates',
    'Saved message templates',
    'Save reusable WebSocket, Socket.IO, and MQTT messages with variables and send them in one click.',
    'exploring',
    all,
    undefined,
    ['websocket'],
    {
      today:
        'Connections are saved, but each message is typed by hand and variables are not resolved in message bodies.',
      milestones: [
        todo('Template list on saved connections'),
        todo('Variable resolution at send time', 927),
        todo('One-click send'),
      ],
    }
  ),
  entry(
    'protocols',
    'graphql-operation-picker',
    'GraphQL operation picker',
    'Pick an operation from a multi-operation document and send it over the right transport automatically.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'The operation type and name are read with pattern matching, and the first operation is always sent.',
      milestones: [
        todo('Parse documents into operations', 870),
        todo('Operation chips in the editor'),
        todo('Route subscriptions to WebSocket automatically'),
      ],
    }
  ),
  entry(
    'protocols',
    'graphql-error-navigation',
    'Click-through GraphQL errors',
    'Jump from each GraphQL error to the matching place in the query and in the response tree.',
    'exploring',
    all,
    undefined,
    [],
    {
      today: 'Only the first GraphQL error message is shown, as a notification.',
      milestones: [
        todo('Map error locations to editor markers'),
        todo('Map error paths to response nodes'),
        todo('Error list panel'),
      ],
    }
  ),
  entry(
    'protocols',
    'streaming-code-snippets',
    'Code snippets for every protocol',
    'Generate code for WebSocket, SSE, MCP, GraphQL, and gRPC requests the way HTTP does today.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'Generators for WebSocket, SSE, MCP, and GraphQL are written but nothing in the interface uses them.',
      milestones: [
        done('WebSocket, SSE, MCP, and GraphQL generators'),
        todo('Snippet panel on each protocol', 916),
        todo('grpcurl and buf curl output'),
      ],
    }
  ),
  entry(
    'protocols',
    'grpc-schema-drift',
    'gRPC schema drift check',
    'Save the reflected schema with a request and flag breaking changes the next time you reflect.',
    'exploring',
    all,
    undefined,
    ['contracts'],
    {
      today:
        'Reflection fetches full descriptor sets, but nothing stores them on the request or compares versions.',
      milestones: [
        todo('Schema snapshot saved on requests', 871),
        todo('Descriptor diff'),
        todo('Breaking-change warnings'),
      ],
    }
  ),
  entry(
    'protocols',
    'grpc-field-errors',
    'gRPC field errors in the editor',
    'Highlight the request fields a server rejected, using its structured error details.',
    'shipped',
    all,
    '/protocols/grpc/'
  ),
  entry(
    'protocols',
    'grpc-strict-send',
    'Unknown-field warnings for gRPC',
    'Warn before sending when request fields do not exist in the message type, instead of dropping them.',
    'exploring',
    all,
    undefined,
    [],
    {
      today: 'Unknown request fields are silently dropped when the message is encoded.',
      milestones: [
        todo('Detect dropped fields'),
        todo('Pre-send warning'),
        todo('Strict mode setting'),
      ],
    }
  ),
  entry(
    'protocols',
    'mqtt-request-response',
    'MQTT request and response',
    'Publish with a reply topic and correlation ID, wait for the matching reply, and show round-trip time.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'MQTT 5 reply topic and correlation data can be set on publish; nothing matches replies.',
      milestones: [
        done('Reply topic and correlation data on publish'),
        todo('Automatic reply subscription'),
        todo('Reply matching and latency'),
      ],
    }
  ),
  entry(
    'protocols',
    'kafka-topic-browse',
    'Read-only Kafka topic browser',
    'Peek at a topic from a time or offset without creating a consumer group or committing offsets.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today:
        'Every consume joins a consumer group, so browsing a topic creates the group and commits offsets.',
      milestones: [
        todo('Group-free partition assignment', 930),
        todo('Start from time or offset'),
        todo('No-commit browsing mode'),
      ],
    }
  ),
  entry(
    'protocols',
    'schema-registry-subjects',
    'Schema Registry subject picker',
    'Choose a subject and version instead of typing a schema ID, and see the schema beside decoded records.',
    'exploring',
    desktop,
    undefined,
    [],
    {
      today: 'Producing with Schema Registry needs a numeric schema ID.',
      milestones: [
        todo('Subject and version browser', 926),
        todo('Latest-version produce'),
        todo('Schema shown beside records'),
      ],
    }
  ),
  entry(
    'collections',
    'broker-presets',
    'Broker connection presets',
    'Save Kafka and MQTT connections, topics, and payload templates in collections to share them through Git.',
    'exploring',
    desktop,
    undefined,
    ['kafka', 'mqtt'],
    {
      today:
        'Kafka and MQTT connections are saved locally with secrets in secure storage, but cannot go in a collection.',
      milestones: [
        done('Secure storage for broker secrets'),
        todo('Connection item in collections', 886),
        todo('Collection file format support'),
      ],
    }
  ),
  entry(
    'automation',
    'mcp-server-tests',
    'MCP server tests in CI',
    'Save MCP calls in collections with test scripts and run them from the CLI.',
    'exploring',
    ['Web', 'Desktop', 'Self-hosted', 'CLI'],
    undefined,
    ['mcp', 'cli'],
    {
      today:
        'The CLI can send MCP requests, but saved collections keep only a ping; the app runner skips MCP.',
      milestones: [
        done('Pooled JSON-RPC runner'),
        todo('Method and arguments saved in collections', 877),
        todo('In-app runner support', 899),
        todo('Test scripts on MCP results'),
      ],
    }
  ),
  entry(
    'protocols',
    'mcp-config-import',
    'Import MCP client configs',
    'Add servers from the mcp.json files used by Claude Desktop, Cursor, and VS Code.',
    'exploring',
    all,
    undefined,
    [],
    {
      today: 'MCP servers are added one by one by URL.',
      milestones: [
        todo('mcp.json parser'),
        todo('Remote server import'),
        todo('Local command servers after stdio support', 854),
      ],
    }
  ),
  entry(
    'protocols',
    'mcp-conformance',
    'MCP conformance report',
    'Run a server against older and newer protocol versions and report differences and schema violations.',
    'exploring',
    all,
    undefined,
    [],
    {
      today:
        'The desktop client negotiates protocol versions and the SDK validates structured tool output.',
      milestones: [
        done('Version negotiation on desktop'),
        todo('Side-by-side version runs'),
        todo('Conformance report'),
        todo('Tool annotation honesty checks', 1052),
        todo('Agent task-completion evals against the server', 1052),
      ],
    }
  ),
  entry(
    'platforms',
    'docs-try-it',
    'Try it from the docs',
    'Open each protocol example from the docs straight into Restura against the public echo server.',
    'exploring',
    ['Web', 'Desktop', 'Self-hosted'],
    undefined,
    [],
    {
      today:
        'The echo server serves HTTP, GraphQL, WebSocket, and SSE endpoints; docs examples are typed by hand.',
      milestones: [
        done('Public echo server'),
        todo('Per-protocol sample collections'),
        todo('Open-in-Restura links'),
      ],
    }
  ),
  entry(
    'platforms',
    'docs-from-source',
    'Docs generated from source',
    'Build the docs capability summary and local port tables from the same source as the app.',
    'exploring',
    ['Web', 'Desktop', 'Self-hosted'],
    undefined,
    [],
    {
      today:
        'The capability matrix is generated for the repository docs; the docs site keeps a hand-written summary.',
      milestones: [
        done('Generated capability matrix'),
        todo('Docs-site summary from capabilities', 981),
        todo('Port table from the local stack'),
      ],
    }
  ),
  entry(
    'platforms',
    'docs-link-checks',
    'Docs link and claim checks',
    'Fail the docs build on broken links and on claims that drift from the code.',
    'exploring',
    ['Web', 'Desktop', 'Self-hosted'],
    undefined,
    [],
    {
      today: 'The docs build and type check run in CI; links are not validated.',
      milestones: [
        todo('Link validator in the docs build'),
        todo('Anchor checks'),
        todo('Claim-to-source checks'),
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

/** Editorial tree shape: the same-branch feature each one is drawn under. It reads
 * as "builds on", so only name a parent the feature genuinely extends. Without one,
 * a feature hangs from its first same-branch prerequisite, then from the hub. */
const parents: Record<string, string> = {
  graphql: 'http',
  sse: 'http',
  mcp: 'http',
  'socket-io': 'websocket',
  'digest-ntlm': 'auth',
  'secret-handles': 'local-storage',
  environments: 'collections',
  'import-export': 'collections',
  'environment-export': 'environments',
  contracts: 'mock-server',
  'natural-language': 'ai-assistant',
  'agent-suites': 'ai-lab',
  'self-hosting': 'web-app',
  'code-generation': 'http',
  'network-console': 'http',
  'kafka-schema-registry': 'kafka',
  http3: 'http',
  'proxy-settings': 'native-tls',
  'external-secrets': 'secret-handles',
  'vault-providers': 'external-secrets',
  'globals-scopes': 'environments',
  'tabs-history': 'collections',
  'collection-docs': 'collections',
  'asyncapi-import': 'import-export',
  'team-sync': 'git-collections',
  'visual-assertions': 'scripts',
  'mock-from-traffic': 'mock-server',
  'api-monitors': 'scheduled-runs',
  'ai-arena': 'ai-lab',
  'eval-generation': 'ai-lab',
  'ai-tests-from-traffic': 'eval-generation',
  'agent-telemetry': 'agent-suites',
  'desktop-updates': 'desktop-app',
  'streaming-timeline': 'websocket',
  'stream-assertions': 'websocket-scripts',
  'message-templates': 'websocket',
  'graphql-operation-picker': 'graphql',
  'graphql-error-navigation': 'graphql',
  'streaming-code-snippets': 'code-generation',
  'grpc-schema-drift': 'grpc',
  'grpc-field-errors': 'grpc',
  'grpc-strict-send': 'grpc',
  'mqtt-request-response': 'mqtt',
  'kafka-topic-browse': 'kafka',
  'schema-registry-subjects': 'kafka-schema-registry',
  'broker-presets': 'collections',
  'mcp-server-tests': 'collection-runner',
  'mcp-config-import': 'mcp',
  'mcp-conformance': 'mcp',
  'docs-try-it': 'web-app',
};
/** GitHub tracking: epics and issues per feature, so the roadmap links to the
 * work behind each node. Public issues only. */
export const featureTracking: Readonly<Record<string, Tracking>> = {
  http: { epic: 843, label: 'http' },
  graphql: { epic: 844, label: 'graphql' },
  grpc: { epic: 845, label: 'grpc' },
  'grpc-streaming': { epic: 845, issues: [879, 917] },
  websocket: { epic: 846, label: 'websocket' },
  'socket-io': { epic: 847, label: 'socketio' },
  sse: { epic: 848, label: 'sse' },
  kafka: { epic: 849, label: 'kafka' },
  'kafka-schema-registry': { epic: 849, issues: [922, 926] },
  mqtt: { epic: 850, label: 'mqtt' },
  mcp: { epic: 851, label: 'mcp' },
  'code-generation': { issues: [916] },
  auth: { epic: 852, issues: [894] },
  environments: { epic: 852, issues: [890] },
  'import-export': { epic: 852, issues: [863, 866, 869, 909] },
  collections: { epic: 852, issues: [873, 886] },
  'tabs-history': { epic: 852, issues: [904, 924] },
  cli: { epic: 852, issues: [877, 881, 932] },
  'mock-server': { epic: 852, issues: [913] },
  'secret-handles': { issues: [928, 896, 976] },
  'ai-assistant': { issues: [977] },
  'mcp-server': { issues: [979] },
  'ai-lab': { epic: 1057, issues: [1019, 1024, 1028, 1029, 1030, 1033] },
  'agent-suites': { epic: 1057, issues: [1021, 1026, 1027, 1035, 1047] },
  'ai-arena': { epic: 1057, issues: [1020, 1023, 1046] },
  'agent-providers': { epic: 1057, issues: [1044] },
  'agent-sandboxes': { epic: 1057, issues: [1042, 1055] },
  'a2a-tools': { epic: 1057, issues: [1043] },
  'decision-models': { epic: 1057, issues: [1049, 1050] },
  'agent-approval-gate': { epic: 1057, issues: [1056] },
  'cli-evals': { epic: 1057, issues: [1045, 1048] },
  'model-drift-watch': { epic: 1057, issues: [1053] },
  'api-explorer-agent': { epic: 1057, issues: [1054] },
  'ai-tests-from-traffic': { issues: [1051] },
  'digest-ntlm': { issues: [861, 1069] },
  'websocket-web-headers': { epic: 846, issues: [898] },
  'websocket-scripts': { issues: [899] },
  'cli-parity': { issues: [881] },
  'streaming-timeline': { issues: [971] },
  'stream-assertions': { issues: [936] },
  'message-templates': { issues: [974] },
  'graphql-operation-picker': { issues: [903] },
  'graphql-error-navigation': { issues: [907] },
  'streaming-code-snippets': { issues: [940] },
  'grpc-schema-drift': { issues: [937] },
  'grpc-field-errors': { issues: [941] },
  'grpc-strict-send': { issues: [944] },
  'mqtt-request-response': { issues: [978] },
  'kafka-topic-browse': { issues: [980] },
  'schema-registry-subjects': { issues: [982] },
  'broker-presets': { issues: [984] },
  'mcp-server-tests': { issues: [901] },
  'mcp-config-import': { issues: [906] },
  'mcp-conformance': { issues: [911, 1052] },
  'docs-try-it': { issues: [1013] },
  'docs-from-source': { issues: [1014] },
  'docs-link-checks': { issues: [1015] },
};
for (const feature of features) {
  const track = featureTracking[feature.id];
  if (track) feature.tracking = track;
}

export const repositoryUrl = 'https://github.com/dipjyotimetia/restura';
export const issueUrl = (issue: number) => `${repositoryUrl}/issues/${issue}`;
/** Open issues from the protocol gap review that carry a feature's label. */
export const knownGapsUrl = (label: string) =>
  `${repositoryUrl}/issues?q=${encodeURIComponent(`is:issue is:open label:${label} label:"audit:2026-10-12"`)}`;
export interface TrackingLink {
  text: string;
  href: string;
}
/** Links shown wherever a feature's details render (tree popover, list, plan). */
export function trackingLinks(feature: Feature): TrackingLink[] {
  const track = feature.tracking;
  if (!track) return [];
  const links: TrackingLink[] = [];
  if (track.epic) links.push({ text: `Epic #${track.epic}`, href: issueUrl(track.epic) });
  for (const issue of track.issues ?? [])
    links.push({ text: `Issue #${issue}`, href: issueUrl(issue) });
  if (track.label) links.push({ text: 'Open known gaps', href: knownGapsUrl(track.label) });
  return links;
}

for (const feature of features) {
  const parent = parents[feature.id];
  if (parent) feature.parent = parent;
}
const featureById = new Map(features.map((feature) => [feature.id, feature]));
export function treeParent(feature: Feature): Feature | undefined {
  const id =
    feature.parent ??
    feature.prerequisites.find(
      (prerequisite) => featureById.get(prerequisite)?.branch === feature.branch
    );
  return id ? featureById.get(id) : undefined;
}

// The map is a tree: the root fans out to one hub per branch, and each feature
// sits one row below the previous one and one step right of its tree parent.
// Every map coordinate derives from these values; the page and script share them.
export const nodeSize = 40;
export const hubSize = 48;
export const labelWidth = 136;
export const layout = {
  margin: 36,
  branchGap: 32,
  minBranchWidth: 240,
  depthStep: 80,
  rootTop: 14,
  trunkTop: 76,
  trunkY: 124,
  hubY: 276,
  firstRowGap: 92,
  rowPitch: 82,
  bottomPad: 80,
} as const;

/** Depth-first rows per branch, so children follow their parent directly. */
const placement = new Map<string, { column: number; depth: number; row: number }>();
const branchDepth: number[] = [];
const branchRows: number[] = [];
branches.forEach((branch, column) => {
  const items = features.filter((feature) => feature.branch === branch.id);
  let row = 0;
  let deepest = 0;
  const place = (feature: Feature, depth: number) => {
    placement.set(feature.id, { column, depth, row: row++ });
    deepest = Math.max(deepest, depth);
    for (const child of items.filter((item) => treeParent(item) === feature))
      place(child, depth + 1);
  };
  for (const item of items.filter((candidate) => !treeParent(candidate))) place(item, 0);
  branchDepth.push(deepest);
  branchRows.push(row);
});

export const branchWidth = (column: number) =>
  Math.max(layout.minBranchWidth, labelWidth + (branchDepth[column] ?? 0) * layout.depthStep);
export const branchLeft = (column: number) => {
  let left = layout.margin;
  for (let index = 0; index < column; index++) left += branchWidth(index) + layout.branchGap;
  return left;
};
const depthX = (column: number, depth: number) =>
  branchLeft(column) + labelWidth / 2 + depth * layout.depthStep;
export const mapWidth =
  branchLeft(branches.length - 1) + branchWidth(branches.length - 1) + layout.margin;
export const rootX = mapWidth / 2;
export const mapHeight =
  layout.hubY +
  layout.firstRowGap +
  (Math.max(...branchRows) - 1) * layout.rowPitch +
  layout.bottomPad;

export function featureGrid(feature: Feature): { column: number; depth: number; row: number } {
  const place = placement.get(feature.id);
  if (!place) throw new Error(`Unplaced feature: ${feature.id}`);
  return place;
}
/** Centre of the branch hub circle. */
export const hubPosition = (column: number) => ({ x: depthX(column, 0), y: layout.hubY });
/** Centre of the feature's circle. */
export function featurePosition(feature: Feature): { x: number; y: number } {
  const { column, depth, row } = featureGrid(feature);
  return {
    x: depthX(column, depth),
    y: layout.hubY + layout.firstRowGap + row * layout.rowPitch,
  };
}

export const rootLinkPath = (column: number) => {
  const hub = hubPosition(column);
  return `M${rootX} ${layout.trunkY} L${hub.x} ${hub.y - hubSize / 2}`;
};
/** Top-level features hang from the hub's spine. A parent's first child is reached
 * diagonally; later siblings continue straight down from it, sharing that line. */
export function edgePath(feature: Feature): string {
  const { x, y } = featurePosition(feature);
  const parent = treeParent(feature);
  if (!parent) {
    const hub = hubPosition(featureGrid(feature).column);
    return `M${hub.x} ${hub.y} V${y}`;
  }
  const from = featurePosition(parent);
  const first = features.find((item) => treeParent(item) === parent) ?? feature;
  const firstY = featurePosition(first).y;
  return `M${from.x} ${from.y} L${x} ${firstY}${y === firstY ? '' : ` V${y}`}`;
}

/** Fit the map's width, letting tall maps overflow downward for panning rather than
 * shrinking labels further. Phones frame the first branch at a readable size with
 * the next one peeking in, inviting a horizontal pan. */
export function fitScale(viewportWidth: number, viewportHeight: number): number {
  if (viewportWidth < 640)
    return Math.min(1, (viewportWidth - 24) / (branchWidth(0) + layout.margin));
  const width = (viewportWidth - 52) / mapWidth;
  return Math.max(0.1, Math.min(1, width, (viewportHeight * 1.6) / mapHeight));
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
