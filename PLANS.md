# Obsidian Google Drive Sync — Implementation Plan

> **Plugin ID:** `gdrive-sync` | **Entry point:** `src/main.ts` | **Mobile:** Yes (`isDesktopOnly: false`)

---

## 1. Feature Parity with Obsidian Sync

| # | Feature | Target | Priority | Notes |
|---|---|---|---|---|
| 1 | Cross-platform sync (macOS, Windows, Linux, iOS, Android) | Yes | P0 | Via Google Drive REST API v3 — no native GDrive app needed |
| 2 | Offline-first / work offline, sync later | Yes | P0 | Full local vault; queue changes while offline |
| 3 | Auto-sync in background (foreground only on mobile) | Yes | P0 | Event-driven push + periodic pull; **foreground only on iOS/Android** |
| 4 | Conflict resolution — auto-merge (diff-match-patch) | Yes | P0 | Three-way merge for `.md`; last-modified-wins for binary |
| 5 | Conflict resolution — create conflict file | Yes | P0 | `.sync-conflict-YYYYMMDD-HHMMSS.md` naming |
| 6 | Selective sync (toggle images, audio, video, PDFs) | Yes | P0 | Per-type toggles + folder exclude list; **settings are device-local** |
| 7 | Version history (view & restore snapshots) | Yes | P1 | GDrive revisions API + `keepRevisionForever` for `.md` files |
| 8 | Deleted file recovery | Yes | P1 | GDrive Trash + local soft-delete log (7-day grace) |
| 9 | Sync activity log | Yes | P0 | Rich sidebar with filtering |
| 10 | Vault configuration sync (settings, themes, snippets) | Yes | P1 | Granular toggles; device profiles via separate config |
| 11 | Status bar icon & messages | Yes | P0 | 6 states: synced, syncing, pending, offline, error, conflict |
| 12 | E2E encryption | No | — | Out of scope per user request |
| 13 | Shared / collaborative vaults | Future | P2 | Via Google Drive shared folders |
| 14 | Storage | Uses user's GDrive quota | P0 | 15 GB free tier |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Obsidian App                      │
│  ┌───────────────────────────────────────────────┐  │
│  │            GDrive Sync Plugin                 │  │
│  │                                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │  │  File     │  │  Sync    │  │  Merge     │  │  │
│  │  │  Watcher  │→ │  Queue   │→ │  Engine    │  │  │
│  │  └──────────┘  └──────────┘  └────────────┘  │  │
│  │       │              │              │         │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │  │  Sync    │  │  Offline │  │  Conflict  │  │  │
│  │  │  State DB│  │  Buffer  │  │  Resolver  │  │  │
│  │  └──────────┘  └──────────┘  └────────────┘  │  │
│  │                     │                         │  │
│  │              ┌──────────────┐                  │  │
│  │              │  GDrive API  │                  │  │
│  │              │  Client      │                  │  │
│  │              └──────┬───────┘                  │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────┘
                           │ HTTPS (REST API v3)
                    ┌──────▼──────┐
                    │ Google Drive│
                    └─────────────┘
```

### Core Design Decisions

1. **No native GDrive app dependency.** Plugin talks directly to GDrive REST API v3. Critical because iOS/Android have no usable GDrive filesystem integration for Obsidian vaults.

2. **State tracking via separate JSON file.** Sync state in `.obsidian/plugins/gdrive-sync/sync-db.json` (NOT in `data.json` — avoids slow `loadData`/`saveData` on large vaults). Tracks: file path, local hash (MD5), remote GDrive file ID, remote hash, last synced timestamp.

3. **Delta sync, not full sync.** Only changed files are uploaded/downloaded, using GDrive's `modifiedTime` and MD5 checksums.

4. **OAuth 2.0 with PKCE.** No third-party proxy server. Localhost redirect for desktop, custom URI scheme (`obsidian://gdrive-callback`) for mobile.

5. **`drive.file` scope.** Most restrictive — plugin can only access files it created. **Important limitation:** files manually uploaded to GDrive via web UI or other apps are invisible to the plugin. Must be disclosed prominently in setup wizard and settings.

---

## 3. Sync Engine

### 3.1 File Change Detection

- **Primary:** Obsidian vault events (`vault.on('modify' | 'create' | 'delete' | 'rename')`)
- **Secondary:** Periodic full scan (every 5 min, configurable) comparing MD5 hashes against sync-db — catches changes made outside Obsidian

