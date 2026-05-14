# Restura storage encryption policy

## Electron desktop

All persisted state is encrypted with a per-install key held in the OS
keychain via Electron's `safeStorage` (macOS Keychain, Windows Credential
Manager, libsecret on Linux). The key is fetched once per session through
the `secureKey` IPC channel and cached in renderer memory.

Plain text only when the OS reports
`safeStorage.isEncryptionAvailable() === false`, in which case the user is
warned at startup.

## Web (Cloudflare Pages)

**Persisted state is NOT encrypted at rest by default.** localStorage and
IndexedDB on the web platform are protected only by the browser's same-
origin policy. Users who require encryption at rest should either use the
desktop app or opt in via:

```
Settings → Security → "Set workspace passphrase"
```

When enabled, all subsequently-saved state is encrypted with a key derived
from the user-supplied passphrase (PBKDF2, 100k iterations, SHA-256). The
passphrase is held in memory for the session only; closing the tab clears
it. On next page load the user must re-enter the passphrase to decrypt
existing data.

> The opt-in passphrase UI is tracked separately; the runtime hook
> (`setKeyProvider(new WebSessionPassphraseProvider(...))`) is already
> wired through `getKeyProvider()`. See the TODO in
> `src/lib/shared/keyProvider.ts`.

There is no "ephemeral encryption" mode any more — that mode created the
illusion of safety while corrupting data on tab close (the random in-memory
key was regenerated each session, leaving any encrypted blob from the
previous session unrecoverable). The previous default has been replaced by
the `PlaintextKeyProvider`, which stores JSON in IndexedDB without applying
the `ENC:` envelope. Existing ephemeral-key blobs are unreadable by design
and will fail the `decryptValue` round-trip; on read the storage adapter
logs and returns `null`, which is functionally the same outcome the user
was already experiencing on every page refresh.

## Worker (Cloudflare)

The Worker does not store user data. Requests are proxied and forgotten.
Cloudflare's network-level encryption applies; no application-layer
encryption is performed.
