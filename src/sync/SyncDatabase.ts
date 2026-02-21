import { normalizePath } from 'obsidian';
import type { SyncRecord } from '../types';
import type GDriveSyncPlugin from '../main';

interface SyncDatabasePayload {
	version: number;
	updatedAt: number;
	records: Record<string, SyncRecord>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSyncStatus(value: unknown): value is SyncRecord['status'] {
	return (
		value === 'synced' ||
		value === 'pending-push' ||
		value === 'pending-pull' ||
		value === 'conflict'
	);
}

function isSyncRecord(value: unknown): value is SyncRecord {
	if (!isObject(value)) return false;
	return (
		typeof value.gDriveFileId === 'string' &&
		typeof value.localPath === 'string' &&
		typeof value.localHash === 'string' &&
		typeof value.remoteHash === 'string' &&
		typeof value.lastSyncedTimestamp === 'number' &&
		isSyncStatus(value.status)
	);
}

function parsePayload(raw: string): SyncDatabasePayload {
	const parsed = JSON.parse(raw) as unknown;
	if (!isObject(parsed)) {
		throw new Error('Invalid sync database payload');
	}

	const { version, updatedAt, records } = parsed;
	if (typeof version !== 'number' || typeof updatedAt !== 'number' || !isObject(records)) {
		throw new Error('Invalid sync database payload schema');
	}

	const cleanRecords: Record<string, SyncRecord> = {};
	for (const [path, record] of Object.entries(records)) {
		if (isSyncRecord(record)) {
			cleanRecords[path] = {
				...record,
				localPath: normalizePath(record.localPath),
			};
		}
	}

	return { version, updatedAt, records: cleanRecords };
}

export class SyncDatabase {
	private readonly baseDir: string;
	private readonly dbPath: string;
	private readonly backupPath: string;
	private readonly tmpPath: string;
	private records = new Map<string, SyncRecord>();
	private loadPromise: Promise<void> | null = null;
	private loaded = false;

	constructor(private readonly plugin: GDriveSyncPlugin) {
		this.baseDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
		this.dbPath = normalizePath(`${this.baseDir}/sync-db.json`);
		this.backupPath = normalizePath(`${this.baseDir}/sync-db.backup.json`);
		this.tmpPath = normalizePath(`${this.baseDir}/sync-db.tmp.json`);
	}

	getDatabasePath(): string {
		return this.dbPath;
	}

	startLazyLoad(): void {
		if (!this.loadPromise) {
			this.loadPromise = this.loadInternal();
		}
	}

	async load(): Promise<void> {
		await this.ensureLoaded();
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}

		if (!this.loadPromise) {
			this.loadPromise = this.loadInternal();
		}

		await this.loadPromise;
	}

	private async loadInternal(): Promise<void> {
		await this.ensureBaseDir();

		if (!await this.plugin.app.vault.adapter.exists(this.dbPath)) {
			this.records.clear();
			this.loaded = true;
			return;
		}

		try {
			const payload = parsePayload(await this.plugin.app.vault.adapter.read(this.dbPath));
			this.records = new Map<string, SyncRecord>(Object.entries(payload.records));
			this.loaded = true;
			return;
		} catch {
			// Fall through to backup recovery.
		}

		if (await this.plugin.app.vault.adapter.exists(this.backupPath)) {
			try {
				const payload = parsePayload(await this.plugin.app.vault.adapter.read(this.backupPath));
				this.records = new Map<string, SyncRecord>(Object.entries(payload.records));
				await this.save();
				this.loaded = true;
				return;
			} catch {
				// Backup is invalid as well; rebuild from scratch.
			}
		}

		const corruptedPath = normalizePath(`${this.baseDir}/sync-db.corrupt-${Date.now()}.json`);
		try {
			await this.plugin.app.vault.adapter.rename(this.dbPath, corruptedPath);
		} catch {
			// Ignore; we can still proceed with an empty database.
		}

		this.records.clear();
		await this.save();
		this.loaded = true;
	}

	async save(): Promise<void> {
		await this.ensureBaseDir();

		if (await this.plugin.app.vault.adapter.exists(this.dbPath)) {
			try {
				const current = await this.plugin.app.vault.adapter.read(this.dbPath);
				await this.plugin.app.vault.adapter.write(this.backupPath, current);
			} catch {
				// Backup failures should not block main save.
			}
		}

		const payload: SyncDatabasePayload = {
			version: 1,
			updatedAt: Date.now(),
			records: Object.fromEntries(this.records.entries()),
		};

		await this.plugin.app.vault.adapter.write(this.tmpPath, JSON.stringify(payload, null, 2));

		if (await this.plugin.app.vault.adapter.exists(this.dbPath)) {
			await this.plugin.app.vault.adapter.remove(this.dbPath);
		}

		await this.plugin.app.vault.adapter.rename(this.tmpPath, this.dbPath);
	}

	getRecord(path: string): SyncRecord | null {
		return this.records.get(normalizePath(path)) ?? null;
	}

	setRecord(path: string, record: SyncRecord): void {
		const normalizedPath = normalizePath(path);
		this.records.set(normalizedPath, {
			...record,
			localPath: normalizedPath,
		});
	}

	deleteRecord(path: string): void {
		this.records.delete(normalizePath(path));
	}

	getAllRecords(): SyncRecord[] {
		return [...this.records.values()].map(record => ({ ...record }));
	}

	getByGDriveId(fileId: string): SyncRecord | null {
		for (const record of this.records.values()) {
			if (record.gDriveFileId === fileId) {
				return { ...record };
			}
		}
		return null;
	}

	getKnownGDriveIds(): Set<string> {
		const ids = new Set<string>();
		for (const record of this.records.values()) {
			ids.add(record.gDriveFileId);
		}
		return ids;
	}

	reset(): void {
		this.records.clear();
	}

	async deletePersistedFiles(): Promise<void> {
		await this.ensureBaseDir();

		for (const path of [this.dbPath, this.backupPath, this.tmpPath]) {
			if (await this.plugin.app.vault.adapter.exists(path)) {
				await this.plugin.app.vault.adapter.remove(path);
			}
		}

		this.records.clear();
		this.loaded = true;
	}

	private async ensureBaseDir(): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(this.baseDir)) {
			await this.plugin.app.vault.adapter.mkdir(this.baseDir);
		}
	}
}
