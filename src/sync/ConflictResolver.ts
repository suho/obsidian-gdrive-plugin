import { Notice, normalizePath } from 'obsidian';
import type { DriveFileMetadata, SyncRecord, ActivityLogEntry, ConflictResolution } from '../types';
import type GDriveSyncPlugin from '../main';
import type { DriveClient } from '../gdrive/DriveClient';
import { computeContentHash } from '../utils/checksums';
import { ConflictModal, type ConflictModalChoice } from '../ui/ConflictModal';
import { MergeEngine } from './MergeEngine';
import { SnapshotManager } from './SnapshotManager';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface ConflictResolverOptions {
	logActivity?: (entry: ActivityLogEntry) => void;
}

export interface ResolveConflictParams {
	path: string;
	record: SyncRecord;
	remoteFile: DriveFileMetadata;
	localContent: ArrayBuffer;
	remoteContent: ArrayBuffer;
	localModified: number;
	allowInteractiveResolution?: boolean;
}

export interface ResolveConflictResult {
	handled: boolean;
	syncedContent: ArrayBuffer;
	syncedHash: string;
	wroteLocalFile: boolean;
	createdConflictFilePath?: string;
}

function isMarkdownPath(path: string): boolean {
	return normalizePath(path).toLowerCase().endsWith('.md');
}

function isJsonConfigPath(path: string, configDir: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedConfigDir = normalizePath(configDir);
	return normalizedPath.startsWith(`${normalizedConfigDir}/`) && normalizedPath.toLowerCase().endsWith('.json');
}

