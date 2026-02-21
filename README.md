# Google Drive Sync for Obsidian

Sync your Obsidian vault with Google Drive using the Google Drive API.

## What this plugin does

- Connects your Google account with OAuth 2.0 (PKCE)
- Creates or links a vault folder under `My Drive/Obsidian Vaults/...`
- Syncs changes between local vault files and Google Drive
- Supports selective sync by file type (images, audio, video, PDF files, other types)
- Supports granular vault configuration sync for selected `.obsidian` files
- Supports manual sync, pause sync, and resume sync commands
- Shows sync status in the status bar
- Lets you copy a refresh token on desktop and import it on mobile
- Applies API request throttling and retry backoff for quota/rate errors
- Pauses uploads when Google Drive storage is full until you explicitly resume

## Important limitations

- The plugin uses Google Drive scope `drive.file`.
- This means it can access only files created by this plugin.
- Files added manually in Google Drive web/app are not guaranteed to be visible to this plugin.
- Selective sync settings are device-local and do not sync across devices.
- The plugin does not sync all files in `.obsidian`; it syncs only enabled vault config files.
- Version history behavior is different from Obsidian Sync because this plugin relies on Google Drive revisions.

## Install on desktop app

### Option 1: BRAT (recommended while in beta)

1. Install and enable the BRAT plugin in Obsidian desktop.
2. Open BRAT and select **Add beta plugin**.
3. Enter `suho/obsidian-gdrive-plugin`.
4. Install `Google Drive Sync` from BRAT.

### Option 2: Manual install

1. Build artifacts:

```bash
npm install
npm run build
```

2. Create plugin folder in your vault:

```text
<Vault>/.obsidian/plugins/gdrive-sync/
```

3. Copy these files to that folder:
- `main.js`
- `manifest.json`
- `styles.css`

4. In Obsidian desktop, go to **Settings → Community plugins** and enable **Google Drive Sync**.

## Desktop first-time setup

1. Open **Settings → Google Drive Sync**.
2. Select **Connect to Google Drive**.
3. Complete Google sign-in in your browser.
4. Return to Obsidian and finish folder setup.
5. Run command **Google Drive Sync: Sync now**.

## Copy token on desktop and use it on mobile

Use this when mobile sign-in is inconvenient or when you want to quickly connect additional mobile devices.

### On desktop

1. Open **Settings → Google Drive Sync**.
2. In **Account**, find **Refresh token**.
3. Select **Copy**.

### On mobile

1. Install the same plugin on mobile (BRAT is the easiest path).
2. Open **Settings → Google Drive Sync**.
3. In **Add refresh token**, paste the token copied from desktop.
4. Select **Connect**.
5. If prompted, finish folder setup in the wizard.

## Commands available now

- `Sync now`
- `Pause sync`
- `Resume sync`
- `Open settings`
- `Connect to Google Drive` (desktop)
- `Resume uploads after storage warning`

## Development

### Prerequisites

- Node.js 18+
- npm

### Configure OAuth credentials

Create `.env` in the project root:

```bash
GDRIVE_CLIENT_ID=your_google_oauth_client_id
```

The build injects this value into `main.js`.

### Run

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

Target bundle size is under 200 KB.

## Release checklist

1. Update `manifest.json` version.
2. Update `versions.json` mapping.
3. Build production bundle.
4. Publish a GitHub release tagged exactly as the version (no leading `v`).
5. Upload `manifest.json`, `manifest-beta.json`, `main.js`, `styles.css`.

## License

`0BSD`