Each detected change enters the **Sync Queue** with: `action`, `path`, `localHash`, `timestamp`, `retryCount`.

### 3.2 Sync Cycle (Push + Pull)

```
SYNC CYCLE:
  1. CHECK CONNECTIVITY
     └─ If offline → buffer to Offline Queue (persisted to disk)

  2. PULL (Remote → Local)
     a. changes.list with startPageToken (incremental — 1 API call)
     b. For each remote change:
        ├─ New file     → download to local (if not actively edited)
        ├─ Modified     → check for conflict, then download or merge
        ├─ Deleted      → soft-delete local (move to trash, 7-day grace)
        └─ Renamed      → rename local file

  3. PUSH (Local → Remote)
     a. Drain Sync Queue:
        ├─ New file     → upload to GDrive
        ├─ Modified     → upload (with conflict check against remote)
        ├─ Deleted      → trash on GDrive
        └─ Renamed      → update GDrive file name (preserves file ID)

  4. UPDATE STATE
     └─ Write new hashes & timestamps to sync-db.json

  5. UPDATE UI
     └─ Status bar, activity log
```

### 3.3 Auto-Sync Timing

| Event | Behavior |
|---|---|
| File modified in editor | **2s quiescence delay** → push single file |
| File created / deleted / renamed | Push **immediately** (no debounce) |
| Obsidian opened / resumed from background | Full pull → then push any queued |
| `document.visibilitychange` → `visible` | Trigger pull (critical for mobile) |
| `document.visibilitychange` → `hidden` | Flush pending push queue (mobile going to background) |
| Periodic interval | Pull every 30s (configurable 10s–5min) |
| Manual trigger (command / ribbon icon) | Full push + pull |

### 3.4 Offline Mode

1. **Detection:** `navigator.onLine` + GDrive API error codes (403, 503, network timeout)
2. **Buffering:** All local changes captured in Sync Queue, persisted to `offline-queue.json`
3. **Reconnection:** On `online` event, run full sync cycle. Offline queue replayed in order.
4. **UI:** Status bar shows "Offline — changes will sync when online" (cloud-slash icon)

### 3.5 Active File Protection

Before downloading a remote change to a file:
- Check if the file is currently open: `app.workspace.getActiveFile()`
- If active: **defer** to `pendingDownloads` queue
- Process deferred downloads when user navigates away: `workspace.on('active-leaf-change')`
- This prevents cursor jumps and content loss during active editing

---

## 4. Merge & Conflict Resolution

### 4.1 Conflict Detection

A conflict exists when: `localHash ≠ lastSyncedHash AND remoteHash ≠ lastSyncedHash` (both sides changed since last sync).

### 4.2 Resolution Strategies (User-Configurable)

| Strategy | Behavior | Default For |
|---|---|---|
| **Auto-merge** | Three-way merge using diff-match-patch; base = last synced version | Markdown files |
| **Create conflict file** | Save remote as `note.sync-conflict-YYYYMMDD-HHMMSS.md`, keep local | User choice |
| **Local wins** | Discard remote, overwrite with local | — |
| **Remote wins** | Discard local, overwrite with remote | — |
| **Last-modified-wins** | Timestamp comparison, newer wins | Binary files |
| **Deep merge** | JSON deep merge: local keys overlaid on remote | `.obsidian/` config JSON |

### 4.3 Three-Way Merge Detail (Markdown)

```
BASE    = last synced version (from snapshots/ directory)
LOCAL   = current local file
REMOTE  = current GDrive file

1. diff(BASE, LOCAL)  → local patches
2. diff(BASE, REMOTE) → remote patches
3. Apply both patch sets to BASE
4. If patches overlap → conflict region
   → mark with <<<< / >>>> markers OR create conflict file
5. If clean merge → save merged result
```

### 4.4 Base Snapshot Storage

- **Location:** `.obsidian/plugins/gdrive-sync/snapshots/` (excluded from sync)
- **Scope:** `.md` files only (binary uses last-modified-wins, no snapshot needed)
- **Format:** Gzipped text
- **Cleanup:** Prune snapshots older than 30 days with no pending changes

---

## 5. Google Drive API Integration

### 5.1 Authentication

