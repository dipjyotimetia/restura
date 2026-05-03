import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';

const isElectronBuild = process.env.VITE_IS_ELECTRON_BUILD === 'true';

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    ...(isElectronBuild ? [] : [cloudflare()]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/web',
    assetsDir: 'assets',
    sourcemap: true,
    ...(isElectronBuild && { target: 'esnext' }),
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env.npm_package_version || '0.1.0'
    ),
    'import.meta.env.VITE_IS_ELECTRON_BUILD': JSON.stringify(
      isElectronBuild ? 'true' : 'false'
    ),
  },
  ...(isElectronBuild && { base: './' }),
  optimizeDeps: {
    exclude: ['quickjs-emscripten'],
  },
});
