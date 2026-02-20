import { Notice, TFile, normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveClient, DriveChange } from '../gdrive/DriveClient';
import type { DriveFileMetadata } from '../types';
import { computeContentHash } from '../utils/checksums';
import type { SyncDatabase } from './SyncDatabase';
import { isExcluded } from './exclusions';

export type DownloadResult = 'pulled' | 'deleted' | 'renamed' | 'deferred' | 'skipped';

interface PendingDownload {
	change: DriveChange;
	targetPath: string;
}

export class DownloadManager {
	private readonly pendingDownloads = new Map<string, PendingDownload>();
	private readonly trashDir: string;
	private readonly folderPathCache = new Map<string, string | null>();

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly syncDb: SyncDatabase
	) {
		this.trashDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/trash`);
		if (this.plugin.settings.gDriveFolderId) {
			this.folderPathCache.set(this.plugin.settings.gDriveFolderId, '');
		}
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
		let localPath = existing?.localPath ?? await this.resolveNewLocalPath(remoteFile);

		const renamedPath = existing ? this.resolveRenamePath(existing.localPath, remoteFile.name) : null;
		const targetPath = renamedPath ?? localPath;
		if (this.isPathExcluded(targetPath)) {
			return 'skipped';
		}

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
		if (this.isPathExcluded(record.localPath)) {
			this.syncDb.deleteRecord(record.localPath);
			return 'skipped';
		}

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

	private async resolveNewLocalPath(remoteFile: DriveFileMetadata): Promise<string> {
		const preferredPath = await this.resolvePreferredLocalPath(remoteFile);
		if (!this.plugin.app.vault.getAbstractFileByPath(preferredPath)) {
			return preferredPath;
		}

		const dot = preferredPath.lastIndexOf('.');
		const base = dot >= 0 ? preferredPath.slice(0, dot) : preferredPath;
		const ext = dot >= 0 ? preferredPath.slice(dot) : '';
		return normalizePath(`${base}.remote${ext}`);
	}

	private async resolvePreferredLocalPath(remoteFile: DriveFileMetadata): Promise<string> {
		const remoteName = normalizePath(remoteFile.name);
		const parentId = remoteFile.parents?.[0];
		if (!parentId) {
			return remoteName;
		}

		const parentPath = await this.resolveFolderPathFromVaultRoot(parentId, new Set<string>());
		if (parentPath === null || parentPath === '') {
			return remoteName;
		}
		return normalizePath(`${parentPath}/${remoteName}`);
	}

	private async resolveFolderPathFromVaultRoot(folderId: string, visited: Set<string>): Promise<string | null> {
		if (folderId === this.plugin.settings.gDriveFolderId) {
			return '';
		}

		if (visited.has(folderId)) {
			return null;
		}
		visited.add(folderId);

		if (this.folderPathCache.has(folderId)) {
			return this.folderPathCache.get(folderId) ?? null;
		}

		try {
			const metadata = await this.driveClient.getFileMetadata(folderId, 'id,name,mimeType,parents');
			if (metadata.mimeType !== 'application/vnd.google-apps.folder') {
				this.folderPathCache.set(folderId, null);
				return null;
			}

			const parents = metadata.parents ?? [];
			for (const parentId of parents) {
				const parentPath = await this.resolveFolderPathFromVaultRoot(parentId, visited);
				if (parentPath === null) {
					continue;
				}

				const fullPath = parentPath ? normalizePath(`${parentPath}/${metadata.name}`) : normalizePath(metadata.name);
				this.folderPathCache.set(folderId, fullPath);
				return fullPath;
			}
		} catch {
			this.folderPathCache.set(folderId, null);
			return null;
		}

		this.folderPathCache.set(folderId, null);
		return null;
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

	private isPathExcluded(path: string): boolean {
		return isExcluded(
			path,
			this.plugin.settings.excludedPaths,
			this.plugin.settings,
			this.plugin.app.vault.configDir
		);
	}
}
