import { Notice, TFile, normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveClient, DriveChange } from '../gdrive/DriveClient';
import type { DriveFileMetadata } from '../types';
import { computeContentHash } from '../utils/checksums';
import type { ConflictResolver } from './ConflictResolver';
import type { SnapshotManager } from './SnapshotManager';
import type { SyncDatabase } from './SyncDatabase';
import { isExcluded } from './exclusions';

export type DownloadResult = 'pulled' | 'deleted' | 'renamed' | 'deferred' | 'skipped';

interface PendingDownload {
	change: DriveChange;
	targetPath: string;
}

interface ApplyChangeOptions {
	allowActiveWrite?: boolean;
}

export class DownloadManager {
	private readonly pendingDownloads = new Map<string, PendingDownload>();
	private readonly trashDir: string;
	private readonly folderPathCache = new Map<string, string | null>();

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly syncDb: SyncDatabase,
		private readonly snapshotManager: SnapshotManager,
		private readonly conflictResolver: ConflictResolver
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

	hasPendingDownloadForPath(path: string): boolean {
		const normalizedPath = normalizePath(path);
		for (const pending of this.pendingDownloads.values()) {
			if (normalizePath(pending.targetPath) === normalizedPath) {
				return true;
			}
		}
		return false;
	}

	async processPendingDownloadForPath(path: string, allowActiveWrite = false): Promise<boolean> {
		const normalizedPath = normalizePath(path);
		const matching = [...this.pendingDownloads.entries()]
			.filter(([, pending]) => normalizePath(pending.targetPath) === normalizedPath);
		if (matching.length === 0) {
			return false;
		}

		let applied = false;
		for (const [fileId, pending] of matching) {
			this.pendingDownloads.delete(fileId);
			try {
				const result = await this.applyChange(pending.change, { allowActiveWrite });
				if (result === 'pulled' || result === 'renamed' || result === 'deleted') {
					applied = true;
				}
			} catch (err) {
				new Notice(`Failed to refresh opened file: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return applied;
	}

	async applyChange(change: DriveChange, options?: ApplyChangeOptions): Promise<DownloadResult> {
		if (change.removed) {
			return this.handleRemoteDeletion(change.fileId, options);
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

		if (this.isActiveFile(localPath) && !options?.allowActiveWrite) {
			this.pendingDownloads.set(change.fileId, { change, targetPath: localPath });
			return 'deferred';
		}

		const content = await this.driveClient.downloadFile(change.fileId);

		if (existing && await this.plugin.app.vault.adapter.exists(localPath)) {
			const localContent = await this.plugin.app.vault.adapter.readBinary(localPath);
			const localHash = await computeContentHash(localContent);
			const remoteHash = await computeContentHash(content);
			const hasConflict = this.conflictResolver.isConflict(localHash, remoteHash, existing.localHash);
			if (hasConflict) {
				const stat = await this.plugin.app.vault.adapter.stat(localPath);
				const localModified = stat?.mtime ?? Date.now();
				const resolved = await this.conflictResolver.resolveConflict({
					path: localPath,
					record: existing,
					remoteFile,
					localContent,
					remoteContent: content,
					localModified,
				});
				this.syncDb.setRecord(localPath, {
					gDriveFileId: change.fileId,
					localPath,
					localHash: resolved.syncedHash,
					remoteHash: resolved.syncedHash,
					lastSyncedTimestamp: Date.now(),
					status: 'synced',
				});
				return 'pulled';
			}
		}

		await this.ensureParentDirectories(localPath);
		await this.plugin.app.vault.adapter.writeBinary(localPath, content);
		await this.saveMarkdownSnapshot(localPath, content);

		const localHash = await computeContentHash(content);
		this.syncDb.setRecord(localPath, {
			gDriveFileId: change.fileId,
			localPath,
			localHash,
			remoteHash: localHash,
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

	private async handleRemoteDeletion(fileId: string, options?: ApplyChangeOptions): Promise<DownloadResult> {
		const record = this.syncDb.getByGDriveId(fileId);
		if (!record) return 'skipped';
		if (this.isPathExcluded(record.localPath)) {
			this.syncDb.deleteRecord(record.localPath);
			return 'skipped';
		}

		if (this.isActiveFile(record.localPath) && !options?.allowActiveWrite) {
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
		await this.snapshotManager.deleteSnapshot(record.localPath);
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
			await this.snapshotManager.renameSnapshot(oldPath, newPath);
			return;
		}

		if (await this.plugin.app.vault.adapter.exists(oldPath)) {
			await this.plugin.app.vault.adapter.rename(oldPath, newPath);
			await this.snapshotManager.renameSnapshot(oldPath, newPath);
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

	private async saveMarkdownSnapshot(path: string, content: ArrayBuffer): Promise<void> {
		if (!path.toLowerCase().endsWith('.md')) {
			return;
		}
		await this.snapshotManager.saveSnapshot(path, new TextDecoder().decode(content));
	}
}
