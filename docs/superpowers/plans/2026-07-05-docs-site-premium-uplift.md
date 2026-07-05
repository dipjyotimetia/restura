# Docs-Site Testing Coverage & Premium Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Testing & Quality" section and a "Contributing" section to `docs-site/`, expand three thin protocol pages, bring every remaining existing page to a shared style bar with cross-links into the new sections, add two landing-page cards, and verify the site still builds cleanly — all inside an isolated git worktree.

**Architecture:** One Claude Code Workflow script does the heavy lifting in five phases (research → style guide → author → verify → fix), run as a single background task inside the worktree. The plan wraps that one Workflow invocation with a worktree-setup task before it and a build-verification + manual spot-check after it.

**Tech Stack:** Astro 7 + Starlight (docs-site), Node 24+, npm. No new dependencies.

## Global Constraints

- Scope is `docs-site/` content and IA only — see spec §2. No changes to `CONTRIBUTING.md`, `CI_CD.md`, root `docs/*.md`, or any app/worker/electron source.
- All work happens in a new isolated git worktree (spec "Isolation" decision) — no changes land on the current `main` checkout.
- No push, PR, or merge without a separate explicit ask once the work is done (repo-wide default; also matches the spec's Isolation decision).
- New sidebar sections: "Testing & Quality" (6 pages) after "Architecture" and before "Self-hosting"; "Contributing" (2 pages) after "Reference". Both default `collapsed: false`.
- Every claim in the new Testing & Quality pages must trace to a real file/command/port in the repo — no invented numbers or stats (spec §5, §8).
- The design spec is the source of truth for content grounding: `docs/superpowers/specs/2026-07-05-docs-site-premium-uplift-design.md`.
- Hard gates before calling this done: `npm run check` and `npm run build` inside `docs-site/`, both green (spec §8).

---

## File Structure

New files:

```
docs-site/src/content/docs/testing/overview.mdx
docs-site/src/content/docs/testing/local-stack.mdx
docs-site/src/content/docs/testing/unit-integration.mdx
docs-site/src/content/docs/testing/end-to-end.mdx
docs-site/src/content/docs/testing/security.mdx
docs-site/src/content/docs/testing/contract-and-ci.mdx
docs-site/src/content/docs/contributing/overview.mdx
docs-site/src/content/docs/contributing/dev-setup.mdx
docs-site/.style-guide.md          # internal reference, not a published site page
```

Modified files:

```
docs-site/astro.config.mjs                              # sidebar: add Testing & Quality + Contributing groups
docs-site/src/content/docs/index.mdx                     # landing: two new cards
docs-site/src/content/docs/protocols/socket-io.mdx       # thin-page expansion
docs-site/src/content/docs/protocols/sse.mdx             # thin-page expansion
docs-site/src/content/docs/protocols/graphql.mdx         # thin-page expansion
+ 63 remaining existing pages (structural/frontmatter/cross-link pass only — listed in Task 2's batch groups below)
```

---

## Task 1: Set up isolated workspace and verify a clean baseline

**Files:** none created/modified — environment setup only.

- [ ] **Step 1: Create the isolated worktree**

Use the `superpowers:using-git-worktrees` skill to create an isolated workspace for this work. Suggested branch name: `worktree-docs-site-premium-uplift` (matches the repo's existing convention for audit/uplift-style worktrees — see `git worktree list`, e.g. `worktree-monorepo-audit`, `worktree-security-audit`).

Record the absolute path the tool reports. Every subsequent task in this plan refers to it as `<WORKTREE_ROOT>` — substitute the real path everywhere it appears.

- [ ] **Step 2: Install dependencies in the worktree's docs-site**

Run:

```bash
cd <WORKTREE_ROOT>/docs-site && npm install
```

Expected: exits 0. If it fails, read `docs-site/README.md`'s "Toolchain & Astro 7" section first — the `overrides` block for the Starlight/Astro 7 peer mismatch is the known fragile point.

- [ ] **Step 3: Verify a clean baseline build (before any content changes)**

Run:

```bash
cd <WORKTREE_ROOT>/docs-site && npm run check && npm run build
```

Expected: both exit 0. This establishes that any build failure discovered later in this plan came from our own changes, not pre-existing repo state.

No commit in this task — nothing has changed yet.

---

## Task 2: Run the content-generation Workflow

**Files:** all files listed in "File Structure" above.

**Interfaces:**

- Consumes: `<WORKTREE_ROOT>` from Task 1.
- Produces: every file in "File Structure," committed to the worktree branch. Task 3 consumes the resulting worktree state.

- [ ] **Step 1: Invoke the Workflow tool with the script below**

Call the `Workflow` tool with `args: { worktreeRoot: "<WORKTREE_ROOT>" }` (the real absolute path from Task 1) and this script:

```js
export const meta = {
  name: 'docs-site-premium-uplift',
  description:
    'Add Testing & Quality + Contributing sections to docs-site, expand thin protocol pages, bring every page to a shared style bar, verify links and facts',
  phases: [
    { title: 'Research' },
    { title: 'Style Guide' },
    { title: 'Author' },
    { title: 'Verify' },
    { title: 'Fix' },
  ],
};

const ROOT = args.worktreeRoot;
const DOCS = `${ROOT}/docs-site/src/content/docs`;
const STYLE_GUIDE_PATH = `${ROOT}/docs-site/.style-guide.md`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    facts: {
      type: 'string',
      description:
        'Markdown bullet list of grounded facts (exact commands, file paths, ports, credentials). Every bullet must cite the source file in parentheses at the end.',
    },
    citedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['topic', 'facts', 'citedFiles'],
};

const WRITE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    status: { type: 'string', enum: ['written', 'skipped'] },
    notes: { type: 'string' },
  },
  required: ['path', 'status'],
};

const BATCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          changed: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['file', 'changed'],
      },
    },
  },
  required: ['results'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['file', 'issue', 'fix'],
      },
    },
  },
  required: ['findings'],
};

// ---------------------------------------------------------------------------
// Phase 1: Research (parallel, read-only, grounds every fact used later)
// ---------------------------------------------------------------------------
phase('Research');

const RESEARCH_TOPICS = [
  {
    topic: 'echoLocal',
    prompt: `Read ${ROOT}/echo-local/README.md in full. Extract: what it is and why it exists, the exact "make setup"/"make echo-local" and "npm run echo:local[...]" commands, the full ports table (service, URL, notes), TLS/mTLS/custom-CA setup, the TEST_AUTH_FIXTURES credentials, which services need Docker (Kafka/Redpanda, MQTT/EMQX), what the generated importable collection covers, and what must be driven manually (WebSocket/Socket.IO/MQTT/Kafka/OAuth2/WSSE/OAuth1/Digest/NTLM per the README's own "Driven manually" section). Return every fact as a bullet citing "(echo-local/README.md)".`,
  },
  {
    topic: 'unitIntegration',
    prompt: `Read ${ROOT}/vitest.config.ts and ${ROOT}/tests/setup.ts. Then read one representative colocated test file (find any *.test.tsx under ${ROOT}/src/ and read it) to confirm the pattern (React Testing Library, colocated with source). Extract: test environment (jsdom or other), setup file responsibilities, the colocation convention, and the exact npm scripts for running tests (grep "test" scripts from ${ROOT}/package.json). Return facts as bullets citing their source file.`,
  },
  {
    topic: 'e2eWeb',
    prompt: `Read ${ROOT}/e2e/README.md and ${ROOT}/playwright.config.ts. Extract: how the dev server boots (webServer config), why workers:1/fullyParallel:false is set (shared dev-server state), what "real-*.spec.ts" tests hit (live upstreams / the echo Worker) vs the other specs, and the role of e2e/global-setup.ts and .dev.vars bootstrapping. List 3-4 representative spec files by name (from ${ROOT}/e2e/) with a one-line description of what each covers. Return facts as bullets citing their source file.`,
  },
  {
    topic: 'e2eElectron',
    prompt: `Read ${ROOT}/e2e-electron/playwright.config.ts and ${ROOT}/e2e-electron/global-setup.ts. List the spec files under ${ROOT}/e2e-electron/specs/. Extract: that this suite launches the unpacked prod build via Playwright's _electron, that it needs "npm run test:e2e:electron:build" first, that it needs the native gRPC dev server (npm run grpc:server, :50051) since the echo Worker's Connect endpoint is web-only, and that Kafka/MQTT specs auto-bring-up the Dockerised brokers via a "brokers" fixture and skip if Docker is absent. Return facts as bullets citing their source file.`,
  },
  {
    topic: 'securityTests',
    prompt: `List every file in ${ROOT}/tests/security/ and read each one's top-level describe block(s) and file-level comments. For each file, write one bullet: "<filename> — guards against <what regression, in plain language>". Files to cover: ai-lab-localhost-policy.test.ts, ai-redaction.test.ts, capture-redaction.test.ts, http-executor-no-fallback.test.ts, path-traversal.test.ts, response-viewer-sandbox.test.ts, secret-storage-routing.test.ts, socketio-dns-pinning.test.ts, sse-proxy-routing.test.ts, ssrf.test.ts, visualizer-sandbox.test.tsx. Return facts as bullets citing "(tests/security/<filename>)".`,
  },
  {
    topic: 'contractTests',
    prompt: `Read ${ROOT}/tests/contract/fetchers.ts, ${ROOT}/tests/contract/upstream.ts, ${ROOT}/tests/contract/http-proxy.contract.test.ts, and ${ROOT}/tests/contract/http-proxy-streaming.contract.test.ts. Extract: what a "contract test" verifies here (the shared protocol core's behavior against a real upstream, independent of which backend calls it), and the exact npm script (grep "test:contract" from ${ROOT}/package.json). Return facts as bullets citing their source file.`,
  },
  {
    topic: 'ciAndValidate',
    prompt: `Read ${ROOT}/docs/CI_CD.md and grep the "validate" script and everything it chains (type-check:all, lint, format:check, verify:opencollection-types, capabilities:check, test:run) from ${ROOT}/package.json's "scripts" block. Extract: what "npm run validate" runs end to end, and at a high level what CI checks on every PR (cite CI_CD.md section headers, don't reproduce the whole file). Return facts as bullets citing their source file.`,
  },
  {
    topic: 'contributingProcess',
    prompt: `Read ${ROOT}/CONTRIBUTING.md in full. Extract: prerequisites (Node/npm/Git versions), branch naming convention, commit message format, the PR process, and the Code of Conduct reference. Return facts as bullets citing "(CONTRIBUTING.md)".`,
  },
  {
    topic: 'devSetup',
    prompt: `Read ${ROOT}/package.json's "scripts" block, ${ROOT}/tsconfig.json, and ${ROOT}/tsconfig.base.json. Confirm and extract: the Node engine requirement, the dev commands (npm run dev, build, test, lint, format, validate), and the exact "type-check" vs "type-check:all" gotcha — what ${ROOT}/tsconfig.json's "exclude" array actually excludes (check whether worker, electron/main, cli are excluded), so the claim that "type-check only covers the renderer" is verified against the real exclude list, not assumed. Return facts as bullets citing their source file.`,
  },
];

const research = await parallel(
  RESEARCH_TOPICS.map(
    (t) => () =>
      agent(t.prompt, { label: `research:${t.topic}`, schema: RESEARCH_SCHEMA, phase: 'Research' })
  )
);
const factsByTopic = {};
research.filter(Boolean).forEach((r, i) => {
  factsByTopic[RESEARCH_TOPICS[i].topic] = r.facts;
});
const factsOr = (topic) =>
  factsByTopic[topic] ||
  `(research for "${topic}" did not return — re-derive from source files directly before writing this page)`;

// ---------------------------------------------------------------------------
// Phase 2: Style guide (single agent, authored before any page work)
// ---------------------------------------------------------------------------
phase('Style Guide');

const STYLE_GUIDE_CONTENT = `# Restura Docs — Style Guide (internal reference, not a published page)

Every page in docs-site should read like it was written by the same person. Follow this exactly.

## Voice
- Second person ("you"), terse, technical. No first-person "I" outside the landing page's existing origin story (index.mdx).
- Bold key terms inline rather than long prose paragraphs. Bullet lists for enumerable facts.
- No marketing fluff, no invented numbers or stats. If a claim needs a number, it must be verifiable from an actual command/file at authoring time — prefer a stable qualitative claim instead, since counts drift.

## Structure
- Frontmatter: \`title\` (2-4 words) + one-sentence \`description\` that could stand alone as a search-result snippet.
- Use \`<Aside type="tip|note|caution|danger">\` (from '@astrojs/starlight/components') for gotchas/caveats — don't bury them in prose.
- Use \`<Badge text="desktop only">\` (or similar, variant="caution") on any platform-scoped feature, matching existing usage in guides/mock-server.mdx.
- Every page ends with \`## Related\` or \`## Next\` — 2 to 5 links, no more.
- Tables for anything with more than 3 comparable rows (ports, credentials, capability matrices) — don't turn a table into prose.

## What NOT to do
- Don't rewrite prose that's already clear and on-voice just to rewrite it. If a page is already at this bar, touch only its frontmatter/structure/cross-links.
- Don't add a link to the new Testing & Quality or Contributing sections into every page "for coverage" — only where it's genuinely relevant to what that page is about.
`;

const styleGuideResult = await agent(
  `Read ${ROOT}/docs-site/src/content/docs/guides/scripts.mdx and ${ROOT}/docs-site/src/content/docs/overview/what-is-restura.mdx as reference examples of the target voice — confirm the style guide below matches what you observe in them. Then write the exact text between ---BEGIN--- and ---END--- to ${STYLE_GUIDE_PATH}, verbatim, no changes:

---BEGIN---
${STYLE_GUIDE_CONTENT}
---END---

Return {path, status, notes}.`,
  { label: 'style-guide', schema: WRITE_RESULT_SCHEMA, phase: 'Style Guide' }
);

// ---------------------------------------------------------------------------
// Phase 3: Author (parallel — new pages, expansions, and the structural pass
// on remaining pages are all independent of each other once research + the
// style guide exist)
// ---------------------------------------------------------------------------
phase('Author');

const TESTING_SLUGS = [
  '/testing/overview/',
  '/testing/local-stack/',
  '/testing/unit-integration/',
  '/testing/end-to-end/',
  '/testing/security/',
  '/testing/contract-and-ci/',
];
const CONTRIBUTING_SLUGS = ['/contributing/overview/', '/contributing/dev-setup/'];

function pagePrompt(path, instructions) {
  return `Read the style guide at ${STYLE_GUIDE_PATH} first and follow it exactly for tone, frontmatter, and structure.

${instructions}

When done, return {path: "${path}", status: "written", notes: <one sentence>}.`;
}

const NEW_AND_EXPANDED_PAGES = [
  {
    path: `${DOCS}/testing/overview.mdx`,
    instructions: `Create the file (and its parent directory) at ${DOCS}/testing/overview.mdx. This is the ONLY trust-facing page in the new "Testing & Quality" section — everything else in the section is a contributor how-to. Audience: someone deciding whether to trust Restura's engineering quality, reading in under 2 minutes.

Content:
- Frontmatter: title "Testing & quality", one-sentence description.
- One short intro: Restura's test suite is layered (unit/integration -> contract -> security -> end-to-end web -> end-to-end desktop -> one CI gate), not just "trust us."
- One short paragraph per layer, each linking down: unit & integration (/testing/unit-integration/), contract tests & CI (/testing/contract-and-ci/), security (/testing/security/), end-to-end (/testing/end-to-end/). Also mention the local dev stack (/testing/local-stack/) as what makes desktop end-to-end testing against every protocol possible.
- Do not invent test counts or percentages.
- End with "## Related" linking to /architecture/security/ and /contributing/overview/.

Grounding facts (use only these, don't invent new ones):
${factsOr('securityTests')}
${factsOr('contractTests')}
${factsOr('unitIntegration')}
${factsOr('e2eWeb')}
${factsOr('e2eElectron')}
${factsOr('echoLocal')}`,
  },
  {
    path: `${DOCS}/testing/local-stack.mdx`,
    instructions: `Create ${DOCS}/testing/local-stack.mdx. Title "Local test stack", description mentioning echo-local. Audience: a contributor who wants to manually exercise a protocol against a real (not mocked) local upstream.

Content: what echo-local is and why it exists (the web-only echo Worker can't host native gRPC/real brokers/mTLS), the make setup / make echo-local / npm run echo:local commands, the full ports table (as a markdown table: Service | URL | Notes), TLS/mTLS/custom-CA setup, credentials (as a table), Docker-backed Kafka/MQTT, what the generated collection covers vs. what must be driven manually. End with "## Related" linking to /testing/end-to-end/ and /guides/mock-server/ (call out that mock-server is a different, in-app feature, not this).

Grounding facts:
${factsOr('echoLocal')}`,
  },
  {
    path: `${DOCS}/testing/unit-integration.mdx`,
    instructions: `Create ${DOCS}/testing/unit-integration.mdx. Title "Unit & integration tests". Content: Vitest in jsdom, the colocated *.test.ts(x) convention, tests/setup.ts, React Testing Library, and the exact npm scripts (test, test:run, test:watch, test:ui, test:coverage). End with "## Related" linking to /testing/end-to-end/ and /testing/contract-and-ci/.

Grounding facts:
${factsOr('unitIntegration')}`,
  },
  {
    path: `${DOCS}/testing/end-to-end.mdx`,
    instructions: `Create ${DOCS}/testing/end-to-end.mdx. Title "End-to-end tests". Content: explain there are TWO harnesses and why. Playwright web e2e (${'`e2e/`'}) boots the dev server, workers:1/fullyParallel:false because suites share dev-server state, real-*.spec.ts hit live upstreams/the echo Worker. e2e-electron launches the packaged desktop build via Playwright's _electron, needs the native gRPC dev server since the echo Worker's Connect endpoint is web-only, and Kafka/MQTT specs auto-bring-up Dockerised brokers via a fixture (skip if Docker absent). Give the exact npm commands for both. End with "## Related" linking to /testing/local-stack/ and /testing/unit-integration/.

Grounding facts:
${factsOr('e2eWeb')}
${factsOr('e2eElectron')}`,
  },
  {
    path: `${DOCS}/testing/security.mdx`,
    instructions: `Create ${DOCS}/testing/security.mdx. Title "Security tests". Content: one line per file in tests/security/ (what regression it guards), presented as a table (File | Guards against). End with "## Related" linking to /architecture/security/.

Grounding facts:
${factsOr('securityTests')}`,
  },
  {
    path: `${DOCS}/testing/contract-and-ci.mdx`,
    instructions: `Create ${DOCS}/testing/contract-and-ci.mdx. Title "Contract tests & CI". Content: what tests/contract/ verifies (the shared protocol core against a real upstream, independent of backend), verify:opencollection-types and capabilities:check as codegen-drift gates, then npm run validate as the single CI gate — link to the root CI_CD.md doc on GitHub (https://github.com/dipjyotimetia/restura/blob/main/docs/CI_CD.md) for the full pipeline rather than re-describing it. End with "## Related" linking to /contributing/overview/.

Grounding facts:
${factsOr('contractTests')}
${factsOr('ciAndValidate')}`,
  },
  {
    path: `${DOCS}/contributing/overview.mdx`,
    instructions: `Create ${DOCS}/contributing/overview.mdx. Title "Contributing". Content: summarize (don't re-host) CONTRIBUTING.md — Code of Conduct, branch naming, commit format, PR process — and link to it on GitHub (https://github.com/dipjyotimetia/restura/blob/main/CONTRIBUTING.md). End with "## Related" linking to /contributing/dev-setup/ and /testing/overview/.

Grounding facts:
${factsOr('contributingProcess')}`,
  },
  {
    path: `${DOCS}/contributing/dev-setup.mdx`,
    instructions: `Create ${DOCS}/contributing/dev-setup.mdx. Title "Development setup". Content: Node >=24, npm install, the core dev commands (dev, build, test, lint, format, validate), and the type-check vs type-check:all gotcha (state exactly what tsconfig.json excludes, per the grounding facts below — don't assume). End with "## Related" linking to /testing/overview/ and /contributing/overview/.

Grounding facts:
${factsOr('devSetup')}`,
  },
  {
    path: `${DOCS}/protocols/socket-io.mdx`,
    instructions: `Expand the EXISTING file at ${DOCS}/protocols/socket-io.mdx (read it first) to match the depth of ${DOCS}/protocols/http.mdx (read that too for the target depth/structure). Keep its accurate existing claims; add real depth: auth interplay, common gotchas, and a link to the matching echo-local Socket.IO port for hands-on testing (see grounding facts). Keep frontmatter title/description. End with "## Related".

Grounding facts (echo-local Socket.IO port):
${factsOr('echoLocal')}`,
  },
  {
    path: `${DOCS}/protocols/sse.mdx`,
    instructions: `Expand the EXISTING file at ${DOCS}/protocols/sse.mdx (read it first) to match the depth of ${DOCS}/protocols/http.mdx (read that too). Keep accurate existing claims; add real depth: reconnection behavior, common gotchas, and a link to the matching echo-local SSE testing path if one exists in the grounding facts (if none, omit rather than invent). End with "## Related".

Grounding facts:
${factsOr('echoLocal')}`,
  },
  {
    path: `${DOCS}/protocols/graphql.mdx`,
    instructions: `Expand the EXISTING file at ${DOCS}/protocols/graphql.mdx (read it first) to match the depth of ${DOCS}/protocols/http.mdx (read that too). Keep accurate existing claims; add real depth: subscriptions, auth interplay, and a link to the matching echo-local GraphQL testing path from the grounding facts (it's served over the HTTP endpoint per the echo-local ports table — verify and state correctly, don't guess). End with "## Related".

Grounding facts:
${factsOr('echoLocal')}`,
  },
];

const BATCH_GROUPS = [
  {
    label: 'batch:overview',
    files: [
      'overview/what-is-restura.mdx',
      'overview/install.mdx',
      'overview/quick-start.mdx',
      'overview/platforms.mdx',
      'overview/comparison.mdx',
    ],
  },
  {
    label: 'batch:protocols-remaining',
    files: [
      'protocols/http.mdx',
      'protocols/grpc.mdx',
      'protocols/kafka.mdx',
      'protocols/mcp.mdx',
      'protocols/mqtt.mdx',
      'protocols/websocket.mdx',
    ],
  },
  {
    label: 'batch:guides-1',
    files: [
      'guides/ai-assistant.mdx',
      'guides/ai-lab.mdx',
      'guides/auth.mdx',
      'guides/browser-capture.mdx',
      'guides/collections.mdx',
      'guides/electron-updates.mdx',
      'guides/environments.mdx',
      'guides/import-export.mdx',
    ],
  },
  {
    label: 'batch:guides-2',
    files: [
      'guides/keyboard-shortcuts.mdx',
      'guides/load-testing.mdx',
      'guides/mcp-server-mode.mdx',
      'guides/mock-server.mdx',
      'guides/scripts.mdx',
      'guides/vscode-extension.mdx',
      'guides/workflows.mdx',
    ],
  },
  {
    label: 'batch:architecture-core',
    files: [
      'architecture/overview.mdx',
      'architecture/shared-protocol.mdx',
      'architecture/security.mdx',
    ],
  },
  {
    label: 'batch:adrs-1',
    files: [
      'architecture/adrs.mdx',
      'architecture/adrs/0001-shared-protocol-layer.mdx',
      'architecture/adrs/0002-multi-tab-store.mdx',
      'architecture/adrs/0003-streaming-and-http2.mdx',
      'architecture/adrs/0004-security-hardening.mdx',
      'architecture/adrs/0005-cli-runner.mdx',
      'architecture/adrs/0006-connection-and-dns-hardening.mdx',
      'architecture/adrs/0007-secret-ref-pattern.mdx',
      'architecture/adrs/0008-opencollection-native-format.mdx',
      'architecture/adrs/0009-shared-hono-app-factory.mdx',
      'architecture/adrs/0010-ai-assistant-architecture.mdx',
      'architecture/adrs/0011-mcp-server-mode.mdx',
      'architecture/adrs/0012-capability-matrix-source-of-truth.mdx',
      'architecture/adrs/0013-hash-routing.mdx',
    ],
  },
  {
    label: 'batch:adrs-2',
    files: [
      'architecture/adrs/0014-zustand-persistence.mdx',
      'architecture/adrs/0015-quickjs-script-sandbox.mdx',
      'architecture/adrs/0016-wire-level-auth-signing.mdx',
      'architecture/adrs/0017-runtime-platform-detection.mdx',
      'architecture/adrs/0018-rate-limiting-strategy.mdx',
      'architecture/adrs/0019-response-viewer-architecture.mdx',
      'architecture/adrs/0020-ai-lab-eval-workbench.mdx',
      'architecture/adrs/0021-maintenance-harness.mdx',
      'architecture/adrs/0022-grpc-connectrpc-transport.mdx',
      'architecture/adrs/0023-ai-lab-http-exec.mdx',
      'architecture/adrs/0024-browser-capture-extension.mdx',
      'architecture/adrs/0025-vscode-extension.mdx',
      'architecture/adrs/0026-electron-csp-and-permission-hardening.mdx',
    ],
  },
  {
    label: 'batch:self-hosting-and-reference',
    files: [
      'self-hosting/docker.mdx',
      'self-hosting/reverse-proxy.mdx',
      'reference/capability-matrix.mdx',
      'reference/api.mdx',
      'reference/cli.mdx',
      'reference/opencollection.mdx',
      'reference/postman-compat.mdx',
    ],
  },
];

function batchPrompt(files) {
  const paths = files.map((f) => `${DOCS}/${f}`);
  return `Read the style guide at ${STYLE_GUIDE_PATH} first. Then, for EACH of these files, read it and:
1. Ensure frontmatter has a title (2-4 words) and a one-sentence description.
2. Ensure it ends with "## Related" or "## Next" (2-5 links) — add one if missing, using only genuinely relevant links (don't invent a link that doesn't fit).
3. If — and only if — there is a natural, non-forced link to the new Testing & Quality section (${TESTING_SLUGS.join(', ')}) or Contributing section (${CONTRIBUTING_SLUGS.join(', ')}), add ONE such link. Do not add one to every file "for coverage."
4. Do NOT rewrite prose that is already clear and on-voice — this is a structural/link pass, not a content rewrite. Leave everything else in the file unchanged.

Files:
${paths.map((p) => `- ${p}`).join('\n')}

Return {results: [{file, changed, note}, ...]} — one entry per file, in the same order.`;
}

const authorTasks = [
  ...NEW_AND_EXPANDED_PAGES.map((p) => ({
    kind: 'page',
    run: () =>
      agent(pagePrompt(p.path, p.instructions), {
        label: `author:${p.path.split('/').slice(-2).join('/')}`,
        schema: WRITE_RESULT_SCHEMA,
        phase: 'Author',
      }),
  })),
  ...BATCH_GROUPS.map((g) => ({
    kind: 'batch',
    label: g.label,
    run: () =>
      agent(batchPrompt(g.files), { label: g.label, schema: BATCH_RESULT_SCHEMA, phase: 'Author' }),
  })),
  {
    kind: 'sidebar-and-landing',
    run: () =>
      agent(
        `Two changes in ${ROOT}/docs-site:

1. In ${ROOT}/docs-site/astro.config.mjs, inside the starlight() "sidebar" array: add a new top-level group "Testing & Quality" (collapsed: false) positioned right after the "Architecture" group and before the "Self-hosting" group, with items: Overview (/testing/overview/), Local test stack (/testing/local-stack/), Unit & integration tests (/testing/unit-integration/), End-to-end tests (/testing/end-to-end/), Security tests (/testing/security/), Contract tests & CI (/testing/contract-and-ci/). Also add a new top-level group "Contributing" (collapsed: false) after the "Reference" group, with items: Overview (/contributing/overview/), Development setup (/contributing/dev-setup/). Match the exact object shape used by the other groups in this file (read a couple of existing groups first, e.g. "Self-hosting" and "Reference," and copy their structure precisely).

2. In ${ROOT}/docs-site/src/content/docs/index.mdx: add ONE new <Card> to the existing "Why Restura" <CardGrid> — title something like "Tested like it matters", an appropriate icon (e.g. icon="seti:check"), one sentence pointing at the layered test suite, linking to /testing/overview/. Add ONE new <LinkCard> to the existing "Up next" <CardGrid> pointing to /contributing/overview/ with a one-sentence description. Do not change the hero, tagline, or any other existing content on this page.

Read both files first before editing. Return {path: "astro.config.mjs + index.mdx", status: "written", notes: <summary of what you added>}.`,
        { label: 'sidebar-and-landing', schema: WRITE_RESULT_SCHEMA, phase: 'Author' }
      ),
  },
];

const authorResults = await parallel(authorTasks.map((t) => t.run));

// ---------------------------------------------------------------------------
// Phase 4: Consistency verify (parallel)
// ---------------------------------------------------------------------------
phase('Verify');

const verifyResults = await parallel([
  () =>
    agent(
      `Walk every *.mdx file under ${DOCS}. For each internal markdown link you find (e.g. "](/protocols/http/)"), confirm the target slug resolves to an actual file under ${DOCS} (accounting for Starlight's trailing-slash convention — a link to /testing/overview/ should resolve to ${DOCS}/testing/overview.mdx). Separately, for the six new files under ${DOCS}/testing/, re-check every file path, command, and port number they cite against the real repository at ${ROOT} (e.g. grep for the command in package.json, confirm the file exists) — flag anything that doesn't match reality. Return {findings: [{file, issue, fix}]} for every broken link or unverifiable claim found; return {findings: []} if none.`,
      { label: 'verify:links-and-facts', schema: FINDINGS_SCHEMA, phase: 'Verify' }
    ),
  () =>
    agent(
      `Read the style guide at ${STYLE_GUIDE_PATH}. Then spot-check these files against it: all 8 new pages under ${DOCS}/testing/ and ${DOCS}/contributing/, the 3 expanded pages (${DOCS}/protocols/socket-io.mdx, ${DOCS}/protocols/sse.mdx, ${DOCS}/protocols/graphql.mdx), plus 10 files chosen from across ${DOCS}/guides/, ${DOCS}/architecture/, ${DOCS}/overview/ that were part of the structural pass. Check: frontmatter shape (title 2-4 words + one-sentence description), presence of a closing "## Related" or "## Next" section, no first-person "I" outside index.mdx, no invented numbers/stats. Return {findings: [{file, issue, fix}]}; return {findings: []} if none.`,
      { label: 'verify:style-compliance', schema: FINDINGS_SCHEMA, phase: 'Verify' }
    ),
]);

const allFindings = verifyResults
  .filter(Boolean)
  .flatMap((r) => r.findings)
  .filter(Boolean);

log(`Verify phase found ${allFindings.length} issue(s) to fix.`);

// ---------------------------------------------------------------------------
// Phase 5: Fix
// ---------------------------------------------------------------------------
phase('Fix');

const fixResults = allFindings.length
  ? await parallel(
      allFindings.map(
        (f) => () =>
          agent(
            `In the file ${f.file} (relative to ${ROOT}/docs-site/src/content/docs/ unless it's already an absolute path), fix this specific issue: ${f.issue}. Suggested fix: ${f.fix}. Read the file first, make the minimal change that resolves the issue, don't touch anything else in the file. Return {path: "${f.file}", status: "written", notes: <what you changed>}.`,
            { label: `fix:${f.file}`, schema: WRITE_RESULT_SCHEMA, phase: 'Fix' }
          )
      )
    )
  : [];

return {
  researchTopicsCompleted: research.filter(Boolean).length,
  researchTopicsTotal: RESEARCH_TOPICS.length,
  styleGuideWritten: styleGuideResult?.status === 'written',
  authorTasksCompleted: authorResults.filter(Boolean).length,
  authorTasksTotal: authorTasks.length,
  findingsCount: allFindings.length,
  fixesApplied: fixResults.filter(Boolean).length,
};
```

- [ ] **Step 2: Wait for the workflow to complete**

The Workflow runs in the background; do not poll. Continue when the `task-notification` arrives.

- [ ] **Step 3: Inspect the returned result**

Read the object the script returned (visible in the tool result / journal). Confirm:

- `researchTopicsCompleted === researchTopicsTotal` (9). If not, the missing topic's page(s) were written with a fallback "re-derive from source" note — go read that page and fix it manually using the real source file before proceeding.
- `styleGuideWritten === true`.
- `authorTasksCompleted === authorTasksTotal` (20: 11 new/expanded pages [8 new + 3 expanded protocol pages] + 8 batch groups + 1 sidebar/landing task). If any author task returned `null` (a subagent died on a terminal API error), that page/batch was NOT written — identify which one from the journal and re-run it as a standalone `Agent` call with the same prompt before moving on. Don't silently drop it.
- `findingsCount` and `fixesApplied` — if `fixesApplied < findingsCount`, some fixes failed; check the journal for which findings didn't get a result and apply them manually.

- [ ] **Step 4: Commit**

```bash
cd <WORKTREE_ROOT>
git add -A
git commit -m "$(cat <<'EOF'
docs: add Testing & Quality and Contributing sections to docs-site

Adds a layered test-suite overview plus contributor how-to pages for
echo-local, unit/integration, end-to-end (web + desktop), security, and
contract/CI testing. Expands three thin protocol pages and brings the
rest of docs-site to a shared style bar with cross-links into the new
sections.
EOF
)"
```

---

## Task 3: Outer build-verification gate

**Files:** any files fixed as a result of build failures (exact paths depend on what fails — none known in advance).

**Interfaces:**

- Consumes: the committed state from Task 2.

- [ ] **Step 1: Run the content/type check**

```bash
cd <WORKTREE_ROOT>/docs-site && npm run check
```

Expected: exit 0. If it fails, the error output names the file and issue (e.g. malformed frontmatter, invalid MDX). Open that file with Read, fix with Edit, re-run this exact command until it passes.

- [ ] **Step 2: Run the production build**

```bash
cd <WORKTREE_ROOT>/docs-site && npm run build
```

Expected: exit 0, all pages rendered (Starlight fails the build on a broken internal link or invalid frontmatter — this is the most likely failure mode given the volume of new/moved pages per spec §9). If a specific broken link is reported, grep the target slug against `docs-site/src/content/docs/` to find the correct path and fix the link with Edit.

- [ ] **Step 3: Repeat until both are green**

Re-run Steps 1 and 2 after every fix until both commands exit 0 with no errors.

- [ ] **Step 4: Commit any fixes (skip if nothing needed fixing)**

```bash
cd <WORKTREE_ROOT>
git add -A
git commit -m "fix: resolve docs-site check/build failures"
```

---

## Task 4: Manual visual spot-check

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

```bash
cd <WORKTREE_ROOT>/docs-site && npm run dev
```

Runs on `http://localhost:4321`. Run this in the background (or a separate terminal) so subsequent steps can navigate to it.

