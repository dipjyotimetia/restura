import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

// Read package.json for version
const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isElectronBuild = mode === 'electron' || env.ELECTRON_BUILD === 'true';
  const isDev = mode === 'development';

  return {
    plugins: [
      react({
        // React 19 + React Compiler preparation
        babel: {
          plugins: [
            // Uncomment when babel-plugin-react-compiler is stable:
            // ['babel-plugin-react-compiler', { target: '19' }],
          ],
        },
      }),
    ],

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
      '__APP_VERSION__': JSON.stringify(packageJson.version || '0.1.0'),
      '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
    },

    // Build configuration - Vite 7 best practices
    build: {
      outDir: isElectronBuild ? 'out' : 'dist',
      emptyOutDir: true,

      // Target modern browsers with ES modules support
      // Note: 'baseline-widely-available' is planned for Vite 7, using 'esnext' for now
      target: 'esnext',

      // Source maps for debugging (hidden in prod for security)
      sourcemap: isDev ? true : (isElectronBuild ? false : 'hidden'),

      // Minification
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: !isDev,
          drop_debugger: !isDev,
        },
      },

      // CSS code splitting
      cssCodeSplit: true,

      // Chunk size warning threshold (1MB)
      chunkSizeWarningLimit: 1000,

      // Report compressed size
      reportCompressedSize: true,

      // Asset inline limit (4KB)
      assetsInlineLimit: 4096,

      // Rollup options for chunk splitting
      rollupOptions: {
        output: {
          // Dynamic chunk splitting function for better optimization
          manualChunks(id) {
            // Node modules splitting
            if (id.includes('node_modules')) {
              // React ecosystem
              if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) {
                return 'vendor-react';
              }

              // Monaco Editor (large bundle)
              if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
                return 'vendor-monaco';
              }

              // Radix UI components
              if (id.includes('@radix-ui')) {
                return 'vendor-radix';
              }

              // gRPC/Protobuf libraries
              if (id.includes('@bufbuild') || id.includes('@connectrpc')) {
                return 'vendor-grpc';
              }

              // State management
              if (id.includes('zustand') || id.includes('immer')) {
                return 'vendor-state';
              }

              // Validation
              if (id.includes('zod')) {
                return 'vendor-validation';
              }

              // Icons
              if (id.includes('lucide-react')) {
                return 'vendor-icons';
              }

              // Animation
              if (id.includes('framer-motion')) {
                return 'vendor-animation';
              }

              // QuickJS (WASM)
              if (id.includes('quickjs-emscripten')) {
                return 'vendor-quickjs';
              }

              // Other vendor libraries
              return 'vendor-other';
            }

            // Feature-based code splitting
            if (id.includes('/features/')) {
              const match = id.match(/\/features\/(\w+)\//);
              if (match) {
                return `feature-${match[1]}`;
              }
            }

            // Components splitting
            if (id.includes('/components/shared/')) {
              return 'shared-components';
            }

            return undefined;
          },

          // Optimized file naming
          chunkFileNames: 'chunks/[name]-[hash].js',
          entryFileNames: '[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            const name = assetInfo.name || '';
            // Fonts
            if (/\.(woff2?|eot|ttf|otf)$/i.test(name)) {
              return 'fonts/[name]-[hash][extname]';
            }
            // Images
            if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name)) {
              return 'images/[name]-[hash][extname]';
            }
            // WASM files
            if (/\.wasm$/i.test(name)) {
              return 'wasm/[name]-[hash][extname]';
            }
            // CSS
            if (/\.css$/i.test(name)) {
              return 'styles/[name]-[hash][extname]';
            }
            return 'assets/[name]-[hash][extname]';
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
      // Enable HMR
      hmr: {
        overlay: true,
      },
      // Proxy API routes to Express server in web mode
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

    // Optimize dependencies - Vite 7 best practices
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'zustand',
        'lucide-react',
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-tabs',
        '@radix-ui/react-tooltip',
        'framer-motion',
        'zod',
      ],
      exclude: isElectronBuild ? ['electron'] : [],
      // Force pre-bundling for ESM packages
      esbuildOptions: {
        target: 'esnext',
      },
    },

    // CSS configuration
    css: {
      postcss: './postcss.config.cjs',
      // CSS modules configuration
      modules: {
        localsConvention: 'camelCase',
      },
    },

    // Esbuild options for faster dev builds
    esbuild: {
      // Remove console/debugger in production
      drop: isDev ? [] : ['console', 'debugger'],
      // Legal comments handling
      legalComments: 'none',
    },
  };
});
