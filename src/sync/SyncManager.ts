import { Notice, TFile, normalizePath } from 'obsidian';
import { StorageQuotaError } from '../gdrive/DriveClient';
import type { DriveChange, DriveClient, DriveFileWithPath } from '../gdrive/DriveClient';
import { ChangeTracker } from '../gdrive/ChangeTracker';
import type GDriveSyncPlugin from '../main';
import type { ActivityAction, ActivityLogEntry, DriveFileMetadata, SyncQueueEntry } from '../types';
import { computeContentHash } from '../utils/checksums';
import { runWithConcurrencyLimit } from '../utils/concurrency';
import { debounceTrailing, type DebouncedFn } from '../utils/debounce';
import { isOnline } from '../utils/network';
import { SyncStatusBar } from '../ui/SyncStatusBar';
import { ConflictResolver } from './ConflictResolver';
import { DownloadManager } from './DownloadManager';
import {
	describeUserAdjustableExclusionReason,
	emptyUserAdjustableSkipCounts,
	getExclusionReason,
	isExcluded,
	mergeUserAdjustableSkipCounts,
	totalUserAdjustableSkipCounts,
	toUserAdjustableSkipReason,
	type UserAdjustableSkipCounts,
} from './exclusions';
import { canonicalPathForGeneratedVariant, isGeneratedArtifactPath } from './generatedArtifacts';
import { SnapshotManager } from './SnapshotManager';
import { SyncDatabase } from './SyncDatabase';
import { UploadManager } from './UploadManager';

interface PullSummary {
	processed: number;
}

interface PullChangesOptions {
	allowActiveWrite?: boolean;
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

export interface FullResyncPreview {
	uploads: number;
	downloads: number;
	conflicts: number;
	localFiles: number;
	remoteFiles: number;
}

export interface SyncIgnoredFileEntry {
	path: string;
	source: 'local' | 'remote';
	reason: 'selective-sync-disabled' | 'max-file-size' | 'excluded-folders';
	reasonText: string;
}

export interface SyncIgnoredFilesSnapshot {
	entries: SyncIgnoredFileEntry[];
	remoteWarning: string;
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

interface CleanupDuplicateArtifactsOptions {
	progress?: (message: string) => void;
	shouldCancel?: () => boolean;
}

export interface DuplicateArtifactCleanupSummary {
	localRemoved: number;
	localRenamed: number;
	localMerged: number;
	remoteTrashed: number;
	remoteRenamed: number;
	remoteMerged: number;
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

function parseRemoteModifiedTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

class SyncCancelledError extends Error {
	constructor() {
		super('Sync cancelled');
		this.name = 'SyncCancelledError';
	}
}

const TRANSFER_CONCURRENCY = 3;

export class SyncManager {
	private static readonly FILE_OPEN_REFRESH_COOLDOWN_MS = 1500;
	private static readonly SETTINGS_SKIP_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;
	private static readonly AUTH_REQUIRED_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;

	private syncLock = false;
	private pushFlushInFlight = false;
	private pullInFlight = false;
	private replayInFlight = false;
	private lastAutoPullAt = 0;
	private isNetworkOffline = false;
	private localChangeSuppressionDepth = 0;
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
	private uploadsBlockedByStorageQuota = false;
	private shuttingDown = false;
	private readonly storageQuotaStatusMessage = 'Google Drive storage is full. Uploads are paused.';
	private readonly authRequiredStatusMessage = 'Re-authentication required.';
	private readonly authRequiredNoticeMessage =
		'Google account access expired. Open plugin settings and select re-authenticate, or paste and validate a refresh token.';
	private lastSettingsSkipNoticeAt = 0;
	private lastSettingsSkipNoticeFingerprint = '';
	private lastAuthRequiredNoticeAt = 0;

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
		this.syncDb.startLazyLoad();
		await this.loadOfflineQueue();
		await this.loadActivityLog();
		this.rebuildConflictAlertsFromActivityLog();
		void (async () => {
			await this.ensureSyncDbReady();
			await this.snapshotManager.pruneSnapshots(this.collectPendingSnapshotPaths());
		})();
		this.downloadManager.registerHandlers();
		this.registerFileWatchers();
		this.registerPeriodicPull();
		this.registerConnectivityHandlers();
		this.registerVisibilityHandlers();
		await this.refreshConnectivityState(false);
		this.updateStatusFromCurrentState();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.cancelAllModifyDebouncers();
		if (this.pendingPushQueue.length > 0) {
			this.offlineQueue.push(...this.pendingPushQueue);
			this.pendingPushQueue = [];
		}
		await this.persistOfflineQueue();
		this.pushFlushInFlight = false;
		this.pullInFlight = false;
		this.replayInFlight = false;
		this.syncLock = false;
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

	isUploadBlockedByStorageQuota(): boolean {
		return this.uploadsBlockedByStorageQuota;
	}

	async acknowledgeStorageQuotaPause(): Promise<boolean> {
		if (!this.uploadsBlockedByStorageQuota) {
			return false;
		}

		this.uploadsBlockedByStorageQuota = false;
		this.errorAlertMessage = '';
		this.plugin.refreshSettingTab();
		await this.refreshConnectivityState(false);
		this.updateStatusFromCurrentState();
		return true;
	}

	private async ensureSyncDbReady(): Promise<void> {
		await this.syncDb.ensureLoaded();
	}

	private ensureAuthReadyForSyncEntry(): boolean {
		if (this.plugin.settings.refreshToken && !this.plugin.settings.needsReauthentication) {
			return true;
		}

		this.errorAlertMessage = this.authRequiredNoticeMessage;
		this.statusBar.setError(this.authRequiredStatusMessage);
		const now = Date.now();
		if (now - this.lastAuthRequiredNoticeAt >= SyncManager.AUTH_REQUIRED_NOTICE_COOLDOWN_MS) {
			this.lastAuthRequiredNoticeAt = now;
			new Notice(this.authRequiredNoticeMessage, 12000);
		}
		return false;
	}

