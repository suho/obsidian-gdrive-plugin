# GDrive Sync for Obsidian

Sync your Obsidian vault with Google Drive using OAuth 2.0, with incremental pull/push, conflict handling, selective sync, and offline recovery.

> [!IMPORTANT]
> This plugin uses Google Drive scope `drive.file`.
> It can only access files created by this plugin (or explicitly opened with this app scope).
> Files created manually in Drive are not guaranteed to appear in sync results.

## Features

- OAuth 2.0 authentication
- Setup wizard for account + target folder
- Incremental pull via Google Drive Changes API
- Local file watcher with quiescence-based upload
- Conflict handling for Markdown and binary files
- Activity log view, deleted files modal, and largest files modal
- Version history modal backed by Google Drive revisions
- Selective sync by file type and excluded folders
- Granular `.obsidian` config sync toggles
- Offline queue replay on reconnect
- Rate limiting, quota backoff, and storage-full pause handling

## Privacy and security

- No hidden telemetry.
- Access token is not persisted.
- Refresh token is stored in plugin data and used only for Google API access.
- OAuth `client ID` and `client secret` are user-provided Google OAuth credentials.
- `client ID` and `client secret` are currently stored in plugin settings (device-local) for reuse.
- Sync is scoped to the selected Google Drive folder and enabled file types.

> [!NOTE]
> A new **Keychain** settings section for storing plugin secrets is planned.
> Obsidian Plugin Keychain API support is coming soon.
> When the API is available, this plugin will move secret storage to Obsidian Keychain.

## Developer policy disclosures

- External service dependency: Google Drive API and Google OAuth endpoints are required for sync and authentication.
- Account requirement: A Google account and user-provided OAuth client credentials are required.
- Data sent to Google: OAuth tokens, folder/file metadata, and file contents for files selected by sync settings.
- Local data storage: plugin settings, sync database, queue state, and snapshots are stored under `.obsidian/plugins/gdrive-sync/` in the current vault.
- File access scope: reads and writes only inside the active vault (including selected `.obsidian` config files).
- Telemetry/ads/payments: no analytics telemetry, no ads, and no paywall features.
- Remote code execution: the plugin does not download or execute remote scripts and does not self-update outside normal releases.

## Installation

### Option 1: BRAT (beta path)

1. Install BRAT in Obsidian desktop.
2. Select **Add beta plugin** in BRAT.
3. Use repository `suho/obsidian-gdrive-plugin`.
4. Install **GDrive Sync**.

### Option 2: Manual install

1. Build release files:

```bash
npm install
npm run build
```

2. Create plugin folder:

```text
<Vault>/.obsidian/plugins/gdrive-sync/
```

3. Copy release artifacts into that folder:
- `main.js`
- `manifest.json`
- `styles.css`

4. In Obsidian, go to **Settings → Community plugins** and enable **GDrive Sync**.

## Setup guide

1. Open **Settings → GDrive Sync**.
2. Connect your Google account.
3. Create or choose a Drive folder for this vault.
4. Review initial sync summary and conflicts.
5. Run **Sync now**.

### Create Google OAuth credentials

Before using **Connect to Google Drive**, create a desktop OAuth client in Google Cloud Console:

