import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

export default defineConfig({
  site: 'https://docs.restura.dev',
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
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://docs.restura.dev/og-image.svg' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
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
            { label: 'AI assistant', slug: 'guides/ai-assistant' },
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
            { label: 'Security design', slug: 'architecture/security-design' },
            {
              label: 'Design decisions (ADRs)',
              collapsed: false,
              items: [
                { label: 'ADR index', slug: 'architecture/adrs' },
                { label: '0001 — Shared protocol layer', slug: 'architecture/adrs/0001-shared-protocol-layer' },
                { label: '0002 — Multi-tab store', slug: 'architecture/adrs/0002-multi-tab-store' },
                { label: '0003 — Streaming + HTTP/2', slug: 'architecture/adrs/0003-streaming-and-http2' },
                { label: '0004 — Security hardening', slug: 'architecture/adrs/0004-security-hardening' },
                { label: '0005 — CLI runner', slug: 'architecture/adrs/0005-cli-runner' },
                { label: '0006 — Connection + DNS hardening', slug: 'architecture/adrs/0006-connection-and-dns-hardening' },
                { label: '0007 — SecretRef pattern', slug: 'architecture/adrs/0007-secret-ref-pattern' },
                {
                  label: '0008 — Keystore + renderer hardening',
                  slug: 'architecture/adrs/0008-keystore-and-renderer-hardening',
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
