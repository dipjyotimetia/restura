# Restura - Distribution Guide

This guide explains how to build, sign, and distribute the Restura Electron app.

## Overview

The app supports distribution on:
- **macOS**: DMG installer and ZIP archive (x64 and arm64)
- **Windows**: NSIS installer and portable executable (x64 and ia32)
- **Linux**: AppImage, DEB, and RPM packages (x64)

## Prerequisites

### Required Software
- Node.js 20.x or later
- npm 10.x or later
- Git

### Platform-Specific Requirements

**macOS:**
- Xcode Command Line Tools
- Apple Developer Account (for signing/notarization)

**Windows:**
- Windows SDK
- Code Signing Certificate (optional but recommended)

**Linux:**
- dpkg-deb (for DEB builds)
- rpm-build (for RPM builds)

## Local Development

### Quick Start

```bash
# Install dependencies
npm ci

# Run in development mode
npm run electron:dev

# Build for current platform
npm run electron:dist
```

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run electron:dev` | Start development server with hot reload |
| `npm run electron:dist` | Build for all platforms |
| `npm run electron:dist:mac` | Build for macOS only |
| `npm run electron:dist:win` | Build for Windows only |
| `npm run electron:dist:linux` | Build for Linux only |
| `npm run electron:pack` | Build unpacked app (for testing) |

## Code Signing Setup

### macOS Code Signing

1. **Get an Apple Developer Certificate**
   - Sign up for [Apple Developer Program](https://developer.apple.com/programs/)
   - Create a "Developer ID Application" certificate in Xcode

2. **Export Certificate**
   ```bash
   # Export from Keychain as .p12 file
   # Base64 encode for GitHub secrets
   base64 -i certificate.p12 | pbcopy
   ```

3. **Configure GitHub Secrets**
   - `MACOS_CERTIFICATE`: Base64-encoded .p12 certificate
   - `MACOS_CERTIFICATE_PASSWORD`: Certificate password
   - `KEYCHAIN_PASSWORD`: Temporary keychain password (any strong password)

### macOS Notarization

Apple requires notarization for apps distributed outside the App Store.

1. **Create App-Specific Password**
   - Go to [Apple ID](https://appleid.apple.com/)
   - Generate an app-specific password

2. **Get Team ID**
   - Find in [Apple Developer Portal](https://developer.apple.com/account/#/membership/)

3. **Configure GitHub Secrets**
   - `APPLE_ID`: Your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD`: Generated app-specific password
   - `APPLE_TEAM_ID`: Your team ID

### Windows Code Signing

1. **Purchase a Code Signing Certificate**
   - Options: DigiCert, Sectigo, GlobalSign
   - EV certificates provide SmartScreen reputation

2. **Export Certificate**
   ```bash
   # Export as .pfx/.p12 file
   # Base64 encode for GitHub secrets
   base64 -i certificate.pfx | pbcopy
   ```

3. **Configure GitHub Secrets**
   - `WINDOWS_CERTIFICATE`: Base64-encoded .pfx certificate
   - `WINDOWS_CERTIFICATE_PASSWORD`: Certificate password

## CI/CD Pipeline

### Automated Releases

The GitHub Actions workflow (`.github/workflows/electron-release.yml`) automates:

1. **Building** on all platforms (macOS x64/arm64, Windows, Linux)
2. **Signing** with configured certificates
3. **Notarizing** macOS builds
4. **Publishing** to GitHub Releases

### Triggering a Release

**Option 1: Git Tag (Recommended)**
```bash
# Update version and create tag
npm version patch  # or minor, major
git push && git push --tags
```

**Option 2: Manual Workflow**
- Go to Actions → Build and Release Electron App
- Click "Run workflow"
- Optionally specify version

### Release Workflow Steps

1. **Build Matrix**
   - Runs on macOS, Windows, and Ubuntu runners
   - Builds for all architectures in parallel

2. **Code Signing**
   - Imports certificates from secrets
   - Signs executables automatically

