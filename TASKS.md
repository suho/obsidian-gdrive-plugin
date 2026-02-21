# Tasks — Obsidian Google Drive Sync

> Derived from [PLANS.md](./PLANS.md). Each task is a discrete unit of work.
> Status: `[ ]` = todo, `[~]` = in progress, `[x]` = done

---

## Phase 1 — Foundation + Auth ✅

### 1.1 Project Setup
- [x] Rename `package.json` name from `obsidian-sample-plugin` to `obsidian-gdrive-sync`
- [x] Update `tsconfig.json` lib to include `ES2015`, `ES2017`, `ES2018` (needed for async/await and modern APIs)
- [x] Add `diff-match-patch` as a dependency (`npm install diff-match-patch`)
- [x] Add `@types/diff-match-patch` as a dev dependency
- [x] Verify esbuild bundles `diff-match-patch` correctly (not marked as external)
- [x] Update `.gitignore` to ensure `main.js` is ignored (build artifact)

### 1.2 Types & Settings
- [x] Create `src/types.ts` — define `SyncRecord`, `SyncStatus`, `ConflictInfo`, `SyncEvent`, `ActivityLogEntry` interfaces
- [x] Rewrite `src/settings.ts` — full `GDrivePluginSettings` interface with all fields from PLANS.md section 10.1
- [x] Define `DEFAULT_SETTINGS` with correct defaults (auto-sync on, pull 30s, quiescence 2s, etc.)
- [x] Add platform detection helper to set `wifiOnlySync` default based on mobile vs desktop

### 1.3 Google OAuth 2.0 + PKCE
- [x] Create `src/auth/GoogleAuthManager.ts` — OAuth2 flow orchestrator
- [x] Implement PKCE code verifier + challenge generation (using Web Crypto API)
- [x] Implement desktop auth flow: open browser → localhost redirect → exchange code for tokens
- [x] Create `src/auth/OAuthCallbackServer.ts` — temporary localhost HTTP server for OAuth callback (desktop only)
- [x] Implement mobile auth flow: system browser → `obsidian://gdrive-callback` URI scheme → exchange code
- [x] Implement token storage: persist only `refreshToken` in settings, never `accessToken`
- [x] Implement proactive token refresh: refresh access token 5 minutes before `tokenExpiry`
- [x] Implement `invalid_grant` handling: show persistent "Re-authenticate" notice
- [x] Implement automatic 401 → refresh → retry wrapper for all API calls
- [x] Register `authenticate` command in `main.ts` to trigger auth flow

### 1.4 Setup Wizard (Steps 1-2)
- [x] Create `src/ui/SetupWizard.ts` — multi-step Modal subclass
- [x] Step 1: "Connect Google Account" button → trigger auth → show connected email on success
- [x] Step 2: "Create new folder" input + "Select existing folder" option (list folders via API)
- [x] Add `drive.file` scope limitation warning: "Files must be uploaded through this plugin"
- [x] Wire wizard to trigger on plugin load when `setupComplete === false`
- [x] On wizard completion: set `setupComplete = true`, save `gDriveFolderId` and `gDriveFolderName`

### 1.5 Basic Drive Client
- [x] Create `src/gdrive/DriveClient.ts` — wrapper around Obsidian's `requestUrl`
- [x] Implement `uploadFile(path, content, mimeType)` → returns GDrive file ID
- [x] Implement `downloadFile(fileId)` → returns file content (ArrayBuffer)
- [x] Implement `listFiles(folderId, pageToken?, pageSize?)` → returns file metadata array
- [x] Implement `deleteFile(fileId)` → trash file on GDrive
- [x] Implement `createFolder(name, parentId?)` → returns folder ID
- [x] Implement `updateFile(fileId, content)` → update existing file
- [x] Implement `getFileMetadata(fileId, fields)` → returns partial metadata
- [x] Add `Authorization: Bearer <token>` header injection via GoogleAuthManager
- [x] Add resumable upload support for files > 5 MB
- [x] Handle `storageQuotaExceeded` error as a named error type

---

## Phase 2 — Core Sync Engine

### 2.1 Sync Database
- [x] Create `src/sync/SyncDatabase.ts`
- [x] Implement load from `.obsidian/plugins/gdrive-sync/sync-db.json`
- [x] Implement save (atomic write with backup of previous state)
- [x] Implement CRUD: `getRecord(path)`, `setRecord(path, record)`, `deleteRecord(path)`, `getAllRecords()`
- [x] Implement `getByGDriveId(fileId)` lookup (for rename tracking)
- [x] Handle missing/corrupted sync-db gracefully (rebuild from scratch)