1. Create a Google Cloud project: [Project create](https://console.cloud.google.com/projectcreate)
2. Open credentials page: [Credentials](https://console.cloud.google.com/apis/credentials)
3. Enable API: [Google Drive API](https://console.cloud.google.com/apis/api/drive.googleapis.com)
4. Configure consent screen: [Branding](https://console.cloud.google.com/auth/branding)
5. If app is in testing, add your account: [Audience](https://console.cloud.google.com/auth/audience)
6. Create client: [OAuth clients](https://console.cloud.google.com/auth/clients)
7. Choose application type: `Desktop app`
8. Copy `client ID` and `client secret`, then paste them into the setup wizard.

### Mobile setup

Mobile auth uses a refresh-token import flow.

1. On desktop, copy the refresh token from plugin settings.
2. On mobile, paste it into **Refresh token**. Validation runs automatically.
3. Complete folder setup if prompted.

## Commands

- `Sync now`
- `Push changes`
- `Pull changes`
- `Pause sync`
- `Resume sync`
- `View activity log`
- `View conflicts`
- `View deleted files`
- `View largest synced files`
- `Open settings`
- `Resume uploads after storage warning`
- `Clean duplicate sync artifacts`
- `Force full re-sync`
- `Connect to Google Drive` (desktop only)

## Maintenance actions

- `Force full re-sync` is available as both a command and an Advanced settings action.
- It clears local sync state, then runs a full local/remote comparison with a preview step.

## FAQ

### Why do some files in Google Drive not appear in Obsidian sync?

The plugin uses `drive.file`, so it primarily sees files created via this plugin. Manual uploads in Drive may be out of scope.

### Are selective sync settings shared across devices?

No. Selective sync options (file types, excluded folders, max size, and related behavior) are device-local by design.

### How should I connect multiple vaults with the same Google account?

Use one shared refresh token for that Google account and OAuth client on the same device:

1. Connect the first vault with **Connect to Google Drive**.
2. In each additional vault, open **Settings → GDrive Sync** and paste the same refresh token. Validation runs automatically.
3. Avoid running **Connect to Google Drive** again unless you intentionally want a new token.

If a vault creates a new refresh token, older vault tokens can be revoked and those vaults will need re-authentication or token re-import.

### Is this the same as Obsidian Sync history?

No. History here is based on Google Drive revisions, not Obsidian Sync snapshots.

- Retention behavior depends on Google Drive revision handling and plugin options.
- Markdown files can optionally request `keepRevisionForever`, but retention rules are still Google-side.
- History UX and restore semantics are different from Obsidian Sync's native timeline.

### Does it sync all `.obsidian` files?

No. Only configured categories are synced (for example editor settings, appearance, hotkeys, community plugin list).
Unsafe and transient files (for example workspace and cache files) are intentionally excluded.

## Known limitations

- `drive.file` scope limits visibility to plugin-managed content.
- Google API quota limits can temporarily delay sync.
- Files currently active in the editor may be deferred for safety during pulls.
- Mobile platforms can suspend background execution, so sync is best-effort when the app is not foregrounded.

## Troubleshooting

- If setup does not start, run **Open settings** and reconnect account.
- If re-authentication is required after connecting another vault, paste the latest refresh token in **Settings → GDrive Sync** and wait for automatic validation, or use **Re-authenticate**.
- If uploads are paused due to storage full, run **Resume uploads after storage warning** after freeing space.
- If sync appears stalled, check **View activity log** for conflict/error entries.
- If local and remote drift after major changes, run **Force full re-sync** from **Settings → GDrive Sync → Advanced**.
- If sync metadata seems corrupted, run **Force full re-sync** to clear local sync state and rebuild sync metadata.
- If the target Drive folder was deleted manually, rerun setup from plugin settings.

## Development

### Prerequisites

- Node.js 18+
- npm

### Local configuration

Configure OAuth credentials in the setup wizard:

- On **Connect to Google Drive**, paste `OAuth client ID` and `OAuth client secret`.
- Values are saved in plugin settings, so users only enter them once per device.
- Use a Google OAuth client of type `Desktop app` and loopback callback (`http://127.0.0.1:<random-port>/callback`).

### Run in watch mode

```bash
npm install
npm run dev
```

### Validate before release

```bash
npm run lint
npm run build
wc -c main.js
```

Bundle target: under 200 KB.

## Release prep

1. Bump plugin version in `manifest.json`, `manifest-beta.json`, and `package.json`:

```bash
# Default: bump minor (x.(y+1).0)
npm run version:bump

# Optional: set explicit version
npm run version:bump -- 0.16.0
```

`version:bump` also runs `npm install` to keep `package-lock.json` in sync.

2. Run `npm run versions` to add/update the current plugin version mapping in `versions.json`.
3. Add extra supported plugin versions when needed:

```bash
npm run versions -- 0.14.1 0.14.2
```

4. Optional: add a same-minor patch range:

```bash
npm run versions -- --from 0.15.0 --to 0.15.3
```

5. Build `main.js`.
6. Create and push a git tag that matches the version in `package.json`, `manifest.json`, and `manifest-beta.json`:

```bash
npm run release:tag
```

The script stops without tagging if any of those versions differ.

7. Tag a GitHub release exactly as the plugin version (no `v` prefix).
8. Upload `main.js`, `manifest.json`, and `styles.css` as release assets.
9. Validate against Obsidian policy/guideline checklist in `docs/community-submission-checklist.md`.

## License

`0BSD`
