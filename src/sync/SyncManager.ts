import { Notice, TFile, normalizePath } from 'obsidian';
import type { DriveChange, DriveClient } from '../gdrive/DriveClient';
import { ChangeTracker } from '../gdrive/ChangeTracker';
import type GDriveSyncPlugin from '../main';
import type { ActivityAction, ActivityLogEntry, SyncQueueEntry } from '../types';
import { computeContentHash } from '../utils/checksums';
import { debounceTrailing, type DebouncedFn } from '../utils/debounce';
import { isOnline } from '../utils/network';
import { SyncStatusBar } from '../ui/SyncStatusBar';
import { ConflictResolver } from './ConflictResolver';
import { DownloadManager } from './DownloadManager';
import { isExcluded } from './exclusions';
import { SnapshotManager } from './SnapshotManager';
import { SyncDatabase } from './SyncDatabase';
import { UploadManager } from './UploadManager';

interface PullSummary {
	processed: number;
}

interface PushSummary {
	created: number;
	updated: number;
	renamed: number;
	deleted: number;
}

interface SyncSummary {
	pulled: number;
	created: number;
	updated: number;
	renamed: number;
	deleted: number;
}

interface OfflineQueuePayload {
	version: number;
	updatedAt: number;
	queue: SyncQueueEntry[];
}

interface ActivityLogPayload {
	version: number;
	updatedAt: number;
	entries: ActivityLogEntry[];
}

interface RunSyncOptions {
	progress?: (message: string) => void;
	shouldCancel?: () => boolean;
}

export interface SelectiveSyncSnapshot {
	syncImages: boolean;
	syncAudio: boolean;
	syncVideo: boolean;
	syncPdfs: boolean;
	syncOtherTypes: boolean;
	maxFileSizeBytes: number;
	excludedPaths: string[];
	syncEditorSettings: boolean;
	syncAppearance: boolean;
	syncHotkeys: boolean;
	syncCommunityPluginList: boolean;
}

type QueueAction = SyncQueueEntry['action'];

function emptyPushSummary(): PushSummary {
	return {
		created: 0,
		updated: 0,
		renamed: 0,
		deleted: 0,
	};
}

function isQueueAction(value: unknown): value is QueueAction {
	return value === 'create' || value === 'update' || value === 'delete' || value === 'rename';
}

function isQueueEntry(value: unknown): value is SyncQueueEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const entry = value as Record<string, unknown>;
	return (
		isQueueAction(entry.action) &&
		typeof entry.path === 'string' &&
		typeof entry.timestamp === 'number' &&
		typeof entry.retryCount === 'number' &&
		(typeof entry.oldPath === 'undefined' || typeof entry.oldPath === 'string') &&
		(typeof entry.localHash === 'undefined' || typeof entry.localHash === 'string')
	);
}

function parseOfflineQueuePayload(raw: string): SyncQueueEntry[] {
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('Invalid offline queue payload');
	}

	const payload = parsed as Partial<OfflineQueuePayload>;
	if (!Array.isArray(payload.queue)) {
		throw new Error('Invalid offline queue payload');
	}

	return payload.queue
		.filter(isQueueEntry)
		.map(entry => ({
			...entry,
			path: normalizePath(entry.path),
			oldPath: entry.oldPath ? normalizePath(entry.oldPath) : undefined,
		}));
}

function isActivityAction(value: unknown): value is ActivityAction {
	return (
		value === 'pushed' ||
		value === 'pulled' ||
		value === 'merged' ||
		value === 'conflict' ||
		value === 'deleted' ||
		value === 'restored' ||
		value === 'error' ||
		value === 'skipped'
	);
}

function isActivityEntry(value: unknown): value is ActivityLogEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === 'string' &&
		typeof entry.timestamp === 'number' &&
		isActivityAction(entry.action) &&
		typeof entry.path === 'string' &&
		(typeof entry.detail === 'undefined' || typeof entry.detail === 'string') &&
		(typeof entry.error === 'undefined' || typeof entry.error === 'string') &&
		(typeof entry.fileId === 'undefined' || typeof entry.fileId === 'string') &&
		(typeof entry.source === 'undefined' || entry.source === 'local' || entry.source === 'remote' || entry.source === 'system')
	);
}

function parseActivityLogPayload(raw: string): ActivityLogEntry[] {
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('Invalid activity log payload');
	}

	const payload = parsed as Partial<ActivityLogPayload>;
	if (!Array.isArray(payload.entries)) {
		throw new Error('Invalid activity log payload');
	}

	return payload.entries
		.filter(isActivityEntry)
		.slice(-1000);
}

function conflictAlreadyResolved(detail: string | undefined): boolean {
	if (!detail) {
		return false;
	}
	const normalized = detail.toLowerCase();
	return (
		normalized.includes('local version kept') ||
		normalized.includes('remote version kept') ||
		normalized.includes('conflict file created') ||
		normalized.includes('both versions kept') ||
		normalized.includes('last-modified-wins')
	);
}

function actionCanResolveConflict(action: ActivityAction): boolean {
	return action === 'pushed' || action === 'pulled' || action === 'merged' || action === 'restored' || action === 'deleted';
}

class SyncCancelledError extends Error {
	constructor() {
		super('Sync cancelled');
		this.name = 'SyncCancelledError';
	}
}