### 2.2 File Exclusion Rules
- [x] Create `src/sync/exclusions.ts`
- [x] Implement hardcoded exclusion list (`.git`, `.DS_Store`, `.trash`, `node_modules`, `.obsidian/cache`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, dot-prefixed folders except `.obsidian`)
- [x] Implement `isExcluded(path, userExclusions, settings)` — checks hardcoded + user exclusions + file type toggles + max file size
- [x] Add file type detection from extension for selective sync toggles
- [x] Write unit-testable pure function (no Obsidian API dependency)

### 2.3 Upload Manager
- [x] Create `src/sync/UploadManager.ts`
- [x] Implement single file push: read local → upload to GDrive → update SyncDatabase
- [x] Handle new file (create on GDrive) vs existing file (update on GDrive using stored fileId)
- [x] Implement rename push: update GDrive file name (preserves file ID and version history)
- [x] Implement delete push: trash file on GDrive + update SyncDatabase
- [x] Set `keepRevisionForever: true` on `.md` file uploads when setting is enabled
- [x] Skip excluded files (via `isExcluded`)
- [x] Maintain folder hierarchy on GDrive (create intermediate folders as needed)

### 2.4 Download Manager
- [x] Create `src/sync/DownloadManager.ts`
- [x] Implement single file pull: download from GDrive → write to local vault → update SyncDatabase
- [x] Implement **active file protection**: check `app.workspace.getActiveFile()` before writing
- [x] Implement `pendingDownloads` queue for deferred downloads
- [x] Register `workspace.on('active-leaf-change')` to process pending downloads
- [x] Handle new remote file (create locally) vs updated remote file (overwrite locally)
- [x] Handle remote deletion: soft-delete local file → move to `.obsidian/plugins/gdrive-sync/trash/`
- [x] Handle remote rename: rename local file + update SyncDatabase path mapping

### 2.5 Change Tracker (Incremental Pull)
- [x] Create `src/gdrive/ChangeTracker.ts`
- [x] Implement `getStartPageToken()` — initial token from GDrive API
- [x] Implement `listChanges(pageToken)` → returns list of changed files + next pageToken
- [x] Store `lastSyncPageToken` in settings after each successful pull
- [x] Handle pagination (loop until no `nextPageToken`)
- [x] Filter changes to only files within our vault folder

### 2.6 Manual Sync Command
- [x] Create `src/sync/SyncManager.ts` — orchestrator class
- [x] Implement `runSync()`: pull (via ChangeTracker + DownloadManager) then push (via UploadManager)
- [x] Wire `sync-now` command in `main.ts` to call `SyncManager.runSync()`
- [x] Add basic error handling: catch + log + show Notice on failure

### 2.7 Status Bar (Basic)
- [x] Create `src/ui/SyncStatusBar.ts`
- [x] Add status bar item in `main.ts` onload
- [x] Implement state updates: synced (green), syncing (blue), error (red)
- [x] Show file count during sync: "Syncing 3 files..."
- [x] Click handler: show Notice with last sync time (basic; full activity log comes later)

---

## Phase 3 — Auto-Sync + Offline

### 3.1 File Watcher
- [x] Register `vault.on('modify')` event → add to push queue with quiescence delay
- [x] Register `vault.on('create')` event → add to push queue immediately (no debounce)
- [x] Register `vault.on('delete')` event → add to push queue immediately
- [x] Register `vault.on('rename')` event → add to push queue immediately
- [x] Use `this.registerEvent()` for all vault listeners (proper cleanup on unload)
- [x] Filter all events through `isExcluded()` before queueing

### 3.2 Quiescence-Based Auto-Push
- [x] Create `src/utils/debounce.ts` — typed trailing-edge debounce utility
- [x] Implement per-file quiescence timer: reset on each `modify` event, fire after `pushQuiescenceMs` of inactivity
- [x] On quiescence timer fire: push single file via UploadManager
- [x] Ensure `create`/`delete`/`rename` bypass quiescence (immediate push)

### 3.3 Periodic Auto-Pull
- [x] Register interval via `this.registerInterval()` for pull polling
- [x] Pull every `pullIntervalSeconds` using ChangeTracker + DownloadManager
- [x] Skip pull if sync is paused (`syncPaused` setting)
- [x] Skip pull if offline (connectivity check first)

