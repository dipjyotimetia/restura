# Extension Release Runbook

How to ship the two browser/editor extensions that live in `extension/`:

- **VS Code** — `extension/vscode` (`restura-vscode`) → VS Code Marketplace + Open VSX.
- **Chrome** — `extension/chrome` (Restura Capture, `@restura/extension`) → Chrome Web Store.

Each extension **publishes on its own, opt-in tag**, but its `package.json`
version follows the app: the main
[`release.yml`](../.github/workflows/release.yml) runs `npm version --workspaces`
and commits both extension `package.json` files with every app release. For
VS Code that file is authoritative, so its version is the app version. Chrome's
authoritative version is `public/manifest.json`, which `release.yml` never
touches, so it is still bumped by hand.

| Extension | Workflow                                         | Tag pattern     | Authoritative version file              |
| --------- | ------------------------------------------------ | --------------- | --------------------------------------- |
| VS Code   | `.github/workflows/extension-vscode-release.yml` | `vscode-v*.*.*` | `extension/vscode/package.json`         |
| Chrome    | `.github/workflows/extension-chrome-release.yml` | `chrome-v*.*.*` | `extension/chrome/public/manifest.json` |

Each workflow has two jobs. **`build`/`package`** installs the repo's
dependencies (install scripts off), type-checks, builds and uploads the
artifact; it holds no secrets and a read-only token. **`publish`** runs only on
a tag and installs nothing from the repo. It installs only the lockfile-pinned
publishers in `.github/tools/publish` (`@vscode/vsce`, `ovsx`,
`chrome-webstore-upload-cli`), downloads the artifact, publishes it, and
creates the GitHub release. Marketplace tokens therefore never sit next to
app dependency code (supply-chain epic #1283).

> **Why two version files?** The Chrome Web Store reads the version from the
> built `manifest.json` (not `package.json`), so the Chrome workflow validates
> the tag against `manifest.json`. The VS Code Marketplace reads `package.json`.
> Each workflow fails fast if the tag's version doesn't match its authoritative
> file — so a forgotten bump can't silently ship the wrong version.

---

## One-time maintainer setup

### The `extensions` environment and its secrets

Both `publish` jobs declare `environment: extensions`. Create it in
**Settings → Environments → New environment → `extensions`**:

- **Deployment branches and tags → Selected**, with the tag rules `vscode-v*`
  and `chrome-v*`. Only tag runs can then read the secrets below.
- Add the secrets below as **environment secrets** (not repository secrets),
  and delete any repository-level copies.
- Required reviewers are optional; add one to get an approval prompt before
  each store upload.

Until the environment exists, GitHub creates an unprotected one on the first
tag run, and the jobs fall back to repository secrets of the same name.

Every publish step **self-skips when its secrets are absent**: the workflow
still builds, packages and attaches the artifact to a GitHub release, so it's
safe to run before any secrets exist. Give each token the shortest expiry the
store allows and record its scope and expiry in the private credential
inventory ([#1285](https://github.com/dipjyotimetia/restura/issues/1285)).
Neither store offers OIDC publishing for these tokens. Check again when
rotating `VSCE_PAT` (Microsoft Entra workload identity federation with
`vsce publish --azure-credential` would remove it).

| Secret                 | Required for                | Notes                                                                             |
| ---------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `VSCE_PAT`             | VS Code Marketplace publish | Azure DevOps PAT with Marketplace **Manage** scope. See the vsce publishing docs. |
| `OVSX_PAT`             | Open VSX publish (optional) | Open VSX access token. The Open VSX step self-skips if unset.                     |
| `CHROME_EXTENSION_ID`  | Chrome Web Store publish    | The published item's ID.                                                          |
| `CHROME_CLIENT_ID`     | Chrome Web Store publish    | OAuth2 client ID for the Web Store API.                                           |
| `CHROME_CLIENT_SECRET` | Chrome Web Store publish    | OAuth2 client secret.                                                             |
| `CHROME_REFRESH_TOKEN` | Chrome Web Store publish    | OAuth2 refresh token authorising publish.                                         |

> Mint the four Chrome credentials with
> [`chrome-webstore-upload-keys`](https://github.com/fregante/chrome-webstore-upload-keys).
> `GITHUB_TOKEN` is automatic (used to create the GitHub release).

### Publisher accounts (first release only)

- **VS Code Marketplace** — the `dipjyotimetia` publisher must exist (create it
  in the [Marketplace management portal](https://marketplace.visualstudio.com/manage)).
- **Open VSX** — the `dipjyotimetia` **namespace** must exist on
  [open-vsx.org](https://open-vsx.org) before the first `ovsx publish`, or it
  fails with a namespace error. Create it once with `npx ovsx create-namespace dipjyotimetia -p $OVSX_PAT`.
- **Chrome Web Store** — the extension must already be created (a first manual
  upload) so it has an ID to put in `CHROME_EXTENSION_ID`.

---

## Releasing the VS Code extension

1. Cut an app release `vX.Y.Z` — it already sets `extension/vscode/package.json`
   to `X.Y.Z` (do not bump it by hand; the next app release would overwrite it).
2. Tag that release commit and push the tag:
   ```bash
   git tag vscode-vX.Y.Z vX.Y.Z
   git push origin vscode-vX.Y.Z
   ```
3. The workflow runs: type-check → unit tests → `vsce package` → publish to
   Marketplace + Open VSX → create a GitHub release with the `.vsix` attached.
4. Verify on the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=dipjyotimetia.restura-vscode)
   (publishing can take a few minutes to index).

The tag's `X.Y.Z` **must** equal `package.json`'s `version` or the run fails.

---

## Releasing the Chrome extension

1. Bump `"version"` in `extension/chrome/public/manifest.json` in a normal PR and merge to `main`.
2. Tag the merge commit and push the tag:
   ```bash
   git tag chrome-v1.2.3
   git push origin chrome-v1.2.3
   ```
3. The workflow runs: type-check → build MV3 bundle → validate manifest version
   → zip → upload to the Chrome Web Store (submitted for review) → create a
   GitHub release with the `.zip` attached.
4. Web Store submissions go through Google's review queue (minutes to days). The
   GitHub release + zip are available immediately for manual/unpacked install.

The tag's `1.2.3` **must** equal `manifest.json`'s `version` or the run fails.

---

## Dry runs (test without publishing)

Both workflows expose a manual `dry_run` (default **true**) that builds and
packages the artifact and uploads it as a workflow **build artifact**, but never
publishes to a store and never creates a GitHub release. Use it to smoke-test the
pipeline before configuring secrets, or to grab a `.vsix` / `.zip` for local testing.

```bash
gh workflow run extension-vscode-release.yml --ref main   # dry_run defaults to true
gh workflow run extension-chrome-release.yml --ref main
```

Or **Actions → "Release — VS Code extension" / "Release — Chrome extension" →
Run workflow**. Download the artifact from the run summary:

- VS Code: `code --install-extension restura-vscode-<version>.vsix`
- Chrome: extract the zip, then **chrome://extensions → Developer mode → Load unpacked**.

> A real publish happens **only** on a `*-v*.*.*` tag push. A `workflow_dispatch`
> run can never publish, even with `dry_run` unticked.

---

## Recovery after a failed run

Unlike the desktop release, these workflows never commit back to `main` and the
tag is what you pushed — so recovery is just deleting the GitHub release/tag and
retrying:

```bash
# Drop the GitHub release + its tag, fix the version, then re-tag.
gh release delete vscode-v1.2.3 --cleanup-tag --yes   # or chrome-v1.2.3
git push origin :refs/tags/vscode-v1.2.3              # if the tag wasn't cleaned up
```

Common failures:

- **`Tag … does not match … version`** — you tagged before bumping the
  authoritative version file. Bump it (or retag at the correct commit) and retry.
- **Marketplace/Web Store publish error** — the `build`/`package` job already
  succeeded and its artifact is kept on the run. Fix the credential or listing
  issue, then use **Re-run failed jobs**: only `publish` runs again, on the
  same bytes. If the GitHub release was already created on an earlier attempt,
  delete it first (`gh release delete <tag> --yes`, keeping the tag) so the
  re-run can recreate it.
- **Web Store "version already exists"** — that version was already uploaded;
  bump and re-tag.

---

See [`docs/CI_CD.md`](./CI_CD.md) for the rest of the CI/CD pipeline and the
desktop/web/CLI release runbook.
