# Google Drive Sync for Obsidian

Sync your Obsidian vault with Google Drive using OAuth 2.0 + PKCE, with incremental pull/push, conflict handling, selective sync, and offline recovery.

> [!IMPORTANT]
> This plugin uses Google Drive scope `drive.file`.
> It can only access files created by this plugin (or explicitly opened with this app scope).
> Files created manually in Drive are not guaranteed to appear in sync results.

## Features

- OAuth 2.0 authentication with PKCE
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
- Sync is scoped to the selected Google Drive folder and enabled file types.

## Installation

### Option 1: BRAT (beta path)

1. Install BRAT in Obsidian desktop.
2. Select **Add beta plugin** in BRAT.
3. Use repository `suho/obsidian-gdrive-plugin`.
4. Install **Google Drive Sync**.

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

4. In Obsidian, go to **Settings → Community plugins** and enable **Google Drive Sync**.

## Setup guide

1. Open **Settings → Google Drive Sync**.
2. Connect your Google account.
3. Create or choose a Drive folder for this vault.
4. Review initial sync summary and conflicts.
5. Run **Sync now**.

### Mobile setup

Mobile auth uses a refresh-token import flow.

1. On desktop, copy the refresh token from plugin settings.
2. On mobile, paste it into **Add refresh token**.
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
- `Connect to Google Drive` (desktop only)

## FAQ

### Why do some files in Google Drive not appear in Obsidian sync?

The plugin uses `drive.file`, so it primarily sees files created via this plugin. Manual uploads in Drive may be out of scope.

### Are selective sync settings shared across devices?

No. Selective sync options (file types, excluded folders, max size, and related behavior) are device-local by design.

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
- If uploads are paused due to storage full, run **Resume uploads after storage warning** after freeing space.
- If sync appears stalled, check **View activity log** for conflict/error entries.
- If the target Drive folder was deleted manually, rerun setup from plugin settings.

## Development

### Prerequisites

- Node.js 18+
- npm

### Local configuration

Create `.env` at repository root:

```bash
GDRIVE_CLIENT_ID=your_google_oauth_client_id
```

Use a Google OAuth client of type `Desktop app` for this PKCE flow.

- `Web application` clients commonly require `client_secret` at the token endpoint and can fail with HTTP `400`/`401` in this plugin.
- Desktop login uses a loopback callback: `http://127.0.0.1:<random-port>/callback`.

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
