import { Notice, TFile, normalizePath } from 'obsidian';
import type { DriveChange, DriveClient } from '../gdrive/DriveClient';
import { ChangeTracker } from '../gdrive/ChangeTracker';
import type GDriveSyncPlugin from '../main';
import type { SyncQueueEntry } from '../types';
import { debounceTrailing, type DebouncedFn } from '../utils/debounce';
import { isOnline } from '../utils/network';
import { SyncStatusBar } from '../ui/SyncStatusBar';
import { DownloadManager } from './DownloadManager';
import { isExcluded } from './exclusions';
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

	readonly syncDb: SyncDatabase;
	readonly uploadManager: UploadManager;
	readonly downloadManager: DownloadManager;
	readonly changeTracker: ChangeTracker;

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly statusBar: SyncStatusBar
	) {
		this.syncDb = new SyncDatabase(plugin);
		this.uploadManager = new UploadManager(plugin, driveClient, this.syncDb);
		this.downloadManager = new DownloadManager(plugin, driveClient, this.syncDb);
		this.changeTracker = new ChangeTracker(plugin, driveClient, this.syncDb);
		this.dataDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
		this.offlineQueuePath = normalizePath(`${this.dataDir}/offline-queue.json`);
	}

	async initialize(): Promise<void> {
		await this.syncDb.load();
		await this.loadOfflineQueue();
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

	async runSync(): Promise<SyncSummary | null> {
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
			const replaySummary = await this.replayOfflineQueue();
			const pullSummary = await this.pullChanges();
			const queuedPushSummary = await this.flushPendingPushQueue();
			const fullPushResult = await this.uploadManager.syncLocalVault();

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
				await this.syncDb.save();
			}

			this.statusBar.setSynced();
			return {
				pulled: pullSummary.processed,
				created: fullPushResult.summary.created + replaySummary.created + queuedPushSummary.created,
				updated: fullPushResult.summary.updated + replaySummary.updated + queuedPushSummary.updated,
				renamed: fullPushResult.summary.renamed + replaySummary.renamed + queuedPushSummary.renamed,
				deleted: fullPushResult.summary.deleted + replaySummary.deleted + queuedPushSummary.deleted,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive sync failed', err);
			this.statusBar.setError(message);
			new Notice(`Google Drive sync failed: ${message}`);
			return null;
		} finally {
			this.syncLock = false;
			this.updateStatusFromCurrentState();
		}
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
				return true;
			}
			if (result === 'updated') {
				summary.updated += 1;
				return true;
			}
			return false;
		}

		if (entry.action === 'delete') {
			const removed = await this.uploadManager.pushDelete(entry.path);
			if (removed) {
				summary.deleted += 1;
			}
			return removed;
		}

		if (!entry.oldPath) {
			return false;
		}

		const renamed = await this.uploadManager.pushRename(entry.oldPath, entry.path);
		if (renamed) {
			summary.renamed += 1;
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
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Auto-pull failed', err);
			this.statusBar.setError(message);
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
		const result = await this.downloadManager.applyChange(change);
		return result !== 'skipped';
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

		if (this.plugin.settings.syncPaused) {
			this.statusBar.setPaused();
			return;
		}

		if (this.isNetworkOffline) {
			this.statusBar.setOffline();
			return;
		}

		const pendingCount = this.pendingPushQueue.length + this.offlineQueue.length;
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

	private async persistOfflineQueue(): Promise<void> {
		await this.ensureDataDir();
		const payload: OfflineQueuePayload = {
			version: 1,
			updatedAt: Date.now(),
			queue: this.offlineQueue,
		};
		await this.plugin.app.vault.adapter.write(this.offlineQueuePath, JSON.stringify(payload, null, 2));
	}

	private async ensureDataDir(): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(this.dataDir)) {
			await this.plugin.app.vault.adapter.mkdir(this.dataDir);
		}
	}
}
