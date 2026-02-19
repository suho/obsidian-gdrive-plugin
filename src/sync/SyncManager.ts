import { Notice } from 'obsidian';
import type { DriveChange, DriveClient } from '../gdrive/DriveClient';
import { ChangeTracker } from '../gdrive/ChangeTracker';
import type GDriveSyncPlugin from '../main';
import { DownloadManager } from './DownloadManager';
import { SyncDatabase } from './SyncDatabase';
import { UploadManager } from './UploadManager';
import { SyncStatusBar } from '../ui/SyncStatusBar';

interface PullSummary {
	processed: number;
}

interface SyncSummary {
	pulled: number;
	created: number;
	updated: number;
	renamed: number;
	deleted: number;
}

export class SyncManager {
	private syncLock = false;
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
	}

	async initialize(): Promise<void> {
		await this.syncDb.load();
		this.downloadManager.registerHandlers();
	}

	async runSync(): Promise<SyncSummary | null> {
		if (this.syncLock) {
			return null;
		}

		if (this.plugin.settings.syncPaused) {
			new Notice('Google Drive sync is paused.');
			return null;
		}

		if (!this.plugin.settings.setupComplete || !this.plugin.settings.gDriveFolderId) {
			new Notice('Complete Google Drive setup first.');
			return null;
		}

		this.syncLock = true;
		this.statusBar.setSyncing();

		try {
			const pullSummary = await this.pullChanges();
			this.statusBar.setSyncing(pullSummary.processed);

			const pushResult = await this.uploadManager.syncLocalVault();
			const totalProcessed = pullSummary.processed +
				pushResult.summary.created +
				pushResult.summary.updated +
				pushResult.summary.renamed +
				pushResult.summary.deleted;

			if (totalProcessed > 0 || pushResult.changedDb) {
				await this.syncDb.save();
			}

			this.statusBar.setSynced();
			return {
				pulled: pullSummary.processed,
				...pushResult.summary,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Google Drive sync failed', err);
			this.statusBar.setError(message);
			new Notice(`Google Drive sync failed: ${message}`);
			return null;
		} finally {
			this.syncLock = false;
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
}
