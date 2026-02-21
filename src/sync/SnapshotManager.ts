import { normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';

interface SnapshotPayload {
	version: number;
	path: string;
	savedAt: number;
	codec: 'gzip' | 'raw';
	contentBase64: string;
}

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface CompressionGlobals {
	CompressionStream?: new (format: 'gzip') => TransformStream<Uint8Array, Uint8Array>;
	DecompressionStream?: new (format: 'gzip') => TransformStream<Uint8Array, Uint8Array>;
}

function isSnapshotPayload(value: unknown): value is SnapshotPayload {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const payload = value as Partial<SnapshotPayload>;
	return (
		typeof payload.version === 'number' &&
		typeof payload.path === 'string' &&
		typeof payload.savedAt === 'number' &&
		(payload.codec === 'gzip' || payload.codec === 'raw') &&
		typeof payload.contentBase64 === 'string'
	);
}

function isMarkdownPath(path: string): boolean {
	return normalizePath(path).toLowerCase().endsWith('.md');
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function gzipText(content: string): Promise<Uint8Array | null> {
	const globals = globalThis as typeof globalThis & CompressionGlobals;
	if (!globals.CompressionStream) {
		return null;
	}

	const stream = new Blob([new TextEncoder().encode(content)])
		.stream()
		.pipeThrough(new globals.CompressionStream('gzip'));
	const compressed = await new Response(stream).arrayBuffer();
	return new Uint8Array(compressed);
}

async function gunzipText(content: Uint8Array): Promise<string | null> {
	const globals = globalThis as typeof globalThis & CompressionGlobals;
	if (!globals.DecompressionStream) {
		return null;
	}

	const stream = new Blob([content]).stream().pipeThrough(new globals.DecompressionStream('gzip'));
	const uncompressed = await new Response(stream).arrayBuffer();
	return new TextDecoder().decode(uncompressed);
}

export class SnapshotManager {
	private readonly dataDir: string;
	private readonly snapshotsDir: string;

	constructor(private readonly plugin: GDriveSyncPlugin) {
		this.dataDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
		this.snapshotsDir = normalizePath(`${this.dataDir}/snapshots`);
	}

	async saveSnapshot(path: string, content: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		if (!isMarkdownPath(normalizedPath)) {
			return;
		}

		await this.ensureSnapshotsDir();

		const gzipped = await gzipText(content);
		const payload: SnapshotPayload = {
			version: 1,
			path: normalizedPath,
			savedAt: Date.now(),
			codec: gzipped ? 'gzip' : 'raw',
			contentBase64: toBase64(gzipped ?? new TextEncoder().encode(content)),
		};

		await this.plugin.app.vault.adapter.write(
			this.snapshotPathFor(normalizedPath),
			JSON.stringify(payload)
		);
	}

	async loadSnapshot(path: string): Promise<string | null> {
		const normalizedPath = normalizePath(path);
		if (!isMarkdownPath(normalizedPath)) {
			return null;
		}

		const snapshotPath = this.snapshotPathFor(normalizedPath);
		if (!await this.plugin.app.vault.adapter.exists(snapshotPath)) {
			return null;
		}

		try {
			const raw = await this.plugin.app.vault.adapter.read(snapshotPath);
			const parsed = JSON.parse(raw) as unknown;
			if (!isSnapshotPayload(parsed)) {
				return null;
			}

			const bytes = fromBase64(parsed.contentBase64);
			if (parsed.codec === 'gzip') {
				const gunzipped = await gunzipText(bytes);
				if (gunzipped !== null) {
					return gunzipped;
				}
			}
			return new TextDecoder().decode(bytes);
		} catch {
			return null;
		}
	}

	async deleteSnapshot(path: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		const snapshotPath = this.snapshotPathFor(normalizedPath);
		if (await this.plugin.app.vault.adapter.exists(snapshotPath)) {
			await this.plugin.app.vault.adapter.remove(snapshotPath);
		}
	}

	async renameSnapshot(oldPath: string, newPath: string): Promise<void> {
		const normalizedOldPath = normalizePath(oldPath);
		const normalizedNewPath = normalizePath(newPath);
		if (!isMarkdownPath(normalizedOldPath) && !isMarkdownPath(normalizedNewPath)) {
			return;
		}

		const oldSnapshotPath = this.snapshotPathFor(normalizedOldPath);
		if (!await this.plugin.app.vault.adapter.exists(oldSnapshotPath)) {
			return;
		}

		const content = await this.loadSnapshot(normalizedOldPath);
		if (content === null) {
			await this.plugin.app.vault.adapter.remove(oldSnapshotPath);
			return;
		}

		await this.saveSnapshot(normalizedNewPath, content);
		await this.plugin.app.vault.adapter.remove(oldSnapshotPath);
	}

	async pruneSnapshots(pendingPaths: Iterable<string> = []): Promise<number> {
		if (!await this.plugin.app.vault.adapter.exists(this.snapshotsDir)) {
			return 0;
		}

		const pending = new Set<string>();
		for (const path of pendingPaths) {
			if (isMarkdownPath(path)) {
				pending.add(normalizePath(path));
			}
		}

		const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
		const listed = await this.plugin.app.vault.adapter.list(this.snapshotsDir);
		let removed = 0;

		for (const snapshotPath of listed.files) {
			try {
				const raw = await this.plugin.app.vault.adapter.read(snapshotPath);
				const parsed = JSON.parse(raw) as unknown;
				if (!isSnapshotPayload(parsed)) {
					await this.plugin.app.vault.adapter.remove(snapshotPath);
					removed += 1;
					continue;
				}

				if (pending.has(normalizePath(parsed.path))) {
					continue;
				}

				if (parsed.savedAt < cutoff) {
					await this.plugin.app.vault.adapter.remove(snapshotPath);
					removed += 1;
				}
			} catch {
				await this.plugin.app.vault.adapter.remove(snapshotPath);
				removed += 1;
			}
		}

		return removed;
	}

	private snapshotPathFor(path: string): string {
		return normalizePath(`${this.snapshotsDir}/${encodeURIComponent(normalizePath(path))}.json`);
	}

	private async ensureSnapshotsDir(): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(this.dataDir)) {
			await this.plugin.app.vault.adapter.mkdir(this.dataDir);
		}
		if (!await this.plugin.app.vault.adapter.exists(this.snapshotsDir)) {
			await this.plugin.app.vault.adapter.mkdir(this.snapshotsDir);
		}
	}
}