### 3.4 Offline Queue
- [x] Create offline queue data structure in SyncManager
- [x] Persist queue to `.obsidian/plugins/gdrive-sync/offline-queue.json` on each change
- [x] Load queue on plugin startup
- [x] On connectivity restored: replay queue in order, then resume normal sync
- [x] Register `window.addEventListener('online')` and `window.addEventListener('offline')`
- [x] Use `this.registerDomEvent()` for proper cleanup

### 3.5 Connectivity Detection
- [x] Create `src/utils/network.ts`
- [x] Implement `isOnline()` — check `navigator.onLine` + optional GDrive API ping
- [x] Implement Wi-Fi detection: check `navigator.connection?.type` (with graceful fallback)
- [x] Apply `wifiOnlySync` setting: skip sync on cellular when enabled

### 3.6 Visibility Change Handlers (Mobile)
- [x] Register `document.visibilitychange` listener via `this.registerDomEvent()`
- [x] On `visible`: trigger immediate pull (critical for mobile foreground resume)
- [x] On `hidden`: flush pending push queue (mobile going to background)

### 3.7 Sync Lock
- [x] Add `private syncLock = false` to SyncManager
- [x] Guard `runSync()` with lock check: skip if already running
- [x] Ensure lock is released in `finally` block (even on errors)

### 3.8 Pause / Resume Commands
- [x] Register `pause-sync` command: set `syncPaused = true`, update status bar
- [x] Register `resume-sync` command: set `syncPaused = false`, trigger immediate sync, update status bar

---

## Phase 4 — Merge & Conflict Resolution

### 4.1 Snapshot Manager
- [ ] Create `src/sync/SnapshotManager.ts`
- [ ] Implement `saveSnapshot(path, content)` — gzip + write to `snapshots/` directory
- [ ] Implement `loadSnapshot(path)` → returns base version content (or null if no snapshot)
- [ ] Implement `deleteSnapshot(path)` — cleanup after conflict resolved
- [ ] Implement pruning: remove snapshots older than 30 days with no pending changes
- [ ] Only snapshot `.md` files (binary files use last-modified-wins)
- [ ] Exclude `snapshots/` directory from sync

### 4.2 Merge Engine
- [ ] Create `src/sync/MergeEngine.ts`
- [ ] Import and wrap `diff-match-patch` library
- [ ] Implement `threeWayMerge(base, local, remote)` → returns `{ merged: string, hasConflicts: boolean, conflictRegions: Region[] }`
- [ ] Handle clean merge (no overlapping patches) → return merged text
- [ ] Handle conflicting merge → insert `<<<<<<<` / `=======` / `>>>>>>>` markers
- [ ] Implement JSON deep merge for `.obsidian/` config files (local keys overlaid on remote)

### 4.3 Conflict Resolver
- [ ] Create `src/sync/ConflictResolver.ts`
- [ ] Implement conflict detection: `localHash ≠ lastSyncedHash AND remoteHash ≠ lastSyncedHash`
- [ ] Dispatch to correct strategy based on file type and settings:
  - [ ] Markdown + auto-merge → call MergeEngine.threeWayMerge()
  - [ ] Markdown + conflict-file → create `.sync-conflict-YYYYMMDD-HHMMSS.md`
  - [ ] Markdown + local-wins → keep local, overwrite remote
  - [ ] Markdown + remote-wins → keep remote, overwrite local
  - [ ] Binary → last-modified-wins (timestamp comparison)
  - [ ] JSON config → deep merge
- [ ] Save pre-merge snapshots of both versions before any resolution
- [ ] Log conflict event to activity log

### 4.4 Conflict Modal
- [ ] Create `src/ui/ConflictModal.ts`
- [ ] Show file path + modification timestamps (local device name, remote device name)
- [ ] Implement side-by-side diff view (local vs remote, with diff highlighting)
- [ ] Buttons: "Keep local", "Keep remote", "Auto-merge", "Keep both"
- [ ] Wire each button to corresponding ConflictResolver strategy
- [ ] Close modal and trigger sync after resolution

### 4.5 Setup Wizard (Steps 3-5)
- [ ] Step 3: Initial state detection — scan local vault (hash all files) + scan remote folder (list all files)
- [ ] Present summary: "GDrive folder is empty — vault will be uploaded" OR "X remote files found — review before proceeding"
- [ ] Step 4: Conflict review table — for each conflicting file show: path, local size/date, remote size/date, action dropdown (Keep Local / Keep Remote / Keep Both)
- [ ] Step 5: Confirmation summary — "X files will be uploaded, Y downloaded, Z conflicts resolved" + Confirm button
- [ ] On confirm: execute initial sync with progress modal
- [ ] **Never auto-resolve conflicts on first sync** — always require user review

