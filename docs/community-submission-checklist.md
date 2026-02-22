# Community submission checklist

Use this checklist before publishing a release to the Obsidian community catalog.

## Metadata and packaging

- [x] `manifest.json` includes valid `id`, `name`, `version`, `minAppVersion`, `description`, and `isDesktopOnly`.
- [x] `id` matches plugin folder name (`gdrive-sync`) and has not changed.
- [x] `versions.json` contains the current `version -> minAppVersion` mapping.
- [ ] Release tag exactly matches `manifest.json.version` (no `v` prefix).
- [x] Release assets include `main.js`, `manifest.json`, and `styles.css`.

## Functional checks

- [ ] Plugin loads in a clean test vault without console errors.
- [ ] Setup wizard completes successfully on desktop.
- [ ] Manual commands work: sync, push, pull, pause, resume.
- [ ] No orphaned listeners/intervals after disable and re-enable.
- [ ] Offline/reconnect path does not lose queued changes.

## Policy and privacy checks

- [x] README clearly documents Google API usage and the `drive.file` scope limitation.
- [x] README clearly states that selective sync settings are device-local.
- [x] README explains version history behavior differences from Obsidian Sync.
- [ ] No hidden telemetry or remote code execution behavior.
- [ ] External data flow is limited to user-initiated Google Drive sync behavior.

## Quality checks

- [x] `npm run lint` passes with zero errors and zero warnings.
- [x] `npm run build` succeeds with no type errors.
- [x] `wc -c main.js` is within size budget.
- [ ] Manual install verified by copying artifacts into `<Vault>/.obsidian/plugins/gdrive-sync/`.