export class SyncManager {
	private static readonly FILE_OPEN_REFRESH_COOLDOWN_MS = 1500;

	private syncLock = false;
	private pushFlushInFlight = false;
	private pullInFlight = false;
	private replayInFlight = false;
	private lastAutoPullAt = 0;
	private isNetworkOffline = false;
	private readonly lastFileOpenRefreshAt = new Map<string, number>();

	private readonly modifyDebouncers = new Map<string, DebouncedFn<[]>>();
	private pendingPushQueue: SyncQueueEntry[] = [];
	private offlineQueue: SyncQueueEntry[] = [];

	private readonly dataDir: string;
	private readonly offlineQueuePath: string;
	private readonly activityLogPath: string;
	private readonly localTrashDirPath: string;
	private readonly activityLog: ActivityLogEntry[] = [];
	private readonly unresolvedConflictPaths = new Set<string>();
	private persistActivityLogChain: Promise<void> = Promise.resolve();
	private conflictAlertCount = 0;
	private errorAlertMessage = '';

	readonly syncDb: SyncDatabase;
	readonly snapshotManager: SnapshotManager;
	readonly uploadManager: UploadManager;
	readonly downloadManager: DownloadManager;
	readonly changeTracker: ChangeTracker;
	readonly conflictResolver: ConflictResolver;

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly statusBar: SyncStatusBar
	) {
		this.syncDb = new SyncDatabase(plugin);
		this.snapshotManager = new SnapshotManager(plugin);
		this.uploadManager = new UploadManager(plugin, driveClient, this.syncDb, this.snapshotManager);
		this.conflictResolver = new ConflictResolver(plugin, driveClient, this.snapshotManager, {
			logActivity: entry => {
				this.appendActivityEntry(entry);
			},
		});
		this.downloadManager = new DownloadManager(
			plugin,
			driveClient,
			this.syncDb,
			this.snapshotManager,
			this.conflictResolver
		);
		this.changeTracker = new ChangeTracker(plugin, driveClient, this.syncDb);
		this.dataDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
		this.offlineQueuePath = normalizePath(`${this.dataDir}/offline-queue.json`);
		this.activityLogPath = normalizePath(`${this.dataDir}/activity-log.json`);
		this.localTrashDirPath = normalizePath(`${this.dataDir}/trash`);
	}

	async initialize(): Promise<void> {
		await this.syncDb.load();
		await this.loadOfflineQueue();
		await this.loadActivityLog();
		this.rebuildConflictAlertsFromActivityLog();
		await this.snapshotManager.pruneSnapshots(this.collectPendingSnapshotPaths());
		this.downloadManager.registerHandlers();
		this.registerFileWatchers();
		this.registerPeriodicPull();
		this.registerConnectivityHandlers();
		this.registerVisibilityHandlers();
		await this.refreshConnectivityState(false);
		this.updateStatusFromCurrentState();
	}

	async pauseSync(): Promise<void> {
		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			return;
		}

		this.plugin.settings.syncPaused = true;
		await this.plugin.saveSettings();
		this.cancelAllModifyDebouncers();
		this.statusBar.setPaused();
	}

	async resumeSync(): Promise<void> {
		if (!this.plugin.settings.syncPaused) {
			return;
		}

		this.plugin.settings.syncPaused = false;
		await this.plugin.saveSettings();
		await this.refreshConnectivityState(false);
		this.updateStatusFromCurrentState();
	}

	async runSync(options?: RunSyncOptions): Promise<SyncSummary | null> {
		const checkCancelled = () => {
			if (options?.shouldCancel?.()) {
				throw new SyncCancelledError();
			}
		};

		if (this.syncLock) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Google Drive sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing();

		try {
			checkCancelled();
			options?.progress?.('Replaying offline queue');
			const replaySummary = await this.replayOfflineQueue();
			checkCancelled();
			options?.progress?.('Pulling remote changes');
			const pullSummary = await this.pullChanges();
			checkCancelled();
			options?.progress?.('Pushing queued local changes');
			const queuedPushSummary = await this.flushPendingPushQueue();
			checkCancelled();
			options?.progress?.('Scanning local vault for upload');
			const fullPushResult = await this.uploadManager.syncLocalVault();
			checkCancelled();

			const totalQueuedChanges =
				replaySummary.created +
				replaySummary.updated +
				replaySummary.renamed +
				replaySummary.deleted +
				queuedPushSummary.created +
				queuedPushSummary.updated +
				queuedPushSummary.renamed +
				queuedPushSummary.deleted;

			if (pullSummary.processed > 0 || totalQueuedChanges > 0 || fullPushResult.changedDb) {
				options?.progress?.('Saving sync database');
				await this.syncDb.save();
			}
			options?.progress?.('Pruning snapshots');
			await this.snapshotManager.pruneSnapshots(this.collectPendingSnapshotPaths());

			this.errorAlertMessage = '';
			this.statusBar.setSynced();
			return {
				pulled: pullSummary.processed,
				created: fullPushResult.summary.created + replaySummary.created + queuedPushSummary.created,
				updated: fullPushResult.summary.updated + replaySummary.updated + queuedPushSummary.updated,
				renamed: fullPushResult.summary.renamed + replaySummary.renamed + queuedPushSummary.renamed,
				deleted: fullPushResult.summary.deleted + replaySummary.deleted + queuedPushSummary.deleted,
			};
		} catch (err) {
			if (err instanceof SyncCancelledError) {
				this.logActivity('skipped', '/', 'Sync cancelled by user.');
				return null;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive sync failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Google Drive sync failed: ${message}`);
			return null;
		} finally {
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async runPushNow(): Promise<PushSummary | null> {
		if (this.syncLock || this.pushFlushInFlight) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Google Drive sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing(this.pendingPushQueue.length + this.offlineQueue.length);

		try {
			const replaySummary = await this.replayOfflineQueue();
			const queuedSummary = await this.flushPendingPushQueue();
			const fullPushResult = await this.uploadManager.syncLocalVault();
			if (
				replaySummary.created + replaySummary.updated + replaySummary.renamed + replaySummary.deleted > 0 ||
				queuedSummary.created + queuedSummary.updated + queuedSummary.renamed + queuedSummary.deleted > 0 ||
				fullPushResult.changedDb
			) {
				await this.syncDb.save();
			}

			this.errorAlertMessage = '';
			return {
				created: replaySummary.created + queuedSummary.created + fullPushResult.summary.created,
				updated: replaySummary.updated + queuedSummary.updated + fullPushResult.summary.updated,
				renamed: replaySummary.renamed + queuedSummary.renamed + fullPushResult.summary.renamed,
				deleted: replaySummary.deleted + queuedSummary.deleted + fullPushResult.summary.deleted,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive push failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Google Drive push failed: ${message}`);
			return null;
		} finally {
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async runPullNow(): Promise<PullSummary | null> {
		if (this.syncLock || this.pullInFlight) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Google Drive sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing();
		try {
			const summary = await this.pullChanges();
			if (summary.processed > 0) {
				await this.syncDb.save();
			}
			this.errorAlertMessage = '';
			return summary;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive pull failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Google Drive pull failed: ${message}`);
			return null;
		} finally {
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async forceFullResync(
		progress?: (message: string) => void,
		shouldCancel?: () => boolean
	): Promise<SyncSummary | null> {
		if (shouldCancel?.()) {
			return null;
		}

		const previousPageToken = this.plugin.settings.lastSyncPageToken;
		const previousSetupState = this.plugin.settings.setupComplete;
		try {
			progress?.('Resetting remote change token');
			this.plugin.settings.lastSyncPageToken = '';
			this.plugin.settings.setupComplete = true;
			await this.plugin.saveSettings();
			progress?.('Running full sync');
			return this.runSync({ progress, shouldCancel });
		} finally {
			this.plugin.settings.setupComplete = previousSetupState;
			if (!this.plugin.settings.lastSyncPageToken && previousPageToken) {
				this.plugin.settings.lastSyncPageToken = previousPageToken;
			}
			await this.plugin.saveSettings();
		}
	}

	getPendingChangeCount(): number {
		return this.pendingPushQueue.length + this.offlineQueue.length;
	}

	getConflictAlertCount(): number {
		return this.conflictAlertCount;
	}

	captureSelectiveSyncSnapshot(): SelectiveSyncSnapshot {
		return {
			syncImages: this.plugin.settings.syncImages,
			syncAudio: this.plugin.settings.syncAudio,
			syncVideo: this.plugin.settings.syncVideo,
			syncPdfs: this.plugin.settings.syncPdfs,
			syncOtherTypes: this.plugin.settings.syncOtherTypes,
			maxFileSizeBytes: this.plugin.settings.maxFileSizeBytes,
			excludedPaths: [...this.plugin.settings.excludedPaths],
			syncEditorSettings: this.plugin.settings.syncEditorSettings,
			syncAppearance: this.plugin.settings.syncAppearance,
			syncHotkeys: this.plugin.settings.syncHotkeys,
			syncCommunityPluginList: this.plugin.settings.syncCommunityPluginList,
		};
	}

	async handleSelectiveSyncSettingsChange(previous: SelectiveSyncSnapshot): Promise<number> {
		const current = this.captureSelectiveSyncSnapshot();
		const allPaths = await this.collectAllLocalPaths();
		let queued = 0;
		for (const path of allPaths) {
			const stat = await this.plugin.app.vault.adapter.stat(path);
			const oldExcluded = isExcluded(path, previous.excludedPaths, previous, this.plugin.app.vault.configDir, stat?.size);
			const newExcluded = isExcluded(path, current.excludedPaths, current, this.plugin.app.vault.configDir, stat?.size);
			if (!oldExcluded || newExcluded) {
				continue;
			}
			queued += this.queuePathForPush(path);
		}
		if (queued > 0) {
			this.updateStatusFromCurrentState();
			this.schedulePushQueueProcessing();
		}
		return queued;
	}

	private registerFileWatchers(): void {
		this.plugin.registerEvent(this.plugin.app.vault.on('modify', file => {
			if (!(file instanceof TFile)) {
				return;
			}
			this.handleFileModify(file.path);
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on('create', file => {
			if (!(file instanceof TFile)) {
				return;
			}
			this.handleImmediateLocalChange({
				action: 'create',
				path: file.path,
				timestamp: Date.now(),
				retryCount: 0,
			});
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on('delete', file => {
			if (!(file instanceof TFile)) {
				return;
			}
			this.handleImmediateLocalChange({
				action: 'delete',
				path: file.path,
				timestamp: Date.now(),
				retryCount: 0,
			});
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile)) {
				return;
			}
			this.handleFileRename(oldPath, file.path);
		}));

		this.plugin.registerEvent(this.plugin.app.workspace.on('file-open', file => {
			void this.handleFileOpen(file);
		}));
	}

	private registerPeriodicPull(): void {
		this.plugin.registerInterval(window.setInterval(() => {
			if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
				return;
			}

			const intervalMs = this.plugin.settings.pullIntervalSeconds * 1000;
			const now = Date.now();
			if (now - this.lastAutoPullAt < intervalMs) {
				return;
			}
			this.lastAutoPullAt = now;

			void this.runAutoPull();
		}, 5000));
	}

	private registerConnectivityHandlers(): void {
		this.plugin.registerDomEvent(window, 'offline', () => {
			void this.handleOfflineEvent();
		});

		this.plugin.registerDomEvent(window, 'online', () => {
			void this.handleOnlineEvent();
		});
	}

	private registerVisibilityHandlers(): void {
		this.plugin.registerDomEvent(document, 'visibilitychange', () => {
			void this.handleVisibilityChange();
		});
	}

	private handleFileModify(path: string): void {
		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		const normalizedPath = normalizePath(path);
		if (this.isExcludedPath(normalizedPath)) {
			return;
		}

		let debounced = this.modifyDebouncers.get(normalizedPath);
		if (!debounced) {
			debounced = debounceTrailing(() => {
				this.modifyDebouncers.delete(normalizedPath);
				this.handleImmediateLocalChange({
					action: 'update',
					path: normalizedPath,
					timestamp: Date.now(),
					retryCount: 0,
				});
			}, () => this.plugin.settings.pushQuiescenceMs);
			this.modifyDebouncers.set(normalizedPath, debounced);
		}

		debounced();
	}

	private handleFileRename(oldPath: string, newPath: string): void {
		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		const normalizedOldPath = normalizePath(oldPath);
		const normalizedNewPath = normalizePath(newPath);
		const oldExcluded = this.isExcludedPath(normalizedOldPath);
		const newExcluded = this.isExcludedPath(normalizedNewPath);

		this.cancelModifyDebouncer(normalizedOldPath);
		this.cancelModifyDebouncer(normalizedNewPath);

		if (oldExcluded && newExcluded) {
			return;
		}

		if (oldExcluded && !newExcluded) {
			this.handleImmediateLocalChange({
				action: 'create',
				path: normalizedNewPath,
				timestamp: Date.now(),
				retryCount: 0,
			});
			return;
		}

		if (!oldExcluded && newExcluded) {
			this.handleImmediateLocalChange({
				action: 'delete',
				path: normalizedOldPath,
				timestamp: Date.now(),
				retryCount: 0,
			});
			return;
		}

		this.handleImmediateLocalChange({
			action: 'rename',
			path: normalizedNewPath,
			oldPath: normalizedOldPath,
			timestamp: Date.now(),
			retryCount: 0,
		});
	}

	private handleImmediateLocalChange(entry: SyncQueueEntry): void {
		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		const normalizedEntry: SyncQueueEntry = {
			...entry,
			path: normalizePath(entry.path),
			oldPath: entry.oldPath ? normalizePath(entry.oldPath) : undefined,
		};

		if (normalizedEntry.action === 'rename') {
			if (!normalizedEntry.oldPath || this.isExcludedPath(normalizedEntry.oldPath) || this.isExcludedPath(normalizedEntry.path)) {
				return;
			}
		} else if (this.isExcludedPath(normalizedEntry.path)) {
			return;
		}

		this.cancelModifyDebouncer(normalizedEntry.path);
		if (normalizedEntry.oldPath) {
			this.cancelModifyDebouncer(normalizedEntry.oldPath);
		}

		this.pendingPushQueue.push(normalizedEntry);
		this.updateStatusFromCurrentState();
		this.schedulePushQueueProcessing();
	}

	private schedulePushQueueProcessing(): void {
		if (this.pushFlushInFlight || this.syncLock) {
			return;
		}
		void this.flushPendingPushQueue();
	}

	private async flushPendingPushQueue(): Promise<PushSummary> {
		if (this.pushFlushInFlight) {
			return emptyPushSummary();
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			return emptyPushSummary();
		}

		if (!this.plugin.settings.autoSync) {
			return emptyPushSummary();
		}

		if (this.pendingPushQueue.length === 0) {
			return emptyPushSummary();
		}

		this.pushFlushInFlight = true;
		let changedDb = false;
		const summary = emptyPushSummary();

		try {
			while (this.pendingPushQueue.length > 0) {
				const canSync = await this.refreshConnectivityState(false);
				if (!canSync) {
					await this.movePendingQueueToOffline();
					break;
				}

				const entry = this.pendingPushQueue.shift();
				if (!entry) {
					break;
				}
				this.statusBar.setSyncing(this.pendingPushQueue.length + 1);

				const changed = await this.pushSingleQueueEntry(entry, summary);
				changedDb = changedDb || changed;
			}

			if (changedDb) {
				await this.syncDb.save();
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Failed to flush push queue', err);
			this.statusBar.setError(message);
			this.logError('', message);
		} finally {
			this.pushFlushInFlight = false;
			this.updateStatusFromCurrentState();
		}

		return summary;
	}

	private async pushSingleQueueEntry(entry: SyncQueueEntry, summary: PushSummary): Promise<boolean> {
		if (entry.action === 'create' || entry.action === 'update') {
			const result = await this.uploadManager.pushFile(entry.path);
			if (result === 'created') {
				summary.created += 1;
				this.logActivity('pushed', entry.path, 'Uploaded new file.', undefined, 'local');
				return true;
			}
			if (result === 'updated') {
				summary.updated += 1;
				this.logActivity('pushed', entry.path, 'Uploaded updated file.', undefined, 'local');
				return true;
			}
			return false;
		}

		if (entry.action === 'delete') {
			const existingRecord = this.syncDb.getRecord(entry.path);
			const removed = await this.uploadManager.pushDelete(entry.path);
			if (removed) {
				summary.deleted += 1;
				this.logActivity('deleted', entry.path, 'Deleted on Google Drive.', existingRecord?.gDriveFileId, 'local');
			}
			return removed;
		}

		if (!entry.oldPath) {
			return false;
		}

		const renamed = await this.uploadManager.pushRename(entry.oldPath, entry.path);
		if (renamed) {
			summary.renamed += 1;
			this.logActivity('pushed', entry.path, `Renamed from ${entry.oldPath}.`, undefined, 'local');
		}
		return renamed;
	}

	private async runAutoPull(): Promise<void> {
		if (this.pullInFlight || this.syncLock) {
			return;
		}

		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		const canSync = await this.refreshConnectivityState(false);
		if (!canSync) {
			return;
		}

		this.pullInFlight = true;
		try {
			this.statusBar.setSyncing();
			const pullSummary = await this.pullChanges();
			if (pullSummary.processed > 0) {
				await this.syncDb.save();
			}
			await this.replayOfflineQueue();
			await this.flushPendingPushQueue();
			this.errorAlertMessage = '';
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Auto-pull failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
		} finally {
			this.pullInFlight = false;
			this.updateStatusFromCurrentState();
		}
	}

	private async pullChanges(): Promise<PullSummary> {
		const changes = await this.changeTracker.listChangesSinceLastSync();
		let processed = 0;

		for (const change of changes) {
			const result = await this.applyRemoteChange(change);
			if (result) {
				processed += 1;
			}
		}

		return { processed };
	}

	private async applyRemoteChange(change: DriveChange): Promise<boolean> {
		const before = this.syncDb.getByGDriveId(change.fileId);
		const result = await this.downloadManager.applyChange(change);
		const after = this.syncDb.getByGDriveId(change.fileId);

		if (result === 'pulled') {
			const path = after?.localPath ?? before?.localPath ?? change.file?.name ?? change.fileId;
			this.logActivity('pulled', path, 'Downloaded remote change.', change.fileId, 'remote');
		} else if (result === 'renamed') {
			const path = after?.localPath ?? change.file?.name ?? change.fileId;
			this.logActivity('pulled', path, 'Applied remote rename.', change.fileId, 'remote');
		} else if (result === 'deleted') {
			const path = before?.localPath ?? change.file?.name ?? change.fileId;
			this.logActivity('deleted', path, 'Applied remote deletion.', change.fileId, 'remote');
		}

		return result !== 'skipped' && result !== 'deferred';
	}

	private async handleOfflineEvent(): Promise<void> {
		this.isNetworkOffline = true;
		await this.movePendingQueueToOffline();
		this.updateStatusFromCurrentState();
	}

	private async handleOnlineEvent(): Promise<void> {
		const canSync = await this.refreshConnectivityState(false);
		if (!canSync) {
			return;
		}

		await this.replayOfflineQueue();
		await this.runAutoPull();
	}

	private async handleVisibilityChange(): Promise<void> {
		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		if (document.visibilityState === 'visible') {
			await this.runAutoPull();
			return;
		}

		if (document.visibilityState === 'hidden') {
			this.flushQuiescenceTimers();
			await this.flushPendingPushQueue();
		}
	}

	private async handleFileOpen(file: TFile | null): Promise<void> {
		if (!file || !this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}

		const path = normalizePath(file.path);
		if (this.isExcludedPath(path) || this.hasQueuedLocalChange(path)) {
			return;
		}

		const now = Date.now();
		const lastRefreshAt = this.lastFileOpenRefreshAt.get(path) ?? 0;
		const shouldPullOnOpen = now - lastRefreshAt >= SyncManager.FILE_OPEN_REFRESH_COOLDOWN_MS;
		this.lastFileOpenRefreshAt.set(path, now);

		if (shouldPullOnOpen && !this.pullInFlight && !this.syncLock && !this.replayInFlight) {
			const canSync = await this.refreshConnectivityState(false);
			if (canSync) {
				await this.runAutoPull();
			}
		}

		if (this.hasQueuedLocalChange(path)) {
			return;
		}

		if (this.pullInFlight || this.syncLock || this.replayInFlight || this.pushFlushInFlight) {
			return;
		}

		const applied = await this.downloadManager.processPendingDownloadForPath(path, true);
		if (applied) {
			await this.syncDb.save();
			this.statusBar.setSynced();
			return;
		}

		this.updateStatusFromCurrentState();
	}

	private async replayOfflineQueue(): Promise<PushSummary> {
		if (this.replayInFlight || this.offlineQueue.length === 0) {
			return emptyPushSummary();
		}

		if (this.plugin.settings.syncPaused) {
			return emptyPushSummary();
		}

		const canSync = await this.refreshConnectivityState(false);
		if (!canSync) {
			return emptyPushSummary();
		}

		this.replayInFlight = true;
		try {
			this.pendingPushQueue = [...this.offlineQueue, ...this.pendingPushQueue];
			this.offlineQueue = [];
			await this.persistOfflineQueue();
			return this.flushPendingPushQueue();
		} finally {
			this.replayInFlight = false;
		}
	}

	private async movePendingQueueToOffline(): Promise<void> {
		if (this.pendingPushQueue.length === 0) {
			return;
		}

		this.offlineQueue.push(...this.pendingPushQueue);
		this.pendingPushQueue = [];
		await this.persistOfflineQueue();
	}

	private async refreshConnectivityState(verifyDriveAccess: boolean): Promise<boolean> {
		const online = await isOnline({
			wifiOnly: this.plugin.settings.wifiOnlySync,
			ping: verifyDriveAccess ? async () => {
				await this.driveClient.getStartPageToken();
			} : undefined,
		});

		this.isNetworkOffline = !online;
		return online;
	}

	private updateStatusFromCurrentState(): void {
		if (this.syncLock || this.pushFlushInFlight || this.pullInFlight) {
			return;
		}

		const pendingCount = this.pendingPushQueue.length + this.offlineQueue.length;

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			return;
		}

		if (this.isNetworkOffline) {
			this.statusBar.setOffline(pendingCount);
			return;
		}

		if (this.errorAlertMessage) {
			this.statusBar.setError(this.errorAlertMessage);
			return;
		}

		if (this.conflictAlertCount > 0) {
			this.statusBar.setConflict(this.conflictAlertCount);
			return;
		}

		if (pendingCount > 0) {
			this.statusBar.setPending(pendingCount);
			return;
		}

		this.statusBar.setSynced();
	}

	private isExcludedPath(path: string): boolean {
		return isExcluded(
			path,
			this.plugin.settings.excludedPaths,
			this.plugin.settings,
			this.plugin.app.vault.configDir
		);
	}

	private hasQueuedLocalChange(path: string): boolean {
		const normalizedPath = normalizePath(path);
		if (this.modifyDebouncers.has(normalizedPath)) {
			return true;
		}

		for (const entry of this.pendingPushQueue) {
			if (entry.path === normalizedPath || entry.oldPath === normalizedPath) {
				return true;
			}
		}

		for (const entry of this.offlineQueue) {
			if (entry.path === normalizedPath || entry.oldPath === normalizedPath) {
				return true;
			}
		}

		return false;
	}

	private cancelModifyDebouncer(path: string): void {
		const normalizedPath = normalizePath(path);
		const debounced = this.modifyDebouncers.get(normalizedPath);
		if (!debounced) {
			return;
		}
		debounced.cancel();
		this.modifyDebouncers.delete(normalizedPath);
	}

	private cancelAllModifyDebouncers(): void {
		for (const debounced of this.modifyDebouncers.values()) {
			debounced.cancel();
		}
		this.modifyDebouncers.clear();
	}

	private flushQuiescenceTimers(): void {
		const pendingDebouncers = [...this.modifyDebouncers.values()];
		this.modifyDebouncers.clear();
		for (const debounced of pendingDebouncers) {
			debounced.flush();
		}
	}

	private async loadOfflineQueue(): Promise<void> {
		await this.ensureDataDir();
		if (!await this.plugin.app.vault.adapter.exists(this.offlineQueuePath)) {
			this.offlineQueue = [];
			return;
		}

		try {
			const raw = await this.plugin.app.vault.adapter.read(this.offlineQueuePath);
			this.offlineQueue = parseOfflineQueuePayload(raw);
		} catch {
			const corruptPath = normalizePath(`${this.dataDir}/offline-queue.corrupt-${Date.now()}.json`);
			try {
				await this.plugin.app.vault.adapter.rename(this.offlineQueuePath, corruptPath);
			} catch {
				// Ignore recovery errors and start with a clean queue.
			}
			this.offlineQueue = [];
			await this.persistOfflineQueue();
		}
	}

	private async loadActivityLog(): Promise<void> {
		await this.ensureDataDir();
		if (!await this.plugin.app.vault.adapter.exists(this.activityLogPath)) {
			this.activityLog.length = 0;
			return;
		}

		try {
			const raw = await this.plugin.app.vault.adapter.read(this.activityLogPath);
			this.activityLog.length = 0;
			this.activityLog.push(...parseActivityLogPayload(raw));
		} catch {
			const corruptPath = normalizePath(`${this.dataDir}/activity-log.corrupt-${Date.now()}.json`);
			try {
				await this.plugin.app.vault.adapter.rename(this.activityLogPath, corruptPath);
			} catch {
				// Ignore recovery errors.
			}
			this.activityLog.length = 0;
			await this.persistActivityLog();
		}
	}

	private async persistOfflineQueue(): Promise<void> {
		await this.ensureDataDir();
		const payload: OfflineQueuePayload = {
			version: 1,
			updatedAt: Date.now(),
			queue: this.offlineQueue,
		};
		await this.plugin.app.vault.adapter.write(this.offlineQueuePath, JSON.stringify(payload, null, 2));
	}

	private schedulePersistActivityLog(): void {
		this.persistActivityLogChain = this.persistActivityLogChain
			.then(async () => {
				await this.persistActivityLog();
			})
			.catch(() => {
				// Ignore persistence errors to avoid breaking sync flow.
			});
	}

	private async persistActivityLog(): Promise<void> {
		await this.ensureDataDir();
		const payload: ActivityLogPayload = {
			version: 1,
			updatedAt: Date.now(),
			entries: this.activityLog.slice(-1000),
		};
		await this.plugin.app.vault.adapter.write(this.activityLogPath, JSON.stringify(payload, null, 2));
	}

	private async ensureDataDir(): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(this.dataDir)) {
			await this.plugin.app.vault.adapter.mkdir(this.dataDir);
		}
	}

	getRecentActivityEntries(limit = 200): ActivityLogEntry[] {
		if (limit <= 0) {
			return [];
		}
		return this.activityLog.slice(Math.max(0, this.activityLog.length - limit)).map(entry => ({ ...entry }));
	}

	getAllActivityEntries(): ActivityLogEntry[] {
		return this.activityLog.map(entry => ({ ...entry }));
	}

	addActivityEntry(entry: ActivityLogEntry): void {
		this.appendActivityEntry(entry);
	}

	private rebuildConflictAlertsFromActivityLog(): void {
		this.unresolvedConflictPaths.clear();
		for (const entry of this.activityLog) {
			this.applyConflictAlertTransition(entry);
		}
		this.conflictAlertCount = this.unresolvedConflictPaths.size;
	}

	private applyConflictAlertTransition(entry: ActivityLogEntry): void {
		const path = normalizePath(entry.path || '/');
		if (entry.action === 'conflict') {
			if (!conflictAlreadyResolved(entry.detail)) {
				this.unresolvedConflictPaths.add(path);
			}
			return;
		}
		if (actionCanResolveConflict(entry.action)) {
			this.unresolvedConflictPaths.delete(path);
		}
	}

	private appendActivityEntry(entry: ActivityLogEntry): void {
		this.activityLog.push(entry);
		if (this.activityLog.length > 1000) {
			this.activityLog.splice(0, this.activityLog.length - 1000);
		}
		this.rebuildConflictAlertsFromActivityLog();
		this.schedulePersistActivityLog();
		this.updateStatusFromCurrentState();
	}

	private logActivity(
		action: ActivityAction,
		path: string,
		detail?: string,
		fileId?: string,
		source: ActivityLogEntry['source'] = 'system'
	): void {
		this.appendActivityEntry({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
			action,
			path: normalizePath(path || '/'),
			detail,
			fileId,
			source,
		});
	}

	private logError(path: string, error: string): void {
		this.errorAlertMessage = error;
		this.appendActivityEntry({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
			action: 'error',
			path: normalizePath(path || '/'),
			error,
			source: 'system',
		});
	}

	async restoreFileFromRemoteTrash(fileId: string, preferredPath: string): Promise<string> {
		await this.driveClient.restoreFileFromTrash(fileId);
		const metadata = await this.driveClient.getFileMetadata(fileId);
		const remoteContent = await this.driveClient.downloadFile(fileId);
		const targetPath = await this.resolveRestoredPath(preferredPath || metadata.name);

		await this.ensureParentDirectories(targetPath);
		await this.plugin.app.vault.adapter.writeBinary(targetPath, remoteContent);

		const hash = await computeContentHash(remoteContent);
		this.syncDb.setRecord(targetPath, {
			gDriveFileId: fileId,
			localPath: targetPath,
			localHash: hash,
			remoteHash: hash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		if (targetPath.toLowerCase().endsWith('.md')) {
			await this.snapshotManager.saveSnapshot(targetPath, new TextDecoder().decode(remoteContent));
		}
		await this.syncDb.save();
		this.logActivity('restored', targetPath, 'Restored from Google Drive trash.', fileId, 'remote');
		this.updateStatusFromCurrentState();
		return targetPath;
	}

	async restoreLocalTrashFile(trashPath: string, destinationPath: string): Promise<string> {
		const normalizedTrashPath = normalizePath(trashPath);
		const targetPath = await this.resolveRestoredPath(destinationPath);
		await this.ensureParentDirectories(targetPath);
		await this.plugin.app.vault.adapter.rename(normalizedTrashPath, targetPath);

		const content = await this.plugin.app.vault.adapter.readBinary(targetPath);
		const hash = await computeContentHash(content);
		const existing = this.syncDb.getRecord(targetPath);
		if (existing?.gDriveFileId) {
			this.syncDb.setRecord(targetPath, {
				gDriveFileId: existing.gDriveFileId,
				localPath: targetPath,
				localHash: hash,
				remoteHash: existing.remoteHash,
				lastSyncedTimestamp: Date.now(),
				status: 'pending-push',
			});
		} else {
			this.syncDb.deleteRecord(targetPath);
		}
		await this.syncDb.save();
		this.queuePathForPush(targetPath);
		this.logActivity('restored', targetPath, 'Restored from local trash.', existing?.gDriveFileId, 'local');
		this.schedulePushQueueProcessing();
		return targetPath;
	}

	async restoreFileRevision(path: string, fileId: string, revisionId: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		const content = await this.driveClient.downloadRevision(fileId, revisionId);
		await this.ensureParentDirectories(normalizedPath);
		await this.plugin.app.vault.adapter.writeBinary(normalizedPath, content);

		const mimeType = this.mimeTypeForPath(normalizedPath);
		await this.driveClient.updateFile(
			fileId,
			content,
			mimeType,
			this.plugin.settings.keepRevisionsForever && normalizedPath.toLowerCase().endsWith('.md')
		);

		const hash = await computeContentHash(content);
		this.syncDb.setRecord(normalizedPath, {
			gDriveFileId: fileId,
			localPath: normalizedPath,
			localHash: hash,
			remoteHash: hash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.syncDb.save();
		if (normalizedPath.toLowerCase().endsWith('.md')) {
			await this.snapshotManager.saveSnapshot(normalizedPath, new TextDecoder().decode(content));
		}
		this.logActivity('restored', normalizedPath, `Restored revision ${revisionId}.`, fileId, 'remote');
	}

	getLocalTrashDirectoryPath(): string {
		return this.localTrashDirPath;
	}

	getActivityLogPath(): string {
		return this.activityLogPath;
	}

	private queuePathForPush(path: string): number {
		const normalizedPath = normalizePath(path);
		const alreadyQueued = this.pendingPushQueue.some(entry => entry.path === normalizedPath && entry.action !== 'delete');
		if (alreadyQueued) {
			return 0;
		}
		this.pendingPushQueue.push({
			action: 'update',
			path: normalizedPath,
			timestamp: Date.now(),
			retryCount: 0,
		});
		return 1;
	}

	private async collectAllLocalPaths(): Promise<string[]> {
		const discoveredFiles = new Set<string>();
		const pendingDirs: string[] = [''];
		const visitedDirs = new Set<string>();

		while (pendingDirs.length > 0) {
			const dir = pendingDirs.pop() ?? '';
			const normalizedDir = normalizePath(dir);
			if (visitedDirs.has(normalizedDir)) {
				continue;
			}
			visitedDirs.add(normalizedDir);

			const listed = await this.plugin.app.vault.adapter.list(dir);
			for (const file of listed.files) {
				discoveredFiles.add(normalizePath(file));
			}
			for (const folder of listed.folders) {
				const normalizedFolder = normalizePath(folder);
				if (!visitedDirs.has(normalizedFolder)) {
					pendingDirs.push(normalizedFolder);
				}
			}
		}

		return [...discoveredFiles].sort((a, b) => a.localeCompare(b));
	}

	private async resolveRestoredPath(requestedPath: string): Promise<string> {
		const normalizedPath = normalizePath(requestedPath);
		if (!await this.plugin.app.vault.adapter.exists(normalizedPath)) {
			return normalizedPath;
		}

		const dot = normalizedPath.lastIndexOf('.');
		const stem = dot >= 0 ? normalizedPath.slice(0, dot) : normalizedPath;
		const ext = dot >= 0 ? normalizedPath.slice(dot) : '';
		return normalizePath(`${stem}.restored-${Date.now()}${ext}`);
	}

	private async ensureParentDirectories(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		parts.pop();
		if (parts.length === 0) {
			return;
		}

		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.plugin.app.vault.adapter.exists(current)) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
	}

	private mimeTypeForPath(path: string): string {
		const ext = normalizePath(path).split('.').pop()?.toLowerCase();
		if (ext === 'md') return 'text/markdown; charset=utf-8';
		if (ext === 'json') return 'application/json; charset=utf-8';
		if (ext === 'txt') return 'text/plain; charset=utf-8';
		if (ext === 'pdf') return 'application/pdf';
		if (ext === 'png') return 'image/png';
		if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
		if (ext === 'gif') return 'image/gif';
		if (ext === 'webp') return 'image/webp';
		if (ext === 'mp3') return 'audio/mpeg';
		if (ext === 'wav') return 'audio/wav';
		if (ext === 'm4a') return 'audio/mp4';
		if (ext === 'ogg') return 'audio/ogg';
		if (ext === 'flac') return 'audio/flac';
		if (ext === 'mp4') return 'video/mp4';
		if (ext === 'mov') return 'video/quicktime';
		if (ext === 'mkv') return 'video/x-matroska';
		if (ext === 'webm') return 'video/webm';
		return 'application/octet-stream';
	}

	private collectPendingSnapshotPaths(): Set<string> {
		const pending = new Set<string>();
		for (const entry of this.pendingPushQueue) {
			pending.add(entry.path);
			if (entry.oldPath) {
				pending.add(entry.oldPath);
			}
		}
		for (const entry of this.offlineQueue) {
			pending.add(entry.path);
			if (entry.oldPath) {
				pending.add(entry.oldPath);
			}
		}
		for (const record of this.syncDb.getAllRecords()) {
			if (record.status !== 'synced') {
				pending.add(record.localPath);
			}
		}
		return pending;
	}
}
