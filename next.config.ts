import type { NextConfig } from 'next';

const isElectronBuild = process.env.ELECTRON_BUILD === 'true';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Environment variables accessible in the browser
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version || '0.1.0',
    NEXT_PUBLIC_IS_ELECTRON_BUILD: isElectronBuild ? 'true' : 'false',
  },

  // Enable static export for Electron builds
  ...(isElectronBuild && {
    output: 'export',
    // For Electron, we need to handle file:// protocol
    assetPrefix: './',
    // Disable image optimization for static export
    images: {
      unoptimized: true,
    },
    // Use trailing slashes for proper file:// routing
    trailingSlash: true,
    // Disable server-side features for static export
    distDir: 'out',
  }),

  // Web-specific configuration
  ...(!isElectronBuild && {
    // Enable image optimization for web
    images: {
      remotePatterns: [
        {
          protocol: 'https',
          hostname: '**',
        },
      ],
    },
    // Security headers for web deployment
    async headers() {
      return [
        {
          source: '/(.*)',
          headers: [
            {
              key: 'X-Frame-Options',
              value: 'DENY',
            },
            {
              key: 'X-Content-Type-Options',
              value: 'nosniff',
            },
            {
              key: 'Referrer-Policy',
              value: 'strict-origin-when-cross-origin',
            },
            {
              key: 'Permissions-Policy',
              value: 'camera=(), microphone=(), geolocation=()',
            },
          ],
        },
      ];
    },
  }),

  // Turbopack configuration (empty to silence warning)
  turbopack: {},

  // Enable Monaco Editor webpack configuration
  webpack: (config, { isServer }) => {
    // Handle .ttf fonts for Monaco Editor
    config.module.rules.push({
      test: /\.ttf$/,
      type: 'asset/resource',
    });

    // Electron-specific webpack config
    if (isElectronBuild && !isServer) {
      // Exclude electron from client bundle
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push('electron');
      }
    }

    return config;
  },

  // Experimental features
  experimental: {
    // Enable optimized package imports
    optimizePackageImports: ['lucide-react', '@radix-ui/react-icons'],
  },
};

export default nextConfig;