- [ ] **Step 2: Check the new Testing & Quality pages render with the existing design system**

Using a browser tool, navigate to:

- `http://localhost:4321/testing/overview/` — confirm glass-card styling, no unstyled/raw content, all six layer links resolve.
- `http://localhost:4321/testing/local-stack/` — confirm the ports table renders with the site's table styling (rounded corners, header background per `custom.css`).

- [ ] **Step 3: Check an expanded protocol page**

Navigate to `http://localhost:4321/protocols/socket-io/` — confirm the expanded content displays correctly and the new Related/Next links resolve.

- [ ] **Step 4: Check the landing page additions**

Navigate to `http://localhost:4321/` — confirm the new "Tested like it matters" card appears in the "Why Restura" grid with the same glass/hover treatment as its siblings, and the new Contributing `LinkCard` appears in "Up next". Confirm the hero/tagline/protocol grid are unchanged.

- [ ] **Step 5: Check the Contributing section**

Navigate to `http://localhost:4321/contributing/overview/` — confirm it renders and its link to `CONTRIBUTING.md` on GitHub is correct (opens in a new context, not embedded).

- [ ] **Step 6: Stop the dev server**

Stop the background dev server process.

---

## Task 5: Final review and wrap-up

**Files:** none.

- [ ] **Step 1: Confirm a clean worktree state**

```bash
cd <WORKTREE_ROOT> && git status
```

Expected: clean (everything committed in Tasks 2-3).

- [ ] **Step 2: Review commit history**

```bash
cd <WORKTREE_ROOT> && git log --oneline -5
```

Expected: the docs-site commit(s) from Tasks 2 and 3 (if any fixes were needed).

- [ ] **Step 3: Report to the user**

Summarize: worktree path, branch name, list of new pages, list of expanded pages, count of existing pages touched in the structural pass, and confirmation that `npm run check` + `npm run build` are green. State explicitly that nothing has been pushed, no PR opened, and no merge to `main` — ask how they'd like to proceed (push + open a PR, keep the worktree for further review, or something else). Do not take any of those actions without an explicit answer.
