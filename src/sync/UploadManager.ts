import { normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveClient } from '../gdrive/DriveClient';
import type { SyncRecord } from '../types';
import { computeContentHash } from '../utils/checksums';
import { isExcluded } from './exclusions';
import type { SyncDatabase } from './SyncDatabase';

const MIME_BY_EXTENSION: Record<string, string> = {
	md: 'text/markdown; charset=utf-8',
	canvas: 'application/json; charset=utf-8',
	json: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	webm: 'video/webm',
};

export interface UploadSummary {
	created: number;
	updated: number;
	renamed: number;
	deleted: number;
	skipped: number;
}

interface LocalFileState {
	path: string;
	hash: string;
}

export class UploadManager {
	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly syncDb: SyncDatabase
	) {}

	async syncLocalVault(): Promise<{ summary: UploadSummary; changedDb: boolean }> {
		const summary: UploadSummary = {
			created: 0,
			updated: 0,
			renamed: 0,
			deleted: 0,
			skipped: 0,
		};
		let changedDb = false;

		const localFiles = await this.collectLocalFileStates();
		const localByPath = new Map<string, LocalFileState>();
		for (const state of localFiles) {
			localByPath.set(state.path, state);
		}

		const records = this.syncDb.getAllRecords();
		const deletedCandidates = new Map<string, SyncRecord>();
		for (const record of records) {
			if (!localByPath.has(record.localPath)) {
				deletedCandidates.set(record.localPath, record);
			}
		}

		for (const [path, localState] of localByPath.entries()) {
			const existing = this.syncDb.getRecord(path);
			if (existing) {
				if (existing.localHash === localState.hash) {
					continue;
				}
				await this.pushExistingFile(path, localState.hash);
				summary.updated += 1;
				changedDb = true;
				continue;
			}

			const renameFrom = this.findRenameSource(localState.hash, deletedCandidates);
			if (renameFrom) {
				await this.applyRename(renameFrom, path, localState.hash);
				deletedCandidates.delete(renameFrom);
				summary.renamed += 1;
				changedDb = true;
				continue;
			}

			await this.pushNewFile(path, localState.hash);
			summary.created += 1;
			changedDb = true;
		}

		for (const deletedPath of deletedCandidates.keys()) {
			await this.applyDelete(deletedPath);
			summary.deleted += 1;
			changedDb = true;
		}

		return { summary, changedDb };
	}

	async pushFile(path: string): Promise<'created' | 'updated' | 'skipped'> {
		const normalizedPath = normalizePath(path);
		if (!await this.plugin.app.vault.adapter.exists(normalizedPath)) {
			return 'skipped';
		}

		if (this.isPathExcluded(normalizedPath)) {
			return 'skipped';
		}

		const content = await this.plugin.app.vault.adapter.readBinary(normalizedPath);
		const localHash = await computeContentHash(content);
		const existing = this.syncDb.getRecord(normalizedPath);
		if (existing) {
			await this.pushExistingFile(normalizedPath, localHash);
			return 'updated';
		}

		await this.pushNewFile(normalizedPath, localHash);
		return 'created';
	}

	async pushRename(oldPath: string, newPath: string): Promise<boolean> {
		const normalizedOldPath = normalizePath(oldPath);
		const normalizedNewPath = normalizePath(newPath);
		if (!await this.plugin.app.vault.adapter.exists(normalizedNewPath)) {
			return false;
		}

		if (this.isPathExcluded(normalizedNewPath)) {
			return false;
		}

		const localHash = await computeContentHash(await this.plugin.app.vault.adapter.readBinary(normalizedNewPath));
		await this.applyRename(normalizedOldPath, normalizedNewPath, localHash);
		return true;
	}

	async pushDelete(path: string): Promise<boolean> {
		return this.applyDelete(normalizePath(path));
	}

	private async collectLocalFileStates(): Promise<LocalFileState[]> {
		const paths = await this.collectAllLocalPaths();
		const states: LocalFileState[] = [];

		for (const path of paths) {
			if (this.isPathExcluded(path)) {
				continue;
			}

			const content = await this.plugin.app.vault.adapter.readBinary(path);
			const hash = await computeContentHash(content);
			states.push({ path, hash });
		}

		return states;
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
				if (visitedDirs.has(normalizedFolder)) {
					continue;
				}
				pendingDirs.push(normalizedFolder);
			}
		}

		return [...discoveredFiles].sort((a, b) => a.localeCompare(b));
	}

	private findRenameSource(localHash: string, deletedCandidates: Map<string, SyncRecord>): string | null {
		for (const [path, record] of deletedCandidates.entries()) {
			if (record.localHash === localHash) {
				return path;
			}
		}
		return null;
	}

	private async pushNewFile(path: string, localHash: string): Promise<void> {
		const content = await this.plugin.app.vault.adapter.readBinary(path);
		const { parentId, fileName } = await this.resolveRemoteParent(path);
		const metadata = await this.driveClient.createFile(
			fileName,
			content,
			this.getMimeType(path),
			parentId,
			this.shouldKeepRevisions(path)
		);

		this.syncDb.setRecord(path, {
			gDriveFileId: metadata.id,
			localPath: path,
			localHash,
			remoteHash: metadata.md5Checksum ?? localHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
	}

	private async pushExistingFile(path: string, localHash: string): Promise<void> {
		const record = this.syncDb.getRecord(path);
		if (!record) {
			await this.pushNewFile(path, localHash);
			return;
		}

		const content = await this.plugin.app.vault.adapter.readBinary(path);
		const metadata = await this.driveClient.updateFile(
			record.gDriveFileId,
			content,
			this.getMimeType(path),
			this.shouldKeepRevisions(path)
		);

		this.syncDb.setRecord(path, {
			...record,
			localHash,
			remoteHash: metadata.md5Checksum ?? localHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
	}

	private async applyRename(oldPath: string, newPath: string, localHash: string): Promise<void> {
		const record = this.syncDb.getRecord(oldPath);
		if (!record) {
			await this.pushNewFile(newPath, localHash);
			return;
		}

		const metadata = await this.driveClient.getFileMetadata(record.gDriveFileId);
		const newName = this.fileName(newPath);
		if (metadata.name !== newName) {
			await this.driveClient.renameFile(record.gDriveFileId, newName);
		}

		const currentParent = metadata.parents?.[0];
		const { parentId: targetParent } = await this.resolveRemoteParent(newPath);
		if (currentParent && currentParent !== targetParent) {
			await this.driveClient.moveFile(record.gDriveFileId, targetParent, currentParent);
		}

		this.syncDb.deleteRecord(oldPath);
		this.syncDb.setRecord(newPath, {
			...record,
			localPath: newPath,
			localHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
	}

	private async applyDelete(path: string): Promise<boolean> {
		const record = this.syncDb.getRecord(path);
		if (!record) return false;

		await this.driveClient.trashFile(record.gDriveFileId);
		this.syncDb.deleteRecord(path);
		return true;
	}

	private async resolveRemoteParent(path: string): Promise<{ parentId: string; fileName: string }> {
		const fileName = this.fileName(path);
		const segments = normalizePath(path).split('/');
		segments.pop();

		let parentId = this.plugin.settings.gDriveFolderId;
		if (segments.length > 0) {
			parentId = await this.driveClient.ensureFolderPath(segments, parentId);
		}

		return { parentId, fileName };
	}

	private fileName(path: string): string {
		const segments = normalizePath(path).split('/');
		return segments[segments.length - 1] ?? path;
	}

	private getMimeType(path: string): string {
		const ext = this.fileExtension(path);
		return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
	}

	private fileExtension(path: string): string {
		const name = this.fileName(path);
		const dot = name.lastIndexOf('.');
		if (dot < 0) return '';
		return name.slice(dot + 1).toLowerCase();
	}

	private shouldKeepRevisions(path: string): boolean {
		return this.plugin.settings.keepRevisionsForever && path.toLowerCase().endsWith('.md');
	}

	private isPathExcluded(path: string): boolean {
		return isExcluded(path);
	}
}
