import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

export default defineConfig({
  site: 'https://docs.restura.dev',
  // Astro 7 defaults to the Rust-based Sätteri Markdown processor, which does not
  // run remark/rehype plugins. astro-mermaid relies on a rehype plugin to turn
  // ```mermaid code blocks into rendered diagrams, so opt back into the unified
  // pipeline — astro-mermaid detects this processor and injects its plugins.
  markdown: {
    processor: unified(),
  },
  integrations: [
    mermaid({
      theme: 'forest',
      autoTheme: true,
    }),
    starlight({
      title: 'Restura Docs',
      components: {
        Footer: './src/components/Footer.astro',
      },
      description:
        'The API client that speaks every protocol — HTTP, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MCP. Web · Desktop · Self-hosted.',
      logo: {
        src: './public/favicon.svg',
        replacesTitle: false,
      },
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/dipjyotimetia/restura',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/dipjyotimetia/restura/edit/main/docs-site/',
      },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      head: [
        // Social cards. Use a rasterised PNG — Twitter/Facebook/LinkedIn/Slack/
        // Discord scrapers do not render SVG og:images. Dimensions + type help
        // crawlers lay out the card without fetching the bytes first.
        {
          tag: 'meta',
          attrs: { property: 'og:type', content: 'website' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://docs.restura.dev/og-image.png' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:type', content: 'image/png' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:width', content: '1200' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image:height', content: '630' },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'Restura — the API client that speaks every protocol',
          },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: 'https://docs.restura.dev/og-image.png' },
        },
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'What is Restura?', slug: 'overview/what-is-restura' },
            { label: 'Install', slug: 'overview/install' },
            { label: 'Quick start', slug: 'overview/quick-start' },
            { label: 'Platforms', slug: 'overview/platforms' },
            { label: 'vs other API clients', slug: 'overview/comparison' },
          ],
        },
        {
          label: 'Protocols',
          items: [
            { label: 'HTTP / REST', slug: 'protocols/http' },
            { label: 'GraphQL', slug: 'protocols/graphql' },
            { label: 'gRPC', slug: 'protocols/grpc' },
            { label: 'WebSocket', slug: 'protocols/websocket' },
            { label: 'Socket.IO', slug: 'protocols/socket-io' },
            { label: 'Server-Sent Events', slug: 'protocols/sse' },
            { label: 'Kafka', slug: 'protocols/kafka' },
            { label: 'MQTT', slug: 'protocols/mqtt' },
            { label: 'MCP', slug: 'protocols/mcp' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Authentication', slug: 'guides/auth' },
            { label: 'Collections', slug: 'guides/collections' },
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'Workflows', slug: 'guides/workflows' },
            { label: 'Scripts', slug: 'guides/scripts' },
            { label: 'Load testing', slug: 'guides/load-testing' },
            { label: 'Mock server', slug: 'guides/mock-server' },
            { label: 'AI assistant', slug: 'guides/ai-assistant' },
            { label: 'AI Lab', slug: 'guides/ai-lab' },
            { label: 'MCP server mode', slug: 'guides/mcp-server-mode' },
            { label: 'Desktop updates', slug: 'guides/electron-updates' },
            { label: 'Keyboard shortcuts', slug: 'guides/keyboard-shortcuts' },
            { label: 'Import & export', slug: 'guides/import-export' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Shared protocol layer', slug: 'architecture/shared-protocol' },
            { label: 'Security model', slug: 'architecture/security' },
            {
              label: 'Design decisions (ADRs)',
              collapsed: false,
              items: [
                { label: 'ADR index', slug: 'architecture/adrs' },
                {
                  label: '0001 — Shared protocol layer',
                  slug: 'architecture/adrs/0001-shared-protocol-layer',
                },
                { label: '0002 — Multi-tab store', slug: 'architecture/adrs/0002-multi-tab-store' },
                {
                  label: '0003 — Streaming + HTTP/2',
                  slug: 'architecture/adrs/0003-streaming-and-http2',
                },
                {
                  label: '0004 — Security hardening',
                  slug: 'architecture/adrs/0004-security-hardening',
                },
                { label: '0005 — CLI runner', slug: 'architecture/adrs/0005-cli-runner' },
                {
                  label: '0006 — Connection + DNS hardening',
                  slug: 'architecture/adrs/0006-connection-and-dns-hardening',
                },
                {
                  label: '0007 — SecretRef pattern',
                  slug: 'architecture/adrs/0007-secret-ref-pattern',
                },
                {
                  label: '0008 — OpenCollection native format',
                  slug: 'architecture/adrs/0008-opencollection-native-format',
                },
                {
                  label: '0009 — Shared Hono app factory',
                  slug: 'architecture/adrs/0009-shared-hono-app-factory',
                },
                {
                  label: '0010 — AI assistant architecture',
                  slug: 'architecture/adrs/0010-ai-assistant-architecture',
                },
                {
                  label: '0011 — Restura as an MCP server',
                  slug: 'architecture/adrs/0011-mcp-server-mode',
                },
                {
                  label: '0012 — Capability matrix source of truth',
                  slug: 'architecture/adrs/0012-capability-matrix-source-of-truth',
                },
                { label: '0013 — Hash routing', slug: 'architecture/adrs/0013-hash-routing' },
                {
                  label: '0014 — Zustand persistence',
                  slug: 'architecture/adrs/0014-zustand-persistence',
                },
                {
                  label: '0015 — QuickJS script sandbox',
                  slug: 'architecture/adrs/0015-quickjs-script-sandbox',
                },
                {
                  label: '0016 — Wire-level auth signing',
                  slug: 'architecture/adrs/0016-wire-level-auth-signing',
                },
                {
                  label: '0017 — Runtime platform detection',
                  slug: 'architecture/adrs/0017-runtime-platform-detection',
                },
                {
                  label: '0018 — Rate limiting strategy',
                  slug: 'architecture/adrs/0018-rate-limiting-strategy',
                },
                {
                  label: '0019 — Response viewer architecture',
                  slug: 'architecture/adrs/0019-response-viewer-architecture',
                },
                {
                  label: '0020 — AI Lab eval workbench',
                  slug: 'architecture/adrs/0020-ai-lab-eval-workbench',
                },
                {
                  label: '0021 — Maintenance harness',
                  slug: 'architecture/adrs/0021-maintenance-harness',
                },
                {
                  label: '0022 — gRPC over ConnectRPC',
                  slug: 'architecture/adrs/0022-grpc-connectrpc-transport',
                },
              ],
            },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Docker', slug: 'self-hosting/docker' },
            { label: 'Reverse proxy', slug: 'self-hosting/reverse-proxy' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Capability matrix', slug: 'reference/capability-matrix' },
            { label: 'API', slug: 'reference/api' },
            { label: 'CLI (@restura/cli)', slug: 'reference/cli' },
            { label: 'OpenCollection', slug: 'reference/opencollection' },
            { label: 'Postman compatibility', slug: 'reference/postman-compat' },
          ],
        },
      ],
    }),
  ],
});
