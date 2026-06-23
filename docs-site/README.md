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

## Toolchain & Astro 7

The site runs on **Astro 7** (Rust `.astro` compiler, Vite 8 + Rolldown, Sätteri Markdown
processor) and follows its recommended practices.

- **`@astrojs/mdx@7`, `@astrojs/markdown-satteri@0.3.1`, `vite@8`** — upgraded alongside
  Astro 7.
- **Starlight peer override (read before bumping).** `@astrojs/starlight@0.40.0` (latest)
  still declares `astro@^6.4.5` and `@astrojs/markdown-satteri@^0.2.0`. Astro 7 is verified
  working with it (`npm run check` clean, `npm run build` renders all 62 pages incl. Mermaid
  diagrams), but Starlight runs **outside its declared peer range** via the `overrides` block
  in `package.json`. Remove those overrides once Starlight publishes Astro 7 support.
- **Mermaid needs the `unified` Markdown processor.** Astro 7 defaults to the Rust-based
  Sätteri processor, which does **not** run remark/rehype plugins. `astro-mermaid` turns
  ```mermaid code fences into diagrams via a rehype plugin, so `astro.config.mjs` sets
  `markdown.processor: unified()` to opt back into the plugin pipeline. Without it, diagrams
  render as raw highlighted code. Keep this until astro-mermaid supports Sätteri natively.
- **Content-layer loaders — in use.** `src/content.config.ts` uses the loader API
  (`docsLoader()`), the content-collections pattern Astro 7 standardises on.
- **Strictest TypeScript — in use.** `tsconfig.json` extends `astro/tsconfigs/strictest`.

Astro 7's Rust compiler is stricter: unclosed tags now error and JSX whitespace rules apply
(use `{' '}` for explicit spaces in `.astro` files). Run `npm run check` and `npm run build`
after any dependency bump.

## SEO & social cards

- `public/robots.txt` allows crawling and points to `sitemap-index.xml` (emitted by the
  Starlight-bundled `@astrojs/sitemap` because `site` is set in `astro.config.mjs`).
- `public/og-image.png` is the Open Graph / Twitter card (1200×630). Social scrapers don't
  render SVG, so it's a rasterised copy of `public/og-image.svg` (the editable source). The
  `head` meta in `astro.config.mjs` references the PNG with explicit dimensions. Regenerate
  after editing the SVG:

  ```bash
  node -e "require('sharp')(require('fs').readFileSync('public/og-image.svg'),{density:200}).resize(1200,630).png({compressionLevel:9}).toFile('public/og-image.png')"
  ```

## Deployment

The site is deployed as a separate Cloudflare Pages project named `restura-docs`, with the custom domain `docs.restura.dev` configured in the Cloudflare dashboard. CI deploys on every push to `main`; pull requests get preview deployments at `restura-docs--<branch>.pages.dev`.
