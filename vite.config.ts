import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

// Read package.json for version
const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isElectronBuild = mode === 'electron' || env.ELECTRON_BUILD === 'true';

  return {
    plugins: [react()],

    // Base URL for assets - use relative paths for Electron
    base: isElectronBuild ? './' : '/',

    // Path aliases
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    // Environment variables
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version || '0.1.0'),
      'import.meta.env.VITE_IS_ELECTRON_BUILD': JSON.stringify(isElectronBuild ? 'true' : 'false'),
    },

    // Build configuration
    build: {
      outDir: isElectronBuild ? 'out' : 'dist',
      emptyOutDir: true,
      sourcemap: !isElectronBuild,
      // Optimize chunk sizes
      rollupOptions: {
        output: {
          manualChunks: {
            'monaco-editor': ['monaco-editor', '@monaco-editor/react'],
            'radix-ui': [
              '@radix-ui/react-accordion',
              '@radix-ui/react-alert-dialog',
              '@radix-ui/react-checkbox',
              '@radix-ui/react-context-menu',
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-hover-card',
              '@radix-ui/react-label',
              '@radix-ui/react-popover',
              '@radix-ui/react-progress',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
              '@radix-ui/react-switch',
              '@radix-ui/react-tabs',
              '@radix-ui/react-tooltip',
            ],
            'grpc': ['@bufbuild/protobuf', '@connectrpc/connect', '@connectrpc/connect-web'],
            'vendor': ['react', 'react-dom', 'zustand', 'zod'],
          },
        },
        // Externalize electron for Electron builds
        external: isElectronBuild ? ['electron'] : [],
      },
    },

    // Dev server configuration
    server: {
      port: 5173,
      strictPort: true,
      // Proxy API routes to Express server in web mode (when running)
      proxy: !isElectronBuild
        ? {
            '/api': {
              target: 'http://localhost:3001',
              changeOrigin: true,
            },
          }
        : undefined,
    },

    // Preview server configuration
    preview: {
      port: 4173,
    },

    // Optimize dependencies
    optimizeDeps: {
      include: ['react', 'react-dom', 'zustand', 'lucide-react'],
      exclude: isElectronBuild ? ['electron'] : [],
    },

    // CSS configuration
    css: {
      postcss: './postcss.config.cjs',
    },
  };
});
