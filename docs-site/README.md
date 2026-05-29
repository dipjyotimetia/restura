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

## Deployment

The site is deployed as a separate Cloudflare Pages project named `restura-docs`, with the custom domain `docs.restura.dev` configured in the Cloudflare dashboard. CI deploys on every push to `main`; pull requests get preview deployments at `restura-docs--<branch>.pages.dev`.
