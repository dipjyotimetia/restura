# Restura Docs Site

Source for [`docs.restura.dev`](https://docs.restura.dev). Built with [Astro Starlight](https://starlight.astro.build/) and deployed to Cloudflare Pages as a sibling project to the main app.

## Local development

```bash
npm install        # inside docs-site/
npm run dev        # http://localhost:4321
npm run check      # astro check (content + types)
npm run build      # static output to dist/
npm run preview    # serve the production build locally
```

Or from the repo root:

```bash
npm run docs:dev
npm run docs:build
npm run deploy:docs   # builds + wrangler pages deploy
```

## Content layout

```
src/content/docs/
├─ index.mdx                 # Landing
├─ overview/                 # What is / install / quick start / platforms
├─ protocols/                # Per-protocol pages
├─ guides/                   # Usability features
├─ architecture/             # Shared-protocol layer, security, ADRs
├─ self-hosting/             # Docker + reverse-proxy
└─ reference/                # Capability matrix, API, CLI, OpenCollection
```

Several pages reuse markdown from the repo's existing `/docs` folder by importing it directly — editing the source file in `/docs/*.md` updates the site automatically. See individual `.mdx` files for the import path.

## Toolchain & Astro 7 readiness

The site tracks the latest dependencies that are compatible with Astro Starlight. We
already follow the practices Astro 7 makes default, while staying on the Astro 6.4 line
that Starlight supports.

- **Astro 6.4 (held — Starlight gate).** Astro 7 is released, but the latest
  `@astrojs/starlight` (`0.40.0`) still pins `astro@^6.4.5` (and
  `@astrojs/markdown-satteri@^0.2.0`). Since the whole site is Starlight, we stay on the
  latest Astro 6.x until Starlight ships Astro 7 support, then bump together with
  `npx @astrojs/upgrade`.
- **Sätteri markdown processor — already in use.** Astro 7 makes the Rust-powered
  Markdown/MDX pipeline (GFM, smart punctuation, heading IDs, math) the default. Astro 6.4
  already ships it (`@astrojs/markdown-satteri`), so no remark/rehype plugins are needed in
  `astro.config.mjs`.
- **Content-layer loaders — already in use.** `src/content.config.ts` uses the loader API
  (`docsLoader()`), the modern content-collections pattern Astro 7 standardises on.
- **Strict TypeScript — already in use.** `tsconfig.json` extends `astro/tsconfigs/strict`.

When upgrading to Astro 7, also review: the stricter Rust `.astro` compiler (unclosed tags
now error; JSX whitespace rules apply — use `{' '}` for explicit spaces) and Vite 8 +
Rolldown. Run `npm run check` and `npm run build` after any bump.

## Deployment

The site is deployed as a separate Cloudflare Pages project named `restura-docs`, with the custom domain `docs.restura.dev` configured in the Cloudflare dashboard. CI deploys on every push to `main`; pull requests get preview deployments at `restura-docs--<branch>.pages.dev`.
