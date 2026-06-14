import { rmSync } from 'node:fs';

// Remove the previous electron main-process build before recompiling so files
// deleted or moved in source (e.g. the concern-based main/ regroup) don't linger
// as orphan .js in dist/electron — electron-builder's `files: ["dist/electron/**/*"]`
// glob would otherwise package them. `tsc` does not delete outputs for removed
// sources, and electron:compile is not incremental, so a full clean is free.
//
// CI packages from a fresh checkout (no stale dist), so this only protects local
// incremental builds: electron:pack / electron:dist / electron:dev.
rmSync('dist/electron', { recursive: true, force: true });