3. **Artifact Upload**
   - Uploads installers, manifests, and blockmaps
   - Preserves for release creation

4. **Release Creation**
   - Creates draft release
   - Attaches all artifacts
   - Generates release notes

## GitHub Secrets Configuration

Add these secrets in Repository Settings → Secrets → Actions:

### Required Secrets
```
GITHUB_TOKEN          # Automatically provided
```

### macOS Signing (Optional)
```
MACOS_CERTIFICATE             # Base64 .p12 certificate
MACOS_CERTIFICATE_PASSWORD    # Certificate password
KEYCHAIN_PASSWORD             # Temporary keychain password
```

### macOS Notarization (Optional)
```
APPLE_ID                      # Apple ID email
APPLE_APP_SPECIFIC_PASSWORD   # App-specific password
APPLE_TEAM_ID                 # Team ID
```

### Windows Signing (Optional)
```
WINDOWS_CERTIFICATE           # Base64 .pfx certificate
WINDOWS_CERTIFICATE_PASSWORD  # Certificate password
```

## Auto-Updates

The app includes automatic update functionality via `electron-updater`.

### How It Works

1. **Startup Check**: App checks GitHub Releases for updates 3 seconds after launch
2. **Download**: New version downloads in background
3. **Notification**: User is prompted to restart
4. **Installation**: Update installs on restart

### Update Server

Updates are served from GitHub Releases. The `publish` configuration in `electron-builder.json`:

```json
{
  "publish": {
    "provider": "github",
    "owner": "dipjyotimetia",
    "repo": "DJ",
    "releaseType": "release"
  }
}
```

### Manual Update Check

Users can trigger manual update checks via the app menu or by using the IPC channel `app:checkForUpdates`.

## Publishing a Release

### Step-by-Step

1. **Update Version**
   ```bash
   # Patch release (0.1.0 → 0.1.1)
   npm version patch

   # Minor release (0.1.0 → 0.2.0)
   npm version minor

   # Major release (0.1.0 → 1.0.0)
   npm version major
   ```

2. **Push Tags**
   ```bash
   git push origin main --tags
   ```

3. **Monitor Build**
   - Check GitHub Actions for build progress
   - Review any failures

4. **Review Draft Release**
   - Go to GitHub Releases
   - Verify all artifacts are present
   - Edit release notes if needed
   - Publish release

5. **Verify Updates**
   - Install old version
   - Confirm update notification appears

## Troubleshooting

### macOS Issues

**"App is damaged and can't be opened"**
- Not properly signed/notarized
- Solution: Right-click → Open, or `xattr -cr /Applications/DJ\ API\ Client.app`

**Notarization Fails**
- Check Apple ID credentials
- Verify team ID is correct
- Ensure hardened runtime is enabled

### Windows Issues

**SmartScreen Warning**
- Certificate not recognized
- EV certificate builds reputation over time
- Users can click "More info" → "Run anyway"

**Installation Blocked**
- Group policy restrictions
- Antivirus interference
- Try running as administrator

### Linux Issues

**AppImage Won't Run**
- Missing execute permission: `chmod +x *.AppImage`
- Missing FUSE: `sudo apt install fuse`

**DEB Dependencies**
- Missing libraries: `sudo apt --fix-broken install`

## Security Best Practices

1. **Never commit certificates** to the repository
2. **Use GitHub Secrets** for all sensitive data
3. **Enable hardened runtime** on macOS
4. **Sign all releases** for production distribution
5. **Use HTTPS** for update server
6. **Verify signatures** in auto-updater

## Monitoring and Analytics

Consider integrating:
- **Sentry**: Error tracking and performance monitoring
- **Countly**: Analytics and user behavior
- **Matomo**: Privacy-focused analytics

## Support

For distribution issues:
- Check [Electron Builder Docs](https://www.electron.build/)
- Review [GitHub Actions Logs](../../actions)
- Open an issue with build logs

## License

This project is licensed under the MIT License.