function dateStampForConflictFile(ts: number): string {
	const date = new Date(ts);
	const yyyy = String(date.getFullYear());
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	const hh = String(date.getHours()).padStart(2, '0');
	const mi = String(date.getMinutes()).padStart(2, '0');
	const ss = String(date.getSeconds()).padStart(2, '0');
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function conflictFilePath(path: string, timestamp: number): string {
	const normalizedPath = normalizePath(path);
	const dotIndex = normalizedPath.lastIndexOf('.');
	const stem = dotIndex >= 0 ? normalizedPath.slice(0, dotIndex) : normalizedPath;
	const ext = dotIndex >= 0 ? normalizedPath.slice(dotIndex) : '';
	return normalizePath(`${stem}.sync-conflict-${dateStampForConflictFile(timestamp)}${ext}`);
}

function preMergeSnapshotPath(path: string, side: 'local' | 'remote'): string {
	const normalizedPath = normalizePath(path);
	const dotIndex = normalizedPath.lastIndexOf('.');
	const stem = dotIndex >= 0 ? normalizedPath.slice(0, dotIndex) : normalizedPath;
	return normalizePath(`${stem}.pre-merge-${side}.md`);
}

function toModalChoice(choice: ConflictModalChoice): ConflictResolution {
	if (choice === 'keep-both') {
		return 'keep-both';
	}
	return choice;
}

function maybeTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export class ConflictResolver {
	private readonly mergeEngine = new MergeEngine();

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly snapshotManager: SnapshotManager,
		private readonly options: ConflictResolverOptions = {}
	) {}

	isConflict(localHash: string, remoteHash: string, lastSyncedHash: string): boolean {
		return localHash !== lastSyncedHash && remoteHash !== lastSyncedHash;
	}

	async resolveConflict(params: ResolveConflictParams): Promise<ResolveConflictResult> {
		const normalizedPath = normalizePath(params.path);
		const localHash = await computeContentHash(params.localContent);
		const remoteHash = await computeContentHash(params.remoteContent);

		if (!this.isConflict(localHash, remoteHash, params.record.localHash)) {
			return {
				handled: false,
				syncedContent: params.remoteContent,
				syncedHash: remoteHash,
				wroteLocalFile: false,
			};
		}

		const isMarkdown = isMarkdownPath(normalizedPath);
		const isConfigJson = isJsonConfigPath(normalizedPath, this.plugin.app.vault.configDir);
		if (isMarkdown) {
			await this.savePreMergeSnapshots(normalizedPath, params.localContent, params.remoteContent);
		}

		if (isConfigJson) {
			return this.resolveJsonConflict(params, normalizedPath, localHash, remoteHash);
		}

		if (isMarkdown) {
			return this.resolveMarkdownConflict(params, normalizedPath, localHash, remoteHash);
		}

		return this.resolveBinaryConflict(params, normalizedPath, localHash, remoteHash);
	}

	private async resolveJsonConflict(
		params: ResolveConflictParams,
		path: string,
		localHash: string,
		remoteHash: string
	): Promise<ResolveConflictResult> {
		const localText = textDecoder.decode(params.localContent);
		const remoteText = textDecoder.decode(params.remoteContent);
		const merged = this.mergeEngine.deepMergeJson(localText, remoteText);

		if (merged === null) {
			return this.applyLocalWins(path, params, localHash, 'JSON merge failed; local version kept.');
		}

		const mergedContent = textEncoder.encode(merged).buffer;
		await this.plugin.app.vault.adapter.writeBinary(path, mergedContent);
		await this.updateRemote(path, params, mergedContent);

		const mergedHash = await computeContentHash(mergedContent);
		this.logActivity('merged', path, `Config merged (${localHash.slice(0, 8)} + ${remoteHash.slice(0, 8)}).`);
		return {
			handled: true,
			syncedContent: mergedContent,
			syncedHash: mergedHash,
			wroteLocalFile: true,
		};
	}

	private async resolveMarkdownConflict(
		params: ResolveConflictParams,
		path: string,
		localHash: string,
		remoteHash: string
	): Promise<ResolveConflictResult> {
		const localText = textDecoder.decode(params.localContent);
		const remoteText = textDecoder.decode(params.remoteContent);
		const baseText = await this.snapshotManager.loadSnapshot(path) ?? localText;
		const mergeResult = this.mergeEngine.threeWayMerge(baseText, localText, remoteText);
		let strategy: ConflictResolution = this.plugin.settings.mdConflictStrategy;

		if (strategy === 'auto-merge' && mergeResult.hasConflicts) {
			if (params.allowInteractiveResolution ?? true) {
				const choice = await ConflictModal.choose(this.plugin.app, {
					filePath: path,
					localContent: localText,
					remoteContent: remoteText,
					localModified: params.localModified,
					remoteModified: maybeTime(params.remoteFile.modifiedTime),
					localDeviceName: this.plugin.settings.deviceId,
					remoteDeviceName: 'Google Drive',
				});
				if (choice) {
					strategy = toModalChoice(choice);
				} else {
					strategy = 'keep-both';
				}
			} else {
				strategy = 'keep-both';
			}
		}

		if (strategy === 'auto-merge') {
			const mergedContent = textEncoder.encode(mergeResult.merged).buffer;
			await this.plugin.app.vault.adapter.writeBinary(path, mergedContent);
			await this.updateRemote(path, params, mergedContent);
			await this.snapshotManager.saveSnapshot(path, mergeResult.merged);
			await this.cleanupPreMergeSnapshots(path);
			const mergedHash = await computeContentHash(mergedContent);
			const detail = mergeResult.hasConflicts
				? 'Merged with inline conflict markers.'
				: 'Merged automatically.';
			this.logActivity(mergeResult.hasConflicts ? 'conflict' : 'merged', path, detail);
			return {
				handled: true,
				syncedContent: mergedContent,
				syncedHash: mergedHash,
				wroteLocalFile: true,
			};
		}

		if (strategy === 'conflict-file' || strategy === 'keep-both') {
			return this.applyKeepBoth(path, params, localHash, remoteHash, strategy);
		}

		if (strategy === 'local-wins') {
			return this.applyLocalWins(path, params, localHash, 'Local version kept.');
		}

		return this.applyRemoteWins(path, params, remoteHash, 'Remote version kept.');
	}

	private async resolveBinaryConflict(
		params: ResolveConflictParams,
		path: string,
		localHash: string,
		remoteHash: string
	): Promise<ResolveConflictResult> {
		if (this.plugin.settings.binaryConflictStrategy === 'conflict-file') {
			return this.applyKeepBoth(path, params, localHash, remoteHash, 'conflict-file');
		}

		const remoteModified = maybeTime(params.remoteFile.modifiedTime);
		if (params.localModified >= remoteModified) {
			return this.applyLocalWins(path, params, localHash, 'Binary conflict resolved by last-modified-wins (local).');
		}
		return this.applyRemoteWins(path, params, remoteHash, 'Binary conflict resolved by last-modified-wins (remote).');
	}

	private async applyKeepBoth(
		path: string,
		params: ResolveConflictParams,
		localHash: string,
		remoteHash: string,
		strategy: ConflictResolution
	): Promise<ResolveConflictResult> {
		const createdConflictPath = conflictFilePath(path, Date.now());
		await this.plugin.app.vault.adapter.writeBinary(createdConflictPath, params.remoteContent);
		await this.updateRemote(path, params, params.localContent);

		if (isMarkdownPath(path)) {
			await this.snapshotManager.saveSnapshot(path, textDecoder.decode(params.localContent));
			await this.cleanupPreMergeSnapshots(path);
		}

		const detail = strategy === 'conflict-file'
			? 'Conflict file created and local version kept.'
			: 'Both versions kept using a conflict file.';
		this.logActivity('conflict', path, `${detail} Local=${localHash.slice(0, 8)} Remote=${remoteHash.slice(0, 8)}.`);
		return {
			handled: true,
			syncedContent: params.localContent,
			syncedHash: localHash,
			wroteLocalFile: false,
			createdConflictFilePath: createdConflictPath,
		};
	}

	private async applyLocalWins(
		path: string,
		params: ResolveConflictParams,
		localHash: string,
		detail: string
	): Promise<ResolveConflictResult> {
		await this.updateRemote(path, params, params.localContent);
		if (isMarkdownPath(path)) {
			await this.snapshotManager.saveSnapshot(path, textDecoder.decode(params.localContent));
			await this.cleanupPreMergeSnapshots(path);
		}
		this.logActivity('conflict', path, detail);
		return {
			handled: true,
			syncedContent: params.localContent,
			syncedHash: localHash,
			wroteLocalFile: false,
		};
	}

	private async applyRemoteWins(
		path: string,
		params: ResolveConflictParams,
		remoteHash: string,
		detail: string
	): Promise<ResolveConflictResult> {
		await this.plugin.app.vault.adapter.writeBinary(path, params.remoteContent);
		if (isMarkdownPath(path)) {
			await this.snapshotManager.saveSnapshot(path, textDecoder.decode(params.remoteContent));
			await this.cleanupPreMergeSnapshots(path);
		}
		this.logActivity('conflict', path, detail);
		return {
			handled: true,
			syncedContent: params.remoteContent,
			syncedHash: remoteHash,
			wroteLocalFile: true,
		};
	}

	private async updateRemote(path: string, params: ResolveConflictParams, content: ArrayBuffer): Promise<void> {
		await this.driveClient.updateFile(
			params.record.gDriveFileId,
			content,
			params.remoteFile.mimeType,
			this.plugin.settings.keepRevisionsForever && isMarkdownPath(path)
		);
	}

	private async savePreMergeSnapshots(path: string, localContent: ArrayBuffer, remoteContent: ArrayBuffer): Promise<void> {
		const localPath = preMergeSnapshotPath(path, 'local');
		const remotePath = preMergeSnapshotPath(path, 'remote');
		await this.snapshotManager.saveSnapshot(localPath, textDecoder.decode(localContent));
		await this.snapshotManager.saveSnapshot(remotePath, textDecoder.decode(remoteContent));
	}

	private async cleanupPreMergeSnapshots(path: string): Promise<void> {
		await this.snapshotManager.deleteSnapshot(preMergeSnapshotPath(path, 'local'));
		await this.snapshotManager.deleteSnapshot(preMergeSnapshotPath(path, 'remote'));
	}

	private logActivity(action: ActivityLogEntry['action'], path: string, detail: string): void {
		const entry: ActivityLogEntry = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
			action,
			path,
			detail,
		};
		this.options.logActivity?.(entry);
		console.debug('Conflict handled', entry);
		new Notice(action === 'merged' ? `Merged ${path}` : `Conflict resolved for ${path}`);
	}
}