	private handleStorageQuotaExceeded(): void {
		if (this.uploadsBlockedByStorageQuota) {
			this.statusBar.setStorageFull();
			return;
		}

		this.uploadsBlockedByStorageQuota = true;
		this.errorAlertMessage = this.storageQuotaStatusMessage;
		this.logError('/', this.storageQuotaStatusMessage);
		this.statusBar.setStorageFull();
		this.plugin.refreshSettingTab();
		new Notice(
			'Google Drive storage is full. Uploads are paused until you acknowledge in settings after freeing space.',
			12000
		);
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
		if (this.shuttingDown) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}
		if (!this.ensureAuthReadyForSyncEntry()) {
			return null;
		}
		await this.ensureSyncDbReady();

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing();
		this.resetSkippedBySettingsTracking();

		try {
			checkCancelled();
			let replaySummary = emptyPushSummary();
			if (!this.uploadsBlockedByStorageQuota) {
				options?.progress?.('Replaying offline queue');
				replaySummary = await this.replayOfflineQueue();
			}
			checkCancelled();
			options?.progress?.('Pulling remote changes');
			const pullSummary = await this.pullChanges({ allowActiveWrite: true });
			if (pullSummary.processed > 0) {
				options?.progress?.('Saving pulled changes');
				await this.syncDb.save();
			}
			checkCancelled();
			let queuedPushSummary = emptyPushSummary();
			let fullPushResult: Awaited<ReturnType<UploadManager['syncLocalVault']>> = {
				summary: {
					...emptyPushSummary(),
					skipped: 0,
				},
				changedDb: false,
			};
			if (!this.uploadsBlockedByStorageQuota) {
				options?.progress?.('Pushing queued local changes');
				queuedPushSummary = await this.flushPendingPushQueue();
				checkCancelled();
				options?.progress?.('Scanning local vault for upload');
				fullPushResult = await this.uploadManager.syncLocalVault();
			} else {
				options?.progress?.('Uploads paused due to storage limit');
			}
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

			if (totalQueuedChanges > 0 || fullPushResult.changedDb) {
				options?.progress?.('Saving sync database');
				await this.syncDb.save();
			}
			options?.progress?.('Pruning snapshots');
			await this.snapshotManager.pruneSnapshots(this.collectPendingSnapshotPaths());

			this.errorAlertMessage = '';
			if (this.uploadsBlockedByStorageQuota) {
				this.statusBar.setStorageFull();
			} else {
				this.statusBar.setSynced();
			}
			this.maybeWarnProjectedQuotaUsage();
			this.maybeShowSkippedBySettingsNotice(
				this.uploadManager.consumeExcludedBySettingsCounts(),
				this.downloadManager.consumeExcludedBySettingsCounts()
			);
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
			if (err instanceof StorageQuotaError) {
				this.handleStorageQuotaExceeded();
				return null;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.error('GDrive sync failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Sync failed: ${message}`);
			return null;
		} finally {
			this.resetSkippedBySettingsTracking();
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async runPushNow(): Promise<PushSummary | null> {
		if (this.syncLock || this.pushFlushInFlight) {
			return null;
		}
		if (this.shuttingDown) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}
		if (!this.ensureAuthReadyForSyncEntry()) {
			return null;
		}
		await this.ensureSyncDbReady();
		if (this.uploadsBlockedByStorageQuota) {
			this.statusBar.setStorageFull();
			new Notice('Uploads are paused because Google Drive storage is full. Acknowledge in settings to resume.');
			return null;
		}

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing(this.pendingPushQueue.length + this.offlineQueue.length);
		this.resetSkippedBySettingsTracking();

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
			this.maybeWarnProjectedQuotaUsage();
			this.maybeShowSkippedBySettingsNotice(
				this.uploadManager.consumeExcludedBySettingsCounts(),
				this.downloadManager.consumeExcludedBySettingsCounts()
			);
			return {
				created: replaySummary.created + queuedSummary.created + fullPushResult.summary.created,
				updated: replaySummary.updated + queuedSummary.updated + fullPushResult.summary.updated,
				renamed: replaySummary.renamed + queuedSummary.renamed + fullPushResult.summary.renamed,
				deleted: replaySummary.deleted + queuedSummary.deleted + fullPushResult.summary.deleted,
			};
		} catch (err) {
			if (err instanceof StorageQuotaError) {
				this.handleStorageQuotaExceeded();
				return null;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive push failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Google Drive push failed: ${message}`);
			return null;
		} finally {
			this.resetSkippedBySettingsTracking();
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async runPullNow(): Promise<PullSummary | null> {
		if (this.syncLock || this.pullInFlight) {
			return null;
		}
		if (this.shuttingDown) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			new Notice('Sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}
		if (!this.ensureAuthReadyForSyncEntry()) {
			return null;
		}
		await this.ensureSyncDbReady();

		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			new Notice('Offline. Changes will sync when a supported network is available.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing();
		this.resetSkippedBySettingsTracking();
		try {
			const summary = await this.pullChanges({ allowActiveWrite: true });
			if (summary.processed > 0) {
				await this.syncDb.save();
			}
			this.errorAlertMessage = '';
			this.maybeWarnProjectedQuotaUsage();
			this.maybeShowSkippedBySettingsNotice(
				this.uploadManager.consumeExcludedBySettingsCounts(),
				this.downloadManager.consumeExcludedBySettingsCounts()
			);
			return summary;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive pull failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
			new Notice(`Google Drive pull failed: ${message}`);
			return null;
		} finally {
			this.resetSkippedBySettingsTracking();
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	async forceFullResync(
		progress?: (message: string) => void,
		shouldCancel?: () => boolean
	): Promise<SyncSummary | null> {
		if (!this.ensureAuthReadyForSyncEntry()) {
			return null;
		}
		if (shouldCancel?.()) {
			return null;
		}
		await this.ensureSyncDbReady();

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

	async previewFullResync(): Promise<FullResyncPreview> {
		if (!this.plugin.settings.gDriveFolderId) {
			return {
				uploads: 0,
				downloads: 0,
				conflicts: 0,
				localFiles: 0,
				remoteFiles: 0,
			};
		}
		if (!this.ensureAuthReadyForSyncEntry()) {
			throw new Error(this.authRequiredStatusMessage);
		}
		await this.ensureSyncDbReady();

		const [localByPath, remoteByPath] = await Promise.all([
			this.collectLocalHashesForPreview(),
			this.collectRemoteHashesForPreview(),
		]);

		let uploads = 0;
		let downloads = 0;
		let conflicts = 0;
		const allPaths = new Set<string>([
			...localByPath.keys(),
			...remoteByPath.keys(),
		]);

		for (const path of allPaths) {
			const localHash = localByPath.get(path);
			const remoteHash = remoteByPath.get(path);

			if (localHash && !remoteHash) {
				uploads += 1;
				continue;
			}
			if (!localHash && remoteHash) {
				downloads += 1;
				continue;
			}
			if (!localHash || !remoteHash || localHash === remoteHash) {
				continue;
			}

			const record = this.syncDb.getRecord(path);
			if (!record) {
				conflicts += 1;
				continue;
			}

			const localChanged = record.localHash !== localHash;
			const remoteChanged = record.remoteHash !== remoteHash;
			if (localChanged && remoteChanged) {
				conflicts += 1;
			} else if (localChanged) {
				uploads += 1;
			} else if (remoteChanged) {
				downloads += 1;
			} else {
				conflicts += 1;
			}
		}

		return {
			uploads,
			downloads,
			conflicts,
			localFiles: localByPath.size,
			remoteFiles: remoteByPath.size,
		};
	}

	async resetSyncStateArtifacts(): Promise<void> {
		await this.ensureDataDir();
		await this.ensureSyncDbReady();

		this.cancelAllModifyDebouncers();
		this.pendingPushQueue = [];
		this.offlineQueue = [];
		await this.syncDb.deletePersistedFiles();
		await this.removeIfExists(this.offlineQueuePath);
		await this.snapshotManager.clearSnapshots();
		this.plugin.settings.lastSyncPageToken = '';
		this.plugin.settings.setupComplete = true;
		this.uploadsBlockedByStorageQuota = false;
		this.errorAlertMessage = '';
		await this.plugin.saveSettings();
		this.updateStatusFromCurrentState();
	}

	async runWithLocalChangeSuppressed<T>(task: () => Promise<T>): Promise<T> {
		this.localChangeSuppressionDepth += 1;
		try {
			return await task();
		} finally {
			this.localChangeSuppressionDepth = Math.max(0, this.localChangeSuppressionDepth - 1);
		}
	}

	async cleanDuplicateArtifacts(options?: CleanupDuplicateArtifactsOptions): Promise<DuplicateArtifactCleanupSummary | null> {
		if (this.syncLock || this.pushFlushInFlight || this.pullInFlight || this.replayInFlight) {
			return null;
		}
		if (this.shuttingDown) {
			return null;
		}
		if (!this.plugin.settings.gDriveFolderId) {
			throw new Error('Complete Google Drive setup first.');
		}

		await this.ensureSyncDbReady();
		const canSync = await this.refreshConnectivityState(true);
		if (!canSync) {
			throw new Error('Offline. Connect to the internet and try again.');
		}

		this.syncLock = true;
		this.statusBar.setSyncing();
		try {
			const summary = await this.runWithLocalChangeSuppressed(async () => {
				options?.progress?.('Scanning remote files');
				const result = await this.cleanupDuplicateArtifactsInternal(
					this.plugin.settings.gDriveFolderId,
					options?.shouldCancel ?? (() => false),
					options?.progress
				);

				options?.progress?.('Saving cleanup state');
				if (result.changedDb) {
					await this.syncDb.save();
				}
				await this.snapshotManager.pruneSnapshots(this.collectPendingSnapshotPaths());
				return result.summary;
			});

			this.errorAlertMessage = '';
			this.statusBar.setSynced();
			return summary;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.statusBar.setError(message);
			throw err;
		} finally {
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
	}

	private emptyDuplicateArtifactCleanupSummary(): DuplicateArtifactCleanupSummary {
		return {
			localRemoved: 0,
			localRenamed: 0,
			localMerged: 0,
			remoteTrashed: 0,
			remoteRenamed: 0,
			remoteMerged: 0,
		};
	}

	private async cleanupDuplicateArtifactsInternal(
		folderId: string,
		shouldCancel: () => boolean,
		progress?: (message: string) => void
	): Promise<{ summary: DuplicateArtifactCleanupSummary; changedDb: boolean }> {
		const summary = this.emptyDuplicateArtifactCleanupSummary();
		let changedDb = false;

		const remoteWithPaths = await this.driveClient.listAllFilesRecursiveWithPaths(folderId);
		const remoteByPath = new Map<string, DriveFileWithPath[]>();
		for (const remoteEntry of remoteWithPaths) {
			const path = normalizePath(remoteEntry.path);
			const bucket = remoteByPath.get(path) ?? [];
			bucket.push(remoteEntry);
			remoteByPath.set(path, bucket);
		}

		const localHashCache = new Map<string, string | null>();
		const remoteHashCache = new Map<string, string>();
		const remoteContentCache = new Map<string, ArrayBuffer>();
		const getLocalHash = async (path: string): Promise<string | null> => {
			const normalizedPath = normalizePath(path);
			if (localHashCache.has(normalizedPath)) {
				return localHashCache.get(normalizedPath) ?? null;
			}
			if (!await this.plugin.app.vault.adapter.exists(normalizedPath)) {
				localHashCache.set(normalizedPath, null);
				return null;
			}
			const content = await this.plugin.app.vault.adapter.readBinary(normalizedPath);
			const hash = await computeContentHash(content);
			localHashCache.set(normalizedPath, hash);
			return hash;
		};
		const getRemoteContent = async (fileId: string): Promise<ArrayBuffer> => {
			const cached = remoteContentCache.get(fileId);
			if (cached) {
				return cached;
			}
			const content = await this.driveClient.downloadFile(fileId);
			remoteContentCache.set(fileId, content);
			return content;
		};
		const getRemoteHash = async (entry: DriveFileWithPath): Promise<string> => {
			const cached = remoteHashCache.get(entry.file.id);
			if (cached) {
				return cached;
			}
			const md5 = entry.file.md5Checksum;
			if (md5) {
				remoteHashCache.set(entry.file.id, md5);
				return md5;
			}
			const content = await getRemoteContent(entry.file.id);
			const hash = await computeContentHash(content);
			remoteHashCache.set(entry.file.id, hash);
			return hash;
		};

		const processedRemoteIds = new Set<string>();
		progress?.('Resolving duplicate remote files');
		for (const [path, entries] of remoteByPath.entries()) {
			if (entries.length <= 1 || isGeneratedArtifactPath(path)) {
				continue;
			}
			if (shouldCancel()) {
				throw new Error('Cleanup cancelled by user.');
			}

			const keepEntry = this.pickPrimaryRemoteEntry(path, entries);
			const localHash = await getLocalHash(path);
			let referenceHash = localHash ?? await getRemoteHash(keepEntry);
			changedDb = (await this.ensureSyncRecordForResolvedPath(path, keepEntry, referenceHash)) || changedDb;

			for (const duplicateEntry of entries) {
				if (duplicateEntry.file.id === keepEntry.file.id || processedRemoteIds.has(duplicateEntry.file.id)) {
					continue;
				}
				if (shouldCancel()) {
					throw new Error('Cleanup cancelled by user.');
				}
				try {
					const duplicateHash = await getRemoteHash(duplicateEntry);
					if (duplicateHash !== referenceHash) {
						const mergeResult = await this.mergeRemoteVariantIntoCanonical(
							path,
							keepEntry,
							duplicateEntry.file,
							getRemoteContent
						);
						referenceHash = mergeResult.hash;
						localHashCache.set(normalizePath(path), referenceHash);
						if (mergeResult.changedContent) {
							summary.remoteMerged += 1;
						}
						changedDb = mergeResult.changedDb || changedDb;
					}
					await this.driveClient.trashFile(duplicateEntry.file.id);
					processedRemoteIds.add(duplicateEntry.file.id);
					summary.remoteTrashed += 1;
					const duplicateRecord = this.syncDb.getByGDriveId(duplicateEntry.file.id);
					if (duplicateRecord) {
						this.syncDb.deleteRecord(duplicateRecord.localPath);
						await this.snapshotManager.deleteSnapshot(duplicateRecord.localPath);
						changedDb = true;
					}
				} catch (err) {
					console.warn('Failed to resolve duplicate remote file', duplicateEntry.file.id, err);
				}
			}
		}

		progress?.('Resolving generated remote variants');
		const variantGroups = new Map<string, DriveFileWithPath[]>();
		for (const [path, entries] of remoteByPath.entries()) {
			const canonicalPath = canonicalPathForGeneratedVariant(path);
			if (!canonicalPath) {
				continue;
			}
			const bucket = variantGroups.get(canonicalPath) ?? [];
			bucket.push(...entries);
			variantGroups.set(canonicalPath, bucket);
		}

		for (const [canonicalPath, variantEntries] of variantGroups.entries()) {
			const canonicalEntries = remoteByPath.get(canonicalPath) ?? [];
			const allEntries = [...canonicalEntries, ...variantEntries];
			if (allEntries.length === 0) {
				continue;
			}
			if (shouldCancel()) {
				throw new Error('Cleanup cancelled by user.');
			}

			const keepEntry = this.pickPrimaryRemoteEntry(canonicalPath, allEntries);
			let referenceHash = (await getLocalHash(canonicalPath)) ?? await getRemoteHash(keepEntry);

			for (const entry of allEntries) {
				if (entry.file.id === keepEntry.file.id || processedRemoteIds.has(entry.file.id)) {
					continue;
				}
				if (shouldCancel()) {
					throw new Error('Cleanup cancelled by user.');
				}
				try {
					const entryHash = await getRemoteHash(entry);
					if (entryHash !== referenceHash) {
						const mergeResult = await this.mergeRemoteVariantIntoCanonical(
							canonicalPath,
							keepEntry,
							entry.file,
							getRemoteContent
						);
						referenceHash = mergeResult.hash;
						localHashCache.set(normalizePath(canonicalPath), referenceHash);
						if (mergeResult.changedContent) {
							summary.remoteMerged += 1;
						}
						changedDb = mergeResult.changedDb || changedDb;
					}
					await this.driveClient.trashFile(entry.file.id);
					processedRemoteIds.add(entry.file.id);
					summary.remoteTrashed += 1;
					const duplicateRecord = this.syncDb.getByGDriveId(entry.file.id);
					if (duplicateRecord) {
						this.syncDb.deleteRecord(duplicateRecord.localPath);
						await this.snapshotManager.deleteSnapshot(duplicateRecord.localPath);
						changedDb = true;
					}
				} catch (err) {
					console.warn('Failed to resolve generated remote variant', entry.file.id, err);
				}
			}

			if (!processedRemoteIds.has(keepEntry.file.id)) {
				const keepPath = normalizePath(keepEntry.path);
				if (keepPath !== canonicalPath) {
					const canonicalName = canonicalPath.split('/').pop();
					if (canonicalName && canonicalName !== keepEntry.file.name) {
						try {
							await this.driveClient.renameFile(keepEntry.file.id, canonicalName);
							summary.remoteRenamed += 1;
						} catch (err) {
							console.warn('Failed to rename remote file to canonical path', keepEntry.file.id, err);
						}
					}
					if (this.syncDb.getRecord(keepPath)) {
						this.syncDb.deleteRecord(keepPath);
						changedDb = true;
					}
				}
				changedDb = (await this.ensureSyncRecordForResolvedPath(canonicalPath, keepEntry, referenceHash)) || changedDb;
			}
		}

		progress?.('Cleaning generated local variants');
		const localResult = await this.cleanupLocalGeneratedArtifactFiles(shouldCancel);
		summary.localRemoved += localResult.summary.localRemoved;
		summary.localRenamed += localResult.summary.localRenamed;
		summary.localMerged += localResult.summary.localMerged;
		summary.remoteRenamed += localResult.summary.remoteRenamed;
		summary.remoteMerged += localResult.summary.remoteMerged;
		changedDb = localResult.changedDb || changedDb;

		return { summary, changedDb };
	}

	private pickPrimaryRemoteEntry(path: string, entries: DriveFileWithPath[]): DriveFileWithPath {
		if (entries.length === 0) {
			throw new Error(`No remote files found for ${path}`);
		}

		const trackedRecord = this.syncDb.getRecord(path);
		if (trackedRecord) {
			const trackedEntry = entries.find(entry => entry.file.id === trackedRecord.gDriveFileId);
			if (trackedEntry) {
				return trackedEntry;
			}
		}

		const canonicalEntry = entries.find(entry => normalizePath(entry.path) === normalizePath(path));
		if (canonicalEntry) {
			return canonicalEntry;
		}

		let selected = entries[0]!;
		for (const entry of entries.slice(1)) {
			const entryModified = parseRemoteModifiedTime(entry.file.modifiedTime);
			const selectedModified = parseRemoteModifiedTime(selected.file.modifiedTime);
			if (entryModified > selectedModified) {
				selected = entry;
			}
		}
		return selected;
	}

	private async ensureSyncRecordForResolvedPath(path: string, remoteEntry: DriveFileWithPath, syncedHash: string): Promise<boolean> {
		const normalizedPath = normalizePath(path);
		const existingRecord = this.syncDb.getRecord(normalizedPath);
		const existsLocally = await this.plugin.app.vault.adapter.exists(normalizedPath);
		if (!existingRecord && !existsLocally) {
			return false;
		}

		this.syncDb.setRecord(normalizedPath, {
			gDriveFileId: remoteEntry.file.id,
			localPath: normalizedPath,
			localHash: syncedHash,
			remoteHash: syncedHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		return true;
	}

	private async mergeRemoteVariantIntoCanonical(
		canonicalPath: string,
		keepEntry: DriveFileWithPath,
		variantFile: DriveFileMetadata,
		getRemoteContent: (fileId: string) => Promise<ArrayBuffer>
	): Promise<{ hash: string; changedContent: boolean; changedDb: boolean }> {
		const canonicalContent = await this.getCanonicalContent(canonicalPath, keepEntry.file.id, getRemoteContent);
		const variantContent = await getRemoteContent(variantFile.id);
		const mergedContent = this.buildConflictMarkerContent(
			canonicalPath,
			canonicalContent,
			variantContent,
			keepEntry.file.mimeType || variantFile.mimeType
		);
		const canonicalHash = await computeContentHash(canonicalContent);
		const mergedHash = await computeContentHash(mergedContent);
		const changedContent = canonicalHash !== mergedHash;

		await this.ensureParentDirectories(canonicalPath);
		await this.plugin.app.vault.adapter.writeBinary(canonicalPath, mergedContent);
		await this.driveClient.updateFile(
			keepEntry.file.id,
			mergedContent,
			keepEntry.file.mimeType || variantFile.mimeType || this.mimeTypeForPath(canonicalPath),
			this.plugin.settings.keepRevisionsForever && canonicalPath.toLowerCase().endsWith('.md')
		);

		this.syncDb.setRecord(canonicalPath, {
			gDriveFileId: keepEntry.file.id,
			localPath: canonicalPath,
			localHash: mergedHash,
			remoteHash: mergedHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.saveMarkdownSnapshot(canonicalPath, mergedContent);
		return { hash: mergedHash, changedContent, changedDb: true };
	}

	private async getCanonicalContent(
		canonicalPath: string,
		remoteFileId: string,
		getRemoteContent: (fileId: string) => Promise<ArrayBuffer>
	): Promise<ArrayBuffer> {
		if (await this.plugin.app.vault.adapter.exists(canonicalPath)) {
			return this.plugin.app.vault.adapter.readBinary(canonicalPath);
		}
		return getRemoteContent(remoteFileId);
	}

	private async cleanupLocalGeneratedArtifactFiles(
		shouldCancel: () => boolean
	): Promise<{ summary: DuplicateArtifactCleanupSummary; changedDb: boolean }> {
		const summary = this.emptyDuplicateArtifactCleanupSummary();
		let changedDb = false;
		const localPaths = await this.collectAllLocalPaths();
		for (const path of localPaths) {
			const canonicalPath = canonicalPathForGeneratedVariant(path);
			if (!canonicalPath) {
				continue;
			}
			if (shouldCancel()) {
				throw new Error('Cleanup cancelled by user.');
			}

			if (await this.plugin.app.vault.adapter.exists(canonicalPath)) {
				const variantHash = await this.computeLocalHash(path);
				const canonicalHash = await this.computeLocalHash(canonicalPath);
				if (variantHash === canonicalHash) {
					await this.plugin.app.vault.adapter.remove(path);
					await this.snapshotManager.deleteSnapshot(path);
					const duplicateRecord = this.syncDb.getRecord(path);
					if (duplicateRecord) {
						this.syncDb.deleteRecord(path);
						changedDb = true;
					}
					summary.localRemoved += 1;
					continue;
				}

				const canonicalContent = await this.plugin.app.vault.adapter.readBinary(canonicalPath);
				const variantContent = await this.plugin.app.vault.adapter.readBinary(path);
				const mergedContent = this.buildConflictMarkerContent(canonicalPath, canonicalContent, variantContent);
				const mergedHash = await computeContentHash(mergedContent);
				await this.plugin.app.vault.adapter.writeBinary(canonicalPath, mergedContent);
				await this.saveMarkdownSnapshot(canonicalPath, mergedContent);
				await this.plugin.app.vault.adapter.remove(path);
				await this.snapshotManager.deleteSnapshot(path);
				summary.localMerged += 1;
				summary.localRemoved += 1;

				const existingRecord = this.syncDb.getRecord(path);
				const canonicalRecord = this.syncDb.getRecord(canonicalPath) ?? existingRecord;
				if (canonicalRecord) {
					const canonicalName = canonicalPath.split('/').pop();
					const existingName = normalizePath(path).split('/').pop();
					if (existingRecord && canonicalName && existingName && canonicalName !== existingName) {
						try {
							await this.driveClient.renameFile(canonicalRecord.gDriveFileId, canonicalName);
							summary.remoteRenamed += 1;
						} catch (err) {
							console.warn('Failed to rename remote generated variant file', canonicalRecord.gDriveFileId, err);
						}
					}
					await this.driveClient.updateFile(
						canonicalRecord.gDriveFileId,
						mergedContent,
						this.mimeTypeForPath(canonicalPath),
						this.plugin.settings.keepRevisionsForever && canonicalPath.toLowerCase().endsWith('.md')
					);
					summary.remoteMerged += 1;
					this.syncDb.setRecord(canonicalPath, {
						...canonicalRecord,
						localPath: canonicalPath,
						localHash: mergedHash,
						remoteHash: mergedHash,
						lastSyncedTimestamp: Date.now(),
						status: 'synced',
					});
					changedDb = true;
				}
				if (existingRecord) {
					this.syncDb.deleteRecord(path);
					changedDb = true;
				}
				continue;
			}

			try {
				await this.ensureParentDirectories(canonicalPath);
				await this.plugin.app.vault.adapter.rename(path, canonicalPath);
				await this.snapshotManager.renameSnapshot(path, canonicalPath);
				summary.localRenamed += 1;
				const existingRecord = this.syncDb.getRecord(path);
				if (existingRecord) {
					const canonicalName = canonicalPath.split('/').pop();
					const existingName = normalizePath(path).split('/').pop();
					if (canonicalName && existingName && canonicalName !== existingName) {
						try {
							await this.driveClient.renameFile(existingRecord.gDriveFileId, canonicalName);
							summary.remoteRenamed += 1;
						} catch (err) {
							console.warn('Failed to rename remote generated variant file', existingRecord.gDriveFileId, err);
						}
					}
					this.syncDb.deleteRecord(path);
					this.syncDb.setRecord(canonicalPath, {
						...existingRecord,
						localPath: canonicalPath,
					});
					changedDb = true;
				}
			} catch (err) {
				console.warn('Failed to normalize local generated file', path, err);
			}
		}

		return { summary, changedDb };
	}

	private isTextConflictCandidate(path: string, mimeType?: string): boolean {
		const lowerMime = (mimeType ?? '').toLowerCase();
		if (lowerMime.startsWith('text/')) {
			return true;
		}
		if (lowerMime.includes('json') || lowerMime.includes('xml')) {
			return true;
		}

		const lowerPath = normalizePath(path).toLowerCase();
		return (
			lowerPath.endsWith('.md') ||
			lowerPath.endsWith('.txt') ||
			lowerPath.endsWith('.json') ||
			lowerPath.endsWith('.canvas') ||
			lowerPath.endsWith('.csv') ||
			lowerPath.endsWith('.js') ||
			lowerPath.endsWith('.ts')
		);
	}

	private buildConflictMarkerContent(
		path: string,
		localContent: ArrayBuffer,
		remoteContent: ArrayBuffer,
		mimeType?: string
	): ArrayBuffer {
		if (!this.isTextConflictCandidate(path, mimeType)) {
			return localContent;
		}

		const localText = new TextDecoder().decode(localContent);
		const remoteText = new TextDecoder().decode(remoteContent);
		const merged = [
			'<<<<<<< LOCAL',
			localText,
			'=======',
			remoteText,
			'>>>>>>> REMOTE',
			'',
		].join('\n');
		return new TextEncoder().encode(merged).buffer;
	}

	private async computeLocalHash(path: string): Promise<string> {
		const content = await this.plugin.app.vault.adapter.readBinary(path);
		return computeContentHash(content);
	}

	private async saveMarkdownSnapshot(path: string, content: ArrayBuffer): Promise<void> {
		if (!path.toLowerCase().endsWith('.md')) {
			return;
		}
		await this.snapshotManager.saveSnapshot(path, new TextDecoder().decode(content));
	}

	getPendingChangeCount(): number {
		return this.pendingPushQueue.length + this.offlineQueue.length;
	}

	getConflictAlertCount(): number {
		return this.conflictAlertCount;
	}

	async listSyncIgnoredFiles(): Promise<SyncIgnoredFilesSnapshot> {
		const entries: SyncIgnoredFileEntry[] = [];
		const seen = new Set<string>();

		const appendEntry = (
			source: SyncIgnoredFileEntry['source'],
			path: string,
			fileSizeBytes?: number
		): void => {
			const reason = getExclusionReason(
				path,
				this.plugin.settings.excludedPaths,
				this.plugin.settings,
				this.plugin.app.vault.configDir,
				fileSizeBytes
			);
			if (!reason) {
				return;
			}
			const mappedReason = toUserAdjustableSkipReason(reason);
			if (!mappedReason) {
				return;
			}
			const reasonText = describeUserAdjustableExclusionReason(path, reason, this.plugin.app.vault.configDir);
			if (!reasonText) {
				return;
			}

			const normalizedPath = normalizePath(path);
			const dedupeKey = `${source}:${mappedReason}:${normalizedPath}`;
			if (seen.has(dedupeKey)) {
				return;
			}
			seen.add(dedupeKey);
			entries.push({
				path: normalizedPath,
				source,
				reason: mappedReason,
				reasonText,
			});
		};

		const localPaths = await this.collectAllLocalPaths();
		for (const localPath of localPaths) {
			const stat = await this.plugin.app.vault.adapter.stat(localPath);
			appendEntry('local', localPath, stat?.size);
		}

		let remoteWarning = '';
		if (this.plugin.settings.gDriveFolderId) {
			try {
				const remoteFiles = await this.driveClient.listAllFilesRecursiveWithPaths(this.plugin.settings.gDriveFolderId);
				for (const remoteFile of remoteFiles) {
					const remoteSize = remoteFile.file.size ? Number(remoteFile.file.size) : undefined;
					appendEntry(
						'remote',
						normalizePath(remoteFile.path),
						Number.isFinite(remoteSize) ? remoteSize : undefined
					);
				}
			} catch (err) {
				remoteWarning = `Remote files could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		entries.sort((a, b) => {
			const sourceOrder = a.source.localeCompare(b.source);
			if (sourceOrder !== 0) {
				return sourceOrder;
			}
			return a.path.localeCompare(b.path);
		});

		return {
			entries,
			remoteWarning,
		};
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
		await this.ensureSyncDbReady();
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
			if (this.isLocalChangeSuppressed()) {
				return;
			}
			if (!(file instanceof TFile)) {
				return;
			}
			this.handleFileModify(file.path);
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on('create', file => {
			if (this.isLocalChangeSuppressed()) {
				return;
			}
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
			if (this.isLocalChangeSuppressed()) {
				return;
			}
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
			if (this.isLocalChangeSuppressed()) {
				return;
			}
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
		if (this.isLocalChangeSuppressed()) {
			return;
		}
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
		if (this.isLocalChangeSuppressed()) {
			return;
		}
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
		if (this.isLocalChangeSuppressed()) {
			return;
		}
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
		if (this.shuttingDown) {
			return emptyPushSummary();
		}

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			return emptyPushSummary();
		}
		if (this.uploadsBlockedByStorageQuota) {
			this.statusBar.setStorageFull();
			return emptyPushSummary();
		}

		if (!this.plugin.settings.autoSync) {
			return emptyPushSummary();
		}
		await this.ensureSyncDbReady();

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

				try {
					const changed = await this.pushSingleQueueEntry(entry, summary);
					changedDb = changedDb || changed;
				} catch (err) {
					this.pendingPushQueue.unshift(entry);
					throw err;
				}
			}

			if (changedDb) {
				await this.syncDb.save();
			}
		} catch (err) {
			if (err instanceof StorageQuotaError) {
				this.handleStorageQuotaExceeded();
				return summary;
			}
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
		if (this.shuttingDown) {
			return;
		}

		if (!this.plugin.settings.autoSync || this.plugin.settings.syncPaused) {
			return;
		}
		await this.ensureSyncDbReady();

		const canSync = await this.refreshConnectivityState(false);
		if (!canSync) {
			return;
		}

		this.pullInFlight = true;
		this.resetSkippedBySettingsTracking();
		try {
			this.statusBar.setSyncing();
			const pullSummary = await this.pullChanges();
			if (pullSummary.processed > 0) {
				await this.syncDb.save();
			}
			await this.replayOfflineQueue();
			await this.flushPendingPushQueue();
			this.errorAlertMessage = '';
			this.maybeWarnProjectedQuotaUsage();
			this.maybeShowSkippedBySettingsNotice(
				this.uploadManager.consumeExcludedBySettingsCounts(),
				this.downloadManager.consumeExcludedBySettingsCounts()
			);
		} catch (err) {
			if (err instanceof StorageQuotaError) {
				this.handleStorageQuotaExceeded();
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.error('Auto-pull failed', err);
			this.statusBar.setError(message);
			this.logError('', message);
		} finally {
			this.resetSkippedBySettingsTracking();
			this.pullInFlight = false;
			this.updateStatusFromCurrentState();
		}
	}

	private async pullChanges(options?: PullChangesOptions): Promise<PullSummary> {
		await this.ensureSyncDbReady();
		const changes = await this.changeTracker.listChangesSinceLastSync();
		const deduped = new Map<string, DriveChange>();
		for (const change of changes) {
			deduped.set(change.fileId, change);
		}

		let processed = 0;
		await runWithConcurrencyLimit([...deduped.values()], TRANSFER_CONCURRENCY, async change => {
			const result = await this.applyRemoteChange(change, options);
			if (result) {
				processed += 1;
			}
		});

		return { processed };
	}

	private async applyRemoteChange(change: DriveChange, options?: PullChangesOptions): Promise<boolean> {
		const before = this.syncDb.getByGDriveId(change.fileId);
		const result = await this.downloadManager.applyChange(change, {
			allowActiveWrite: options?.allowActiveWrite,
		});
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
		await this.ensureSyncDbReady();

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
		if (this.shuttingDown) {
			return emptyPushSummary();
		}

		if (this.plugin.settings.syncPaused) {
			return emptyPushSummary();
		}
		if (this.uploadsBlockedByStorageQuota) {
			this.statusBar.setStorageFull();
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
		});

		this.isNetworkOffline = !online;
		if (!online) {
			return false;
		}

		if (verifyDriveAccess) {
			try {
				await this.driveClient.getStartPageToken();
			} catch (err) {
				// Reachability checks can fail transiently on mobile WebView.
				// Continue and let the real sync call surface a concrete API/auth error.
				console.warn('Drive reachability preflight failed; continuing sync attempt.', err);
			}
		}

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
		if (this.uploadsBlockedByStorageQuota) {
			this.statusBar.setStorageFull();
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

	private isLocalChangeSuppressed(): boolean {
		return this.localChangeSuppressionDepth > 0;
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
		await this.ensureSyncDbReady();
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
		await this.ensureSyncDbReady();
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
		await this.ensureSyncDbReady();
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

	private async collectLocalHashesForPreview(): Promise<Map<string, string>> {
		const localByPath = new Map<string, string>();
		const localPaths = await this.collectAllLocalPaths();

		await runWithConcurrencyLimit(localPaths, TRANSFER_CONCURRENCY, async path => {
			const stat = await this.plugin.app.vault.adapter.stat(path);
			if (isExcluded(
				path,
				this.plugin.settings.excludedPaths,
				this.plugin.settings,
				this.plugin.app.vault.configDir,
				stat?.size
			)) {
				return;
			}
			const content = await this.plugin.app.vault.adapter.readBinary(path);
			const hash = await computeContentHash(content);
			localByPath.set(path, hash);
		});

		return localByPath;
	}

	private async collectRemoteHashesForPreview(): Promise<Map<string, string>> {
		const remoteByPath = new Map<string, string>();
		const remoteFiles: DriveFileWithPath[] = await this.driveClient.listAllFilesRecursiveWithPaths(this.plugin.settings.gDriveFolderId);

		for (const remote of remoteFiles) {
			const normalizedPath = normalizePath(remote.path);
			const remoteSize = remote.file.size ? Number(remote.file.size) : undefined;
			if (isExcluded(
				normalizedPath,
				this.plugin.settings.excludedPaths,
				this.plugin.settings,
				this.plugin.app.vault.configDir,
				Number.isFinite(remoteSize) ? remoteSize : undefined
			)) {
				continue;
			}
			if (remote.file.md5Checksum) {
				remoteByPath.set(normalizedPath, remote.file.md5Checksum);
				continue;
			}

			// Fallback for file types without md5Checksum from metadata.
			const content = await this.driveClient.downloadFile(remote.file.id);
			remoteByPath.set(normalizedPath, await computeContentHash(content));
		}

		return remoteByPath;
	}

	private maybeWarnProjectedQuotaUsage(): void {
		if (!this.driveClient.consumeQuotaWarning()) {
			return;
		}

		const snapshot = this.driveClient.getRateLimitSnapshot();
		new Notice(
			`Google Drive API usage is projected at about ${snapshot.projectedRequestsToday} requests today (estimate: ${snapshot.estimatedDailyQuota}).`,
			10000
		);
	}

	private resetSkippedBySettingsTracking(): void {
		this.uploadManager.resetExcludedBySettingsCounts();
		this.downloadManager.resetExcludedBySettingsCounts();
	}

	private maybeShowSkippedBySettingsNotice(
		localCounts: UserAdjustableSkipCounts,
		remoteCounts: UserAdjustableSkipCounts
	): void {
		const merged = mergeUserAdjustableSkipCounts(
			mergeUserAdjustableSkipCounts(emptyUserAdjustableSkipCounts(), localCounts),
			remoteCounts
		);
		if (totalUserAdjustableSkipCounts(merged) === 0) {
			return;
		}

		const localTotal = totalUserAdjustableSkipCounts(localCounts);
		const remoteTotal = totalUserAdjustableSkipCounts(remoteCounts);
		const fingerprint = [
			merged.selectiveSyncDisabled,
			merged.maxFileSize,
			merged.excludedFolders,
			localTotal,
			remoteTotal,
		].join(':');
		const now = Date.now();
		if (
			this.lastSettingsSkipNoticeFingerprint === fingerprint &&
			now - this.lastSettingsSkipNoticeAt < SyncManager.SETTINGS_SKIP_NOTICE_COOLDOWN_MS
		) {
			return;
		}
		this.lastSettingsSkipNoticeFingerprint = fingerprint;
		this.lastSettingsSkipNoticeAt = now;

		const scope: string[] = [];
		if (localTotal > 0) {
			scope.push(`local ${localTotal}`);
		}
		if (remoteTotal > 0) {
			scope.push(`remote ${remoteTotal}`);
		}
		const scopeText = scope.length > 0 ? ` (${scope.join(', ')})` : '';

		const reasonParts: string[] = [];
		if (merged.selectiveSyncDisabled > 0) {
			reasonParts.push(`selective sync disabled ${merged.selectiveSyncDisabled}`);
		}
		if (merged.maxFileSize > 0) {
			reasonParts.push(`max file size ${merged.maxFileSize}`);
		}
		if (merged.excludedFolders > 0) {
			reasonParts.push(`excluded folders ${merged.excludedFolders}`);
		}

		new Notice(
			`Some files were skipped by sync settings${scopeText}: ${reasonParts.join(', ')}. Update settings if needed.`,
			12000
		);
	}

	private async removeIfExists(path: string): Promise<void> {
		if (await this.plugin.app.vault.adapter.exists(path)) {
			await this.plugin.app.vault.adapter.remove(path);
		}
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
