# ADR 0043: Electron Git Runtime Hardening

**Status:** Accepted, 2026-11-07. Extends the renderer-compromise threat model of [ADR 0004](./0004-security-hardening.md) and [ADR 0026](./0026-electron-csp-and-permission-hardening.md) to the desktop Git integration.

## Context

The desktop Git dialog runs the user's installed `git` from Electron main (`runGit` in `electron/main/handlers/git-runtime.ts`) inside registered OpenCollection directories. Git reads repo-local config (`.git/config`) and hook scripts (`.git/hooks/*`), and several config keys name programs Git executes: hooks, `core.fsmonitor`, `core.sshCommand`, `diff.external`, and filter / merge / textconv drivers.

Two things make that a code-execution path:

- **Collection repos are untrusted.** A user clones a collection someone else wrote. A bare repository embedded in the working tree, or config shipped alongside it, must not be able to run a program when Restura runs `status`, `diff` or `commit`.
- **The renderer could write into `.git/`.** The renderer file API (`electron/main/storage/file-operations.ts`) allows reads and writes under registered collection directories. A compromised renderer (XSS in a response viewer, a malicious import) could write a `.git/config` filter driver or a hook, then trigger a Git operation and have main execute it — a renderer-to-main escape.

`runGit` already stripped `GIT_*` environment variables and emptied `core.fsmonitor` and `core.sshCommand`; hooks and `diff.external` were still honoured.

## Decision

- **Command-line overrides on every Git call.** `GIT_HARDENING_ARGS` prefixes each command with `-c` settings, which take precedence over every config file:
  - `core.hooksPath=<null device>` (`/dev/null`, `NUL` on Windows) — no repo hook runs;
  - `diff.external=` — no external diff program;
  - `core.fsmonitor=` and `core.sshCommand=` — kept from before;
  - `safe.bareRepository=explicit` — Git ignores a bare repository it discovers in the tree.
- **No renderer access to Git metadata.** `isPathSafe` and `isPathRealSafe` refuse any path with a `.git` component, for reads and writes (`hasGitMetadataSegment`). NTFS aliases (trailing dots/spaces, 8.3 names such as `GIT~1`) and symlinks that resolve into a `.git` directory are refused too. Reads are refused because `.git/config` can embed remote credentials. This covers the drivers that `-c` cannot blanket-disable (their names are arbitrary).
- Signing configuration (`commit.gpgSign`, `gpg.program`) is not overridden; signed commits keep working.

## Alternatives considered

- **Allowlist known-safe hooks.** Rejected: a hook is an arbitrary script, and whether it is "safe" depends on its contents, which the attacker controls. There is no allowlist that keeps husky working and blocks a planted `pre-commit`.
- **Per-repo trust prompt** (run hooks after the user trusts the repo, like an editor's workspace trust). Rejected for now: the renderer-write path means a trusted repo can still be modified by a compromised renderer after the prompt, and the prompt UI would itself need to live outside the renderer. Could be revisited once `.git/` writes are impossible from the renderer, which this ADR provides.
- **`GIT_CONFIG_*` environment variables** (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`). Equivalent precedence to `-c`, but `runGit` deliberately strips every `GIT_*` variable inherited from the environment; mixing in some set by Restura makes that filter harder to audit. `-c` arguments are visible in the argv and in tests.

## Consequences

**Positive**

- A cloned repo or a compromised renderer can no longer get main to run a hook or external diff through Restura's Git dialog.
- The renderer cannot read `.git/config` credentials or plant config.

**Negative**

- User hooks (husky, commitlint, lint-staged, `post-merge` installers) do not run for commits, merges or pulls made in Restura. Users who rely on them commit from a terminal. `docs-site/.../guides/collections.mdx` says so.
- Filter / merge / textconv drivers configured by the user in the repo still run (they cannot be blanket-disabled); the protection is that the renderer cannot write them.
- A collection that the user intentionally keeps inside a bare repository needs an explicit `--git-dir`, which Restura does not pass.

## References

- Code: `electron/main/handlers/git-runtime.ts` (`GIT_HARDENING_ARGS`, `runGit`), `electron/main/storage/file-operations.ts` (`hasGitMetadataSegment`, `isPathSafe`, `isPathRealSafe`)
- Tests: `electron/main/__tests__/git-runtime-hardening.test.ts`, `electron/main/__tests__/file-operations.test.ts`
- Docs: [`docs/security.md` § Git on desktop](../security.md#git-on-desktop-electron)
- Related: [ADR 0004](./0004-security-hardening.md), [ADR 0026](./0026-electron-csp-and-permission-hardening.md)
