import { Notice, TFile, normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveClient, DriveChange } from '../gdrive/DriveClient';
import { computeContentHash } from '../utils/checksums';
import type { SyncDatabase } from './SyncDatabase';

export type DownloadResult = 'pulled' | 'deleted' | 'renamed' | 'deferred' | 'skipped';

interface PendingDownload {
	change: DriveChange;
	targetPath: string;
}

export class DownloadManager {
	private readonly pendingDownloads = new Map<string, PendingDownload>();
	private readonly trashDir: string;

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly syncDb: SyncDatabase
	) {
		this.trashDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/trash`);
	}

	registerHandlers(): void {
		this.plugin.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => {
			void this.processPendingDownloads();
		}));
	}

	getPendingCount(): number {
		return this.pendingDownloads.size;
	}

	async applyChange(change: DriveChange): Promise<DownloadResult> {
		if (change.removed) {
			return this.handleRemoteDeletion(change.fileId);
		}

		const remoteFile = change.file;
		if (!remoteFile) return 'skipped';
		if (remoteFile.mimeType === 'application/vnd.google-apps.folder') return 'skipped';

		const existing = this.syncDb.getByGDriveId(change.fileId);
		let localPath = existing?.localPath ?? this.resolveNewLocalPath(remoteFile.name);

		const renamedPath = existing ? this.resolveRenamePath(existing.localPath, remoteFile.name) : null;
		if (existing && renamedPath && renamedPath !== existing.localPath) {
			await this.renameLocalFile(existing.localPath, renamedPath);
			this.syncDb.deleteRecord(existing.localPath);
			this.syncDb.setRecord(renamedPath, {
				...existing,
				localPath: renamedPath,
			});
			localPath = renamedPath;
		}

		if (this.isActiveFile(localPath)) {
			this.pendingDownloads.set(change.fileId, { change, targetPath: localPath });
			return 'deferred';
		}

		const content = await this.driveClient.downloadFile(change.fileId);
		await this.ensureParentDirectories(localPath);
		await this.plugin.app.vault.adapter.writeBinary(localPath, content);

		const localHash = await computeContentHash(content);
		this.syncDb.setRecord(localPath, {
			gDriveFileId: change.fileId,
			localPath,
			localHash,
			remoteHash: remoteFile.md5Checksum ?? localHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});

		if (renamedPath && renamedPath !== existing?.localPath) {
			return 'renamed';
		}
		return 'pulled';
	}

	async processPendingDownloads(): Promise<void> {
		if (this.pendingDownloads.size === 0) return;

		const pending = [...this.pendingDownloads.values()];
		this.pendingDownloads.clear();

		for (const item of pending) {
			if (this.isActiveFile(item.targetPath)) {
				this.pendingDownloads.set(item.change.fileId, item);
				continue;
			}

			try {
				await this.applyChange(item.change);
			} catch (err) {
				new Notice(`Failed to apply deferred change: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private async handleRemoteDeletion(fileId: string): Promise<DownloadResult> {
		const record = this.syncDb.getByGDriveId(fileId);
		if (!record) return 'skipped';

		if (this.isActiveFile(record.localPath)) {
			this.pendingDownloads.set(fileId, {
				change: { fileId, removed: true },
				targetPath: record.localPath,
			});
			return 'deferred';
		}

		if (await this.plugin.app.vault.adapter.exists(record.localPath)) {
			const trashedPath = normalizePath(
				`${this.trashDir}/${Date.now()}-${record.localPath}`
			);
			await this.ensureParentDirectories(trashedPath);
			await this.plugin.app.vault.adapter.rename(record.localPath, trashedPath);
		}

		this.syncDb.deleteRecord(record.localPath);
		return 'deleted';
	}

	private resolveRenamePath(currentPath: string, remoteName: string): string {
		const segments = normalizePath(currentPath).split('/');
		segments[segments.length - 1] = remoteName;
		return normalizePath(segments.join('/'));
	}

	private resolveNewLocalPath(remoteName: string): string {
		const normalizedName = normalizePath(remoteName);
		if (!this.plugin.app.vault.getAbstractFileByPath(normalizedName)) {
			return normalizedName;
		}

		const dot = normalizedName.lastIndexOf('.');
		const base = dot >= 0 ? normalizedName.slice(0, dot) : normalizedName;
		const ext = dot >= 0 ? normalizedName.slice(dot) : '';
		return normalizePath(`${base}.remote${ext}`);
	}

	private async renameLocalFile(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;

		await this.ensureParentDirectories(newPath);
		const existing = this.plugin.app.vault.getAbstractFileByPath(oldPath);
		if (existing instanceof TFile) {
			await this.plugin.app.vault.rename(existing, newPath);
			return;
		}

		if (await this.plugin.app.vault.adapter.exists(oldPath)) {
			await this.plugin.app.vault.adapter.rename(oldPath, newPath);
		}
	}

	private async ensureParentDirectories(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		parts.pop();
		if (parts.length === 0) return;

		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.plugin.app.vault.adapter.exists(current)) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
	}

	private isActiveFile(path: string): boolean {
		return this.plugin.app.workspace.getActiveFile()?.path === path;
	}
}
