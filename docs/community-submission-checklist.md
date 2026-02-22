# Community submission checklist

Use this checklist before opening or updating your community plugin PR.
Aligned with Obsidian release requirements and the plugin self-critique checklist.

## Metadata and packaging

- [x] `manifest.json` includes valid `id`, `name`, `version`, `minAppVersion`, `description`, `isDesktopOnly`.
- [x] `id` is stable and matches folder name (`gdrive-sync`).
- [x] `versions.json` includes current mapping (`0.20.0 -> 0.15.0`).
- [ ] GitHub release tag exactly matches `manifest.json.version` (no `v` prefix).
- [ ] Release assets include `main.js`, `manifest.json`, and `styles.css`.

## Policy and privacy disclosures

- [x] README documents Google API dependency and `drive.file` scope behavior.
- [x] README documents account requirement (Google account + OAuth client credentials).
- [x] README documents data flow (OAuth metadata/tokens, synced file metadata/content to Google).
- [x] README documents local data storage location (`.obsidian/plugins/gdrive-sync/`).
- [x] README states there is no telemetry, ads, remote code execution, or paywall behavior.
- [x] README states sync scope and device-local selective sync behavior.

## Code safety and behavior

- [x] No hidden telemetry or analytics SDKs in source.
- [x] Network calls are limited to Google OAuth/Drive endpoints required for sync/auth.
- [x] Desktop-only Node HTTP callback server is isolated to auth callback handling.
- [x] OAuth callback response escapes untrusted query-string content before rendering HTML.
- [ ] Plugin loads in a clean test vault without console errors.
- [ ] Setup wizard completes on desktop and mobile token-import flow is validated.
- [ ] Commands verified: sync now, push changes, pull changes, pause sync, resume sync.
- [ ] Disable/enable cycle verified to avoid listener or timer leaks.

## Quality checks

- [x] `npm run lint` passes with zero errors and zero warnings.
- [x] `npm run build` succeeds with no type errors.
- [x] `wc -c main.js` stays under 200 KB.
- [ ] Manual install verified in `<Vault>/.obsidian/plugins/gdrive-sync/`.