---

## Phase 5 — UI Polish + Advanced Features

### 5.1 Activity Log Sidebar
- [ ] Create `src/ui/ActivityLogView.ts` — extends `ItemView`
- [ ] Register view type in `main.ts`
- [ ] Implement activity log data structure (circular buffer, max 1000 entries)
- [ ] Persist recent log entries to disk (survive plugin reload)
- [ ] Implement filter buttons: All / Pushed / Pulled / Merged / Conflicts / Errors / Deleted
- [ ] Implement search box (filter by file path)
- [ ] Show entries: timestamp, direction icon (↑↓⚡🗑), action, file path
- [ ] Merge entries: expandable "View merge diff" link
- [ ] Deleted entries: "Restore from Drive" action link
- [ ] Register `view-activity-log` command to open/focus the sidebar

### 5.2 Version History Modal
- [ ] Create `src/ui/VersionHistoryModal.ts`
- [ ] Fetch revisions from GDrive Revisions API for the selected file
- [ ] Left panel: list of revisions with timestamps + device info
- [ ] Right panel: content preview of selected revision
- [ ] Diff toggle: compare selected revision vs current local version
- [ ] "Restore this version" button → download revision content → overwrite local → push to remote
- [ ] Add file menu item: right-click file → "View Google Drive history"

### 5.3 Deleted Files Modal
- [ ] Create `src/ui/DeletedFilesModal.ts`
- [ ] List files from local trash (`.obsidian/plugins/gdrive-sync/trash/`)
- [ ] List files from GDrive Trash (API: `files.list` with `trashed=true`)
- [ ] Show: file path, deletion date, source (local/remote)
- [ ] "Restore" button: move file back to original location + update sync state
- [ ] Register `view-deleted-files` command

### 5.4 Largest Files Modal
- [ ] Create `src/ui/LargestFilesModal.ts`
- [ ] Query GDrive API: `files.list` sorted by `quotaBytesUsed desc`, top 20
- [ ] Show: file path, size, last modified
- [ ] Link to GDrive storage settings: `drive.google.com/settings/storage`
- [ ] Register `view-largest-files` command

### 5.5 Selective Sync Settings UI
- [ ] Add file type toggles to SettingTab: images, audio, video, PDFs, other types
- [ ] Add max file size slider
- [ ] Add "Excluded folders" button → opens folder picker modal
- [ ] Add note: "These settings apply only to this device"
- [ ] On toggle change: re-evaluate exclusions, queue any newly-included files for push

### 5.6 Vault Config Sync
- [ ] Implement granular `.obsidian/` sync toggles (editor settings, appearance, hotkeys, community plugin list)
- [ ] Map each toggle to specific `.obsidian/` files:
  - [ ] Editor settings → `app.json`
  - [ ] Appearance → `appearance.json`, `themes/`, `snippets/`
  - [ ] Hotkeys → `hotkeys.json`
  - [ ] Community plugin list → `community-plugins.json` (list only, not binaries)
- [ ] **Never sync:** `workspace.json`, `workspace-mobile.json`, `cache/`, `plugins/*/main.js`

### 5.7 Progress Modal
- [ ] Create `src/ui/ProgressModal.ts`
- [ ] Show during initial sync and force full re-sync
- [ ] Display: progress bar, file count (X of Y), current file name, elapsed time
- [ ] Cancel button: stop sync, keep partial state
- [ ] Prevent modal dismissal by clicking outside (only Cancel button)

### 5.8 Full Settings Tab
- [ ] Rewrite `src/ui/SettingTab.ts` with all sections from PLANS.md section 7.2
- [ ] Account section: connected email, storage usage, remote folder, Sign Out
- [ ] Sync behavior section: auto-sync, pull interval, quiescence delay, sync on startup, Wi-Fi only
- [ ] Conflict resolution section: markdown strategy radio, binary strategy dropdown
- [ ] Selective sync section: file type toggles, max size, excluded folders
- [ ] Vault config sync section: granular toggles
- [ ] Version history section: keep revisions forever toggle + warning
- [ ] Advanced section: buttons for activity log, deleted files, largest files, force re-sync, reset state, export debug

### 5.9 All Command Registrations
- [ ] Register `push-changes` command
- [ ] Register `pull-changes` command
- [ ] Register `view-activity-log` command
- [ ] Register `view-conflicts` command
- [ ] Register `view-deleted-files` command
- [ ] Register `view-largest-files` command
- [ ] Register `open-settings` command
- [ ] Add ribbon icon (cloud) → trigger `sync-now`

