import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Restura - Multi-Protocol API Testing Tool',
    short_name: 'Restura',
    description: 'A modern API client for testing HTTP, GraphQL, gRPC, and WebSocket endpoints.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#6366f1',
    orientation: 'portrait',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
    categories: ['developer tools', 'productivity', 'utilities'],
  };
}
