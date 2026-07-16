# Verification gates

| Gate | Command | Catches |
| --- | --- | --- |
| Local shipping | `npm run validate` | all TypeScript projects, Biome, codegen, capability matrix, root coverage, CLI tests |
| Web/Worker build | `npm run build` | Vite SPA plus Cloudflare Worker bundling |
| Self-host bundle | `npm run build:docker` | SPA and Node Hono entry |
| Electron main | `npm run electron:compile` | main/preload TypeScript and runtime imports |
| Size | `npm run size` | bundle limits |
| Docs | `npm run docs:check` | Astro type/link/build inputs |
| Browser E2E | `npm run test:e2e` | real web interactions |
| Electron E2E | `npm run test:e2e:electron` | unpacked desktop runtime |

GitHub `merge-gate` aggregates required CI-only shards and cross-OS packaging.
Skipped is not passed unless the tested Dependabot exception explicitly allows
that job.
