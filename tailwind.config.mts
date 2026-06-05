import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', 'Geist', '-apple-system', 'BlinkMacSystemFont', '"Helvetica Neue"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'ui-monospace', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Semantic surface elevation colors (legacy — Phase 11 cleanup)
        surface: {
          0: 'hsl(var(--surface-0))',
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
        },
        // ─────────────────────────────────────────────────────────────
        // Spatial Depth tokens. Use as: bg-sp-surface, text-sp-muted, etc.
        // CSS vars defined in src/styles/globals.css (:root + .dark)
        // ─────────────────────────────────────────────────────────────
        sp: {
          bg: 'var(--sp-bg)',
          surface: 'var(--sp-surface)',
          'surface-hi': 'var(--sp-surface-hi)',
          'surface-lo': 'var(--sp-surface-lo)',
          text: 'var(--sp-text)',
          muted: 'var(--sp-text-muted)',
          dim: 'var(--sp-text-dim)',
          line: 'var(--sp-line)',
          'line-strong': 'var(--sp-line-strong)',
          accent: 'var(--sp-accent)',
          code: 'var(--sp-code)',
          hover: 'var(--sp-hover-bg)',
          active: 'var(--sp-active-bg)',
        },
        // Method color table (per handoff §method colors)
        method: {
          get: '#22c55e',
          post: '#f59e0b',
          put: '#3b82f6',
          patch: '#a855f7',
          delete: '#ef4444',
          head: '#06b6d4',
          options: '#94a3b8',
          ws: '#a78bfa',
          sse: '#06b6d4',
          mcp: '#f59e0b',
          gql: '#e879a4',
        },
        // Protocol chip colors
        proto: {
          http: '#4d9fff',
          grpc: '#22c55e',
          ws: '#a78bfa',
          gql: '#e879a4',
          mcp: '#f59e0b',
          sse: '#06b6d4',
          kafka: '#f472b6',
          socketio: '#a78bfa',
        },
        // Slate-blue color scale for sophistication - refined for sharp look
        'slate-blue': {
          50: '#F6F8FA',
          100: '#EAEEF2',
          200: '#D0D7DE',
          300: '#AFB8C1',
          400: '#8C959F',
          500: '#6E7781',
          600: '#57606A',
          700: '#424A53',
          800: '#32383F',
          900: '#24292F',
          950: '#0A0C10',
        },
        violet: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        },
        slate: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
        indigo: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
      },
      borderRadius: {
        // Legacy
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
        // Spatial Depth radius scale — flush/square pro-instrument: regions
        // (panel) are square and divided by hairlines; controls keep a hair of
        // rounding; overlays (window) keep a small radius.
        'sp-chip': '3px',
        'sp-btn': '4px',
        'sp-pill': '5px',
        'sp-panel': '0px',
        'sp-window': '6px',
      },
      letterSpacing: {
        tighter: '-0.025em',
        tight: '-0.015em',
        'sp-label': '0.06em',
      },
      fontWeight: {
        'medium-plus': '450',
      },
      fontSize: {
        // Spatial Depth type scale (in px → rem at 16px base)
        'sp-9': ['9px', { lineHeight: '1.1' }],
        'sp-10': ['10px', { lineHeight: '1.1' }],
        'sp-10-5': ['10.5px', { lineHeight: '1.2' }],
        'sp-11': ['11px', { lineHeight: '1.3' }],
        'sp-11-5': ['11.5px', { lineHeight: '1.3' }],
        'sp-12': ['12px', { lineHeight: '1.4' }],
        'sp-12-5': ['12.5px', { lineHeight: '1.4' }],
        'sp-13': ['13px', { lineHeight: '1.4' }],
        'sp-14': ['14px', { lineHeight: '1.4' }],
        'sp-16': ['16px', { lineHeight: '1.3' }],
        'sp-22': ['22px', { lineHeight: '1.2' }],
      },
      spacing: {
        '4.5': '1.125rem',
        '5.5': '1.375rem',
        '18': '4.5rem',
        '88': '22rem',
        '92': '23rem',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '0.8' },
        },
        'shimmer': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(-10px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'success-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34, 197, 94, 0)' },
          '50%': { boxShadow: '0 0 0 8px rgba(34, 197, 94, 0.1)' },
        },
        'error-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-2px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(2px)' },
        },
        'gradient-border': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'scale-in': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'glow-border': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        'status-appear': {
          'from': { opacity: '0', transform: 'scale(0.8) translateY(-4px)' },
          'to': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // Spatial Depth keyframes
        'sp-blink': {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        'sp-slide-in-right': {
          from: { transform: 'translateX(40px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'sp-fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'glow-pulse': 'glow-pulse 4s ease-in-out infinite',
        'shimmer': 'shimmer 2s infinite',
        'fade-in-up': 'fade-in-up 0.3s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'success-pulse': 'success-pulse 1s ease-in-out',
        'error-shake': 'error-shake 0.4s ease-in-out',
        'gradient-border': 'gradient-border 3s ease infinite',
        'scale-in': 'scale-in 0.2s ease-out',
        'glow-border': 'glow-border 2s ease-in-out infinite',
        'status-appear': 'status-appear 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        // Spatial Depth animations
        'sp-blink': 'sp-blink 1s steps(2, start) infinite',
        'sp-slide-in-right': 'sp-slide-in-right 0.25s cubic-bezier(0.2, 0.7, 0.3, 1)',
        'sp-fade-in': 'sp-fade-in 0.18s ease-out',
      },
      boxShadow: {
        // Elevation system (legacy)
        'elevation-1': '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
        'elevation-2': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
        'elevation-3': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)',
        'elevation-4': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        'inner-top': 'inset 0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        'inner-bottom': 'inset 0 -1px 2px 0 rgba(0, 0, 0, 0.05)',
      },
    },
  },
  plugins: [],
};

export default config;