### 5.10 Status Bar Enhancement
- [ ] Add all 6 states (synced, syncing, pending, offline, error, conflict)
- [ ] Animated spinner for syncing state
- [ ] Click → open Activity Log sidebar (desktop) or status modal (mobile)
- [ ] Show file count in tooltip during sync
- [ ] Show queued change count when pending
- [ ] Persistent error/conflict badge until resolved

---

## Phase 6 — Hardening + Release

### 6.1 Rate Limiter
- [ ] Create `src/gdrive/RateLimiter.ts`
- [ ] Implement token bucket algorithm for request throttling
- [ ] Track daily quota usage (reset at midnight UTC)
- [ ] Implement exponential backoff on 429/403 (minimum 60s retry)
- [ ] Surface quota usage estimate in settings UI
- [ ] Warn user when projected to exceed daily quota

### 6.2 Storage Full Handling
- [ ] Catch `storageQuotaExceeded` in DriveClient
- [ ] Pause all uploads on storage full
- [ ] Show persistent status bar notification
- [ ] Resume only after user explicitly acknowledges (not automatic)

### 6.3 Token Refresh Resilience
- [ ] Test: token expires during sync → verify automatic refresh + retry
- [ ] Test: refresh token revoked → verify persistent re-auth prompt
- [ ] Test: network timeout during refresh → verify graceful retry
- [ ] Ensure no infinite retry loops

### 6.4 Large Vault Optimization
- [ ] Implement batched file listing (`pageSize=1000`) for initial remote index
- [ ] Implement concurrent upload/download with limit of 3 simultaneous transfers
- [ ] Profile and optimize SyncDatabase operations for 10K+ records
- [ ] Lazy-load sync-db.json (don't block plugin startup)

### 6.5 Force Full Re-Sync
- [ ] Implement two-step confirmation dialog
- [ ] Step 1: "This will compare all local and remote files. Continue?"
- [ ] Step 2: Show diff summary — "X files will be uploaded, Y downloaded, Z conflicts" + final confirm
- [ ] Execute with ProgressModal
- [ ] Never silently overwrite — always show what will change

### 6.6 Reset Sync State
- [ ] Implement warning dialog: "This will clear the sync database. All files will be re-compared on next sync."
- [ ] Delete `sync-db.json` + `offline-queue.json` + `snapshots/`
- [ ] Clear `lastSyncPageToken`
- [ ] Trigger fresh initial sync flow

### 6.7 Edge Case Testing
- [ ] Test: rapid file edits (10 saves in 5 seconds) → verify single upload after quiescence
- [ ] Test: file renamed during sync → verify correct state update
- [ ] Test: file deleted on both sides simultaneously → verify no error
- [ ] Test: network drops mid-upload → verify resumable upload recovery
- [ ] Test: app crash during sync → verify state recovery on restart
- [ ] Test: two devices sync simultaneously → verify no duplicate files
- [ ] Test: empty file → verify correct handling (not skipped, not errored)
- [ ] Test: file with special characters in name → verify GDrive compatibility
- [ ] Test: vault with 0 files → verify no errors
- [ ] Test: GDrive folder manually deleted → verify graceful error + re-setup prompt

### 6.8 Cleanup & Plugin Lifecycle
- [ ] Verify all `registerEvent`, `registerDomEvent`, `registerInterval` calls have matching cleanup
- [ ] Verify `onunload()` stops all pending syncs, clears timers, closes any open modals
- [ ] Verify no memory leaks from event listeners
- [ ] Verify no orphaned intervals after plugin disable/re-enable

### 6.9 Build & Lint
- [ ] Run `npm run lint` — fix all ESLint errors
- [ ] Run `npm run build` — verify clean production build
- [ ] Verify `main.js` bundle size is reasonable (target: < 200 KB)
- [ ] Verify no Obsidian API deprecation warnings
- [ ] Test manual install: copy `main.js` + `manifest.json` + `styles.css` to test vault

### 6.10 Documentation & Release Prep
- [ ] Write README.md: features, installation, setup guide, FAQ, known limitations
- [ ] Document `drive.file` scope limitation prominently
- [ ] Document that selective sync settings are device-local
- [ ] Document version history retention differences from Obsidian Sync
- [ ] Update `manifest.json` version + `versions.json` mapping
- [ ] Prepare release artifacts: `main.js`, `manifest.json`, `styles.css`
- [ ] Review against Obsidian plugin guidelines for community submission
