# Desktop Signing Setup

TranscribeAlpha desktop builds use three types of signing. None are required for local development — they're only needed for distribution.

## 1. Tauri Update Signing (free, required for auto-updater)

Generate a keypair:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/TranscribeAlpha.key
```

Add to GitHub Secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — contents of the `.key` file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you chose

Add the **public key** to `tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "YOUR_PUBLIC_KEY_HERE",
    "endpoints": ["https://github.com/nathanjeichert/TranscribeAlpha2.0/releases/latest/download/latest.json"]
  }
}
```

The auto-updater won't activate until `pubkey` is set.

## 2. Apple Code Signing (paid, required for macOS distribution)

Requires an Apple Developer account ($99/year).

Add to GitHub Secrets:
- `APPLE_CERTIFICATE` — base64-encoded `.p12` certificate
- `APPLE_CERTIFICATE_PASSWORD` — certificate password
- `APPLE_SIGNING_IDENTITY` — e.g., `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID` — your Apple ID email
- `APPLE_PASSWORD` — app-specific password (not your Apple ID password)
- `APPLE_TEAM_ID` — your 10-character team ID

Without these, macOS builds will be unsigned (users get a Gatekeeper warning).

## 3. Windows Code Signing (paid, optional)

An EV code signing certificate eliminates SmartScreen warnings. Options:
- DigiCert, Sectigo, or GlobalSign (~$200-400/year)
- Azure Trusted Signing (cheaper, newer)

Signing is configured via `tauri.conf.json` under `bundle > windows > certificateThumbprint`. See the [Tauri docs](https://v2.tauri.app/distribute/sign/windows/) for details.

Without this, Windows builds will trigger SmartScreen warnings on first install.
