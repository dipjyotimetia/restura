Xcode does the CSR + key generation + download + install for you — no Keychain Assistant steps. (You can abandon the web portal page; Xcode creates the cert directly.)

Generate in Xcode

1. Open Xcode → Settings (⌘,) → Accounts tab.
2. Sign in with the Apple ID that's the Account Holder on the developer team (click ＋ at bottom-left if it's not listed).
3. Select your team in the list → click Manage Certificates… (bottom-right).
4. In the sheet, click the ＋ (bottom-left) → choose Developer ID Application.
5. Xcode generates the key pair, submits the CSR, downloads the cert, and installs it into your login keychain automatically. It'll appear in the list as Developer ID Application.

That's it — no manual CSR, no .cer download.

Then export the .p12 (for CSC_LINK)

1. Open Keychain Access → login keychain → My Certificates.
2. Find Developer ID Application: <your name> (TEAMID) — expand the ▸ triangle and confirm a private key is nested under it (Xcode put it there).
3. Right-click the certificate → Export "Developer ID Application…" → format Personal Information Exchange (.p12) → choose a password → save.

- That password → CSC_KEY_PASSWORD secret.

4. Encode it:
   base64 -i Certificates.p12 | pbcopy # paste into the CSC_LINK secret

Gotchas

- Needs full Xcode (not just Command Line Tools).
- If Developer ID Application is greyed out / missing in the ＋ menu → your account role isn't Account Holder (only they can create Developer ID certs).
- If export gives only the cert with no private key under it, you're on a different Mac than the one that generated it — export from the machine where Xcode created it, or you'll need to regenerate.

After that, you have all five macOS secrets. Windows signing remains optional
until a Windows certificate is available.

✻ Cooked for 21s

❯ now what i need to configure to the repo

No code changes are needed — electron-builder.json (signing/notarize config) and the release.yml desktop job (now per-OS scoped) are already wired. You only add 5 repository secrets. Let me first show what's already set on the repo:

Ran 1 shell command

The 5 signing secrets aren't set yet (you only have the Cloudflare/Worker ones). Add exactly these to Repo → Settings → Secrets and variables → Actions → Repository secrets → New repository secret:

┌─────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Secret │ Value / how to get it │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ CSC_LINK │ base64 of your exported .p12: base64 -i Certificates.p12 | pbcopy, then paste │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ CSC_KEY_PASSWORD │ the password you set when exporting the .p12 │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ APPLE_ID │ your Apple ID email │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ APPLE_APP_SPECIFIC_PASSWORD │ appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate (format abcd-efgh-ijkl-mnop). Not your login │
│ │ password │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ APPLE_TEAM_ID │ 10-char Team ID — developer.apple.com → Membership, or it's in your cert name Developer ID Application: … (TEAMID) │
└─────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Fast path — set them from your terminal with gh

Run these in your own terminal (so the values never land in this chat/transcript):

# CSC_LINK — pipe the base64 straight in (no temp file, no clipboard)

gh secret set CSC_LINK < <(base64 -i Certificates.p12)

# The rest — each prompts; type/paste the value then press Enter, Ctrl-D

gh secret set CSC_KEY_PASSWORD
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID
(gh secret set NAME reads the value from stdin — paste it, newline, then Ctrl-D.)

Verify

gh secret list # should now show all 5 alongside the Cloudflare ones

Then release

After merging to main, manually dispatch `release.yml`. The macOS leg uses the
`CSC_*` and `APPLE_*` secrets to sign and notarize the DMG/ZIP. Windows signing
remains optional until `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are configured.

Confirm the shipped build is valid

spctl -a -vvv -t install /Applications/Restura.app # "accepted … Notarized Developer ID"
codesign -dv --verbose=4 /Applications/Restura.app # shows your Developer ID authority

That's the whole repo-side config — 5 secrets, no code changes. Want me to add a docs/RELEASING.md capturing this so it's documented for next time?

✻ Brewed for 52s

❯ APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID how to create these

APPLE_APP_SPECIFIC_PASSWORD

This is a password tied to your Apple ID (used by notarytool to log in). Create it at appleid.apple.com (not the developer portal):

1. Go to https://appleid.apple.com → sign in with the same Apple ID as your developer account.
2. Open the Sign-In and Security section.
3. Click App-Specific Passwords.
4. Click ＋ / Generate an app-specific password (or "Generate Password…").
5. Label it something like restura-notarization → Create.
6. It shows a password like abcd-efgh-ijkl-mnop — copy it now (it's shown only once). That string is the secret value (keep the dashes).

▎ Requires two-factor authentication on the Apple ID — it's mandatory for developer accounts, so you'll already have it.

APPLE_TEAM_ID

Your 10-character team identifier (e.g. AB12CD34EF). Easiest ways:

Terminal (fastest, since the cert is in your keychain):
security find-identity -v -p codesigning
Look for the line:
"Developer ID Application: Your Name (AB12CD34EF)"
The 10 chars in parentheses = your Team ID.

Or the web: developer.apple.com → sign in → Membership (or Account → Membership details) → the Team ID field.

---

So:

- APPLE_APP_SPECIFIC_PASSWORD = the abcd-efgh-ijkl-mnop string from appleid.apple.com.
- APPLE_TEAM_ID = the 10-char ID from security find-identity (or Membership page).

Once both are set (plus `CSC_LINK`, `CSC_KEY_PASSWORD`, and `APPLE_ID`),
`gh secret list` shows all five macOS secrets. The next manually dispatched
stable release produces a signed and notarized macOS build.