**Desktop (macOS, Windows, Linux):**
1. Open browser → Google OAuth consent screen
2. User grants `drive.file` access
3. Redirect to `localhost:PORT` with auth code (PKCE)
4. Exchange code for refresh + access tokens
5. Store **refresh token only** in plugin settings

**Mobile (iOS, Android):**
1. Open system browser → Google OAuth consent screen
2. Redirect via `obsidian://gdrive-callback`
3. Exchange code for tokens
4. Store refresh token in plugin settings

**Token Management:**
- Store only `refreshToken` (long-lived) — never persist `accessToken` (1-hour, reconstructed on load)
- Proactively refresh access token **5 minutes before expiry**
- On `invalid_grant`: show persistent "Re-authenticate" button (don't silently fail)
- Every API call wrapped with automatic 401 → refresh → retry logic

### 5.2 Remote Vault Structure

```
Google Drive/
└── Obsidian Vaults/              ← root folder (created by plugin)
    └── <VaultName>/              ← matches vault name
        ├── .sync-metadata.json   ← device registry, sync tokens
        ├── daily-note.md
        ├── projects/
        │   └── roadmap.md
        ├── attachments/
        │   └── image.png
        └── .obsidian/            ← if config sync enabled
            ├── app.json
            ├── appearance.json
            └── community-plugins.json
```

### 5.3 API Optimization

| Technique | Purpose |
|---|---|
| `changes.list` with `startPageToken` | Incremental pull — 1 request returns ALL changes since last check |
| Batched `files.list` with `pageSize=1000` | Index 10K files in 10 API calls |
| `fields` parameter (partial responses) | Request only needed fields per file |
| Resumable uploads | For files > 5 MB; supports pause/resume |
| Exponential backoff | Handle 429/403 with minimum 60s retry |
| ETag caching | Avoid re-downloading unchanged files |
| Concurrency limit of 3 | Prevent rate limiting during bulk operations |

### 5.4 API Quota

Google Drive free tier: **12,000 queries/day** per project.

Budget with `changes.list` approach:
- Polling at 30s: ~2,880 poll requests/day (each returns all changes in 1 call)
- Remaining: ~9,000 for file uploads/downloads
- Sufficient for ~4,500 file operations/day

For power users with large vaults: add quota usage estimate in settings UI with warning if projected to exceed.

### 5.5 Storage Full Handling

When GDrive returns `storageQuotaExceeded`:
1. Stop all uploads immediately
2. Show persistent (non-dismissible) status bar notification: "Google Drive storage full — sync paused"
3. Add "View largest synced files" command for diagnostics
4. Link to `drive.google.com/settings/storage` in settings
5. Sync resumes only after user explicitly dismisses the warning

---

## 6. File Exclusion Rules

### 6.1 Hardcoded Exclusions (Never Synced)

```
.git/
.DS_Store
Thumbs.db
.trash/
node_modules/
.obsidian/cache/
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/plugins/*/main.js          # Never sync other plugin binaries
All dot-prefixed folders except .obsidian/
```

### 6.2 User-Configurable Exclusions

- **File type toggles:** images, audio, video, PDFs, "other types"
- **Folder exclusion list:** managed via settings UI
- **Max file size:** configurable, default 20 MB
- **All selective sync settings are device-local** — never propagated to other devices

---

## 7. UI/UX Design

### 7.1 First-Run Setup Wizard (`src/ui/SetupWizard.ts`)

Multi-step modal — the most critical UX flow for preventing data loss:

| Step | Content |
|---|---|
| 1. Authenticate | "Connect Google Account" button → show connected email after auth |
| 2. Select folder | Create new GDrive folder OR select existing (with `drive.file` scope warning) |
| 3. Initial scan | Scan local vault + remote folder; show summary of what will happen |
| 4. Conflict review | If conflicts detected: per-file "Keep Local / Keep Remote / Keep Both" table |
| 5. Confirm | Summary of actions ("X files upload, Y download, Z conflicts resolved") + confirm button |

### 7.2 Settings Tab (`src/ui/SettingTab.ts`)

Organized into sections:

**Account**
- Connected Google account email + Sign Out button
- Storage used / total (from GDrive quota API)
- Remote folder name + Change button

**Sync behavior**
- Auto-sync toggle (default: on)
- Pull interval: 10s–5min slider (default: 30s)
- Edit quiescence delay: 1s–10s slider (default: 2s)
- Sync on startup toggle (default: on)
- Wi-Fi only toggle (default: on for mobile, hidden on desktop)

**Conflict resolution**
- Markdown files: radio (Auto-merge / Conflict file / Local wins / Remote wins)
- Binary files: dropdown (Last modified wins / Conflict file)
- Config (JSON) files: Deep merge (not configurable)

**Selective sync**
- File type toggles: images, audio, video, PDFs, other
- Max file size slider
- Excluded folders: Manage button → folder picker

**Vault config sync**
- Toggles: editor settings, appearance, hotkeys, community plugin list

**Version history**
- Keep revisions forever toggle (default: on) with storage impact note

**Advanced**
- View activity log
- View deleted files
- View largest synced files
- Force full re-sync (with two-step confirmation)
- Reset sync state (with warning dialog)
- Export debug info

### 7.3 Status Bar Icon

| State | Icon | Tooltip | Color |
|---|---|---|---|
| Synced | cloud-check | "All changes synced" | Green |
| Syncing | cloud-spin (animated) | "Syncing 3 files..." | Blue |
| Pending | cloud-arrow-up | "2 changes waiting to sync" | Yellow |
| Offline | cloud-off | "Offline — 5 changes queued" | Gray |
| Error | cloud-alert | "Sync error — click for details" | Red |
| Conflict | cloud-lightning | "1 conflict needs attention" | Orange |

**Click:** Opens activity log sidebar (desktop) or status modal (mobile).

### 7.4 Activity Log Sidebar (`src/ui/ActivityLogView.ts`)

- Filter: All / Pushed / Pulled / Merged / Conflicts / Errors / Deleted
- Search box
- Entries: timestamp, direction icon, action, file path
- Merge entries: expandable "View merge diff" link
- Deleted entries: "Restore from Drive" link

### 7.5 Conflict Modal (`src/ui/ConflictModal.ts`)

Shows when conflict strategy is "Create conflict file" or user reviews conflicts:
- File path + modification timestamps (local device, remote device)
- Side-by-side diff view (local vs remote)
- Buttons: Keep Local / Keep Remote / Auto-Merge / Keep Both

### 7.6 Version History Modal (`src/ui/VersionHistoryModal.ts`)

Accessible via: right-click file → "View Google Drive history"
- Left panel: list of revisions with timestamps
- Right panel: content preview of selected revision
- Diff toggle: compare selected revision vs current
- Restore button

### 7.7 Command Palette

| Command ID | Name |
|---|---|
| `sync-now` | Sync now |
| `push-changes` | Push changes |
| `pull-changes` | Pull changes |
| `view-activity-log` | View activity log |
| `view-conflicts` | View conflicts |
| `view-deleted-files` | View deleted files |
| `view-largest-files` | View largest synced files |
| `pause-sync` | Pause sync |
| `resume-sync` | Resume sync |
| `open-settings` | Open settings |

---

## 8. Cross-Platform Considerations

### 8.1 Platform Matrix

| Feature | Desktop (macOS/Win/Linux) | iOS | Android |
|---|---|---|---|
| Auto-sync (foreground) | Yes | Yes | Yes |
| Background sync | Yes (app open) | **No** (foreground only) | **No** (foreground only) |
| OAuth flow | Browser → localhost redirect | System browser → URI scheme | System browser → URI scheme |
| File watching | vault.on() events | vault.on() events | vault.on() events |
| Offline queue | JSON file | JSON file | JSON file |
| Wi-Fi only option | Hidden (always sync) | Shown (default: on) | Shown (default: on) |
| Visibility change sync | Yes | Yes (critical) | Yes (critical) |

### 8.2 Mobile-Specific Behavior

- **No background sync.** Sync pauses when app is backgrounded. This matches Obsidian Sync behavior.
- **Foreground resume:** `document.visibilitychange` → `visible` triggers immediate pull.
- **Background flush:** `document.visibilitychange` → `hidden` flushes pending uploads.
- **Battery-aware:** Adaptive polling — 30s when active, paused when hidden.
- **Large initial sync:** Progress modal with file count, cancel option, and "Wi-Fi only" reminder.
- **Conflict resolution on small screens:** Simplified modal with clear action buttons.

---

## 9. Data Safety & Recovery

### 9.1 Never-Lose-Data Guarantees

1. **Local vault is always source of truth** — never delete local without confirmation or backup
2. **Soft-delete with 7-day grace** — remote deletions move local file to `.obsidian/plugins/gdrive-sync/trash/`
3. **Pre-merge snapshots** — both local and remote versions saved before any merge
4. **GDrive Trash** — deleted remote files recoverable for 30 days
5. **Sync state backup** — state file backed up before each sync cycle
6. **No "Upload All" / "Download All"** — replaced with safeguarded "Force full re-sync" requiring two-step confirmation

### 9.2 Error Recovery

| Error | Recovery |
|---|---|
| Network timeout mid-upload | Resumable upload resumes from last byte |
| App crash during sync | On restart: validate state file, replay incomplete operations |
| Corrupted sync state | "Reset sync state" command → full re-scan |
| Auth token expired | Automatic refresh; if refresh fails → persistent re-auth prompt |
| GDrive quota exceeded | Pause uploads, persistent notification, "View largest files" |
| `invalid_grant` (revoked access) | Persistent "Re-authenticate" button, don't silently fail |

---

## 10. Settings Schema

### 10.1 `GDrivePluginSettings` Interface

```typescript
interface GDrivePluginSettings {
  // Authentication (device-local)
  refreshToken: string;
  tokenExpiry: number;           // Unix timestamp
  connectedEmail: string;

  // Sync target
  gDriveFolderId: string;
  gDriveFolderName: string;

  // Sync behavior (device-local)
  autoSync: boolean;              // default: true
  pullIntervalSeconds: number;    // default: 30
  pushQuiescenceMs: number;       // default: 2000
  syncOnStartup: boolean;         // default: true
  wifiOnlySync: boolean;          // default: true on mobile, false on desktop
  maxFileSizeBytes: number;       // default: 20971520 (20 MB)
  keepRevisionsForever: boolean;  // default: true

  // Selective sync (device-local, never propagated)
  syncImages: boolean;            // default: true
  syncAudio: boolean;             // default: true
  syncVideo: boolean;             // default: false
  syncPdfs: boolean;              // default: true
  syncOtherTypes: boolean;        // default: true
  excludedPaths: string[];        // default: []

  // Conflict resolution
  mdConflictStrategy: 'auto-merge' | 'conflict-file' | 'local-wins' | 'remote-wins';
  binaryConflictStrategy: 'last-modified-wins' | 'conflict-file';

  // Vault config sync
  syncEditorSettings: boolean;    // default: true
  syncAppearance: boolean;        // default: true
  syncHotkeys: boolean;           // default: false
  syncCommunityPluginList: boolean; // default: false

  // Sync state (managed separately, not in data.json)
  // → stored in .obsidian/plugins/gdrive-sync/sync-db.json
  // → contains: Record<string, SyncRecord>

  // Internal
  setupComplete: boolean;         // default: false (triggers wizard)
  syncPaused: boolean;            // default: false
  lastSyncPageToken: string;      // GDrive changes API token
  deviceId: string;               // UUID generated on first run
}
```

### 10.2 `SyncRecord` (in sync-db.json)

```typescript
interface SyncRecord {
  gDriveFileId: string;
  localPath: string;
  localHash: string;              // MD5
  remoteHash: string;             // MD5 from GDrive
  lastSyncedTimestamp: number;    // Unix ms
  status: 'synced' | 'pending-push' | 'pending-pull' | 'conflict';
}
```

---

## 11. Module Structure

```
src/
  main.ts                        # Plugin lifecycle only (onload, onunload, command registration)
  settings.ts                    # GDrivePluginSettings interface + DEFAULT_SETTINGS
  types.ts                       # SyncRecord, ConflictInfo, SyncEvent, ActivityLogEntry types

  auth/
    GoogleAuthManager.ts         # OAuth2 + PKCE flow, token storage, proactive refresh
    OAuthCallbackServer.ts       # Localhost HTTP server for desktop OAuth callback

  sync/
    SyncManager.ts               # Orchestrator: schedules pull/push, sync lock mutex
    UploadManager.ts             # Upload queue, quiescence timer, resumable uploads
    DownloadManager.ts           # Download queue, active file protection, pending downloads
    ConflictResolver.ts          # Conflict detection + strategy dispatch
    MergeEngine.ts               # diff-match-patch three-way merge wrapper
    SyncDatabase.ts              # Load/save sync-db.json, record CRUD
    SnapshotManager.ts           # Base version snapshots for three-way merge
    exclusions.ts                # Hardcoded + user exclusion rules

  gdrive/
    DriveClient.ts               # Google Drive REST API v3 wrapper (using Obsidian's requestUrl)
    RateLimiter.ts               # Token bucket + quota tracking + exponential backoff
    ChangeTracker.ts             # pageToken-based incremental change listing

  ui/
    SetupWizard.ts               # First-run multi-step modal
    SyncStatusBar.ts             # Status bar item (6 states)
    ActivityLogView.ts           # Sidebar panel with filtering
    ConflictModal.ts             # Side-by-side diff + resolution buttons
    VersionHistoryModal.ts       # GDrive revision browser + restore
    LargestFilesModal.ts         # Storage diagnostic
    DeletedFilesModal.ts         # Trash browser + restore
    ProgressModal.ts             # Initial sync / bulk operation progress
    SettingTab.ts                # Full settings tab implementation

  utils/
    checksums.ts                 # MD5 computation (using Web Crypto API)
    pathUtils.ts                 # Path normalization, vault-relative helpers
    debounce.ts                  # Typed debounce/throttle utilities
    network.ts                   # Connectivity detection + Wi-Fi check
    logger.ts                    # Structured activity logging
```

---

## 12. Dependencies

| Package | Purpose | Bundle impact |
|---|---|---|
| `diff-match-patch` | Three-way text merging | ~50 KB |
| `obsidian` (API) | Plugin API, vault access, UI | External (not bundled) |
| Built-in `crypto` (Web Crypto API) | MD5 hashing | None |
| Built-in `requestUrl` (Obsidian) | HTTP requests to GDrive API | None |

No other dependencies. Keep the bundle minimal.

---

## 13. Build Configuration Notes

Current `tsconfig.json` has `"lib": ["DOM", "ES5", "ES6", "ES7"]` — this is missing modern async/Promise types needed by the sync engine. Must add `"ES2015"`, `"ES2017"` (for async/await), `"ES2018"` to match esbuild's `target: "es2018"`.

Current `package.json` has `"name": "obsidian-sample-plugin"` — must be renamed to `"obsidian-gdrive-sync"`.

---

## 14. Development Phases

### Phase 1 — Foundation + Auth (MVP-0)
- Project setup (rename, tsconfig fix, add diff-match-patch)
- Types and settings schema
- Google OAuth 2.0 + PKCE authentication
- Setup wizard (steps 1-2: auth + folder selection)
- Basic DriveClient (upload, download, list, delete)

### Phase 2 — Core Sync Engine (MVP-1)
- SyncDatabase (state tracking)
- File exclusion rules
- UploadManager (single file push)
- DownloadManager (single file pull + active file protection)
- ChangeTracker (incremental pull via changes.list)
- Manual sync command (push + pull)
- Status bar (basic states)

### Phase 3 — Auto-Sync + Offline (MVP-2)
- File watcher integration (vault events)
- Quiescence-based auto-push
- Periodic auto-pull
- Offline queue with persistence and replay
- Connectivity detection
- Visibility change handlers (mobile foreground/background)
- Sync lock (mutex)

### Phase 4 — Merge & Conflict Resolution
- SnapshotManager (base version storage)
- MergeEngine (diff-match-patch three-way merge)
- ConflictResolver (strategy dispatch)
- ConflictModal (UI for manual resolution)
- Setup wizard steps 3-5 (initial scan, conflict review, confirm)

### Phase 5 — UI Polish + Advanced Features
- Activity log sidebar
- Version history modal (GDrive revisions API)
- Deleted files modal (restore from trash)
- Largest files modal (storage diagnostic)
- Selective sync settings (file type toggles, folder exclusions)
- Vault config sync with granular toggles
- Progress modal for bulk operations
- Full settings tab with all sections
- Command palette actions (all 10 commands)

### Phase 6 — Hardening + Release
- Rate limiter with quota tracking
- Exponential backoff for all API errors
- Storage full handling
- Token refresh resilience
- Large vault optimization (batched listing, concurrency limits)
- Force full re-sync with two-step confirmation
- Edge case testing (rename chains, rapid edits, concurrent access)
- Lint, build verification
- README, documentation
- Community plugin submission preparation
