import { App, Modal, Notice, Setting, normalizePath } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveFileMetadata } from '../types';

interface LocalTrashEntry {
	id: string;
	trashPath: string;
	originalPath: string;
	deletedAt: number;
}

interface RemoteTrashEntry {
	id: string;
	fileId: string;
	path: string;
	deletedAt: number;
}

function formatDate(ts: number): string {
	if (!ts) return 'Unknown';
	return new Date(ts).toLocaleString();
}

function parseLocalTrashPath(trashDir: string, fullPath: string): LocalTrashEntry {
	const normalized = normalizePath(fullPath);
	const relative = normalized.slice(normalizePath(trashDir).length + 1);
	const segments = relative.split('/');
	const first = segments.shift() ?? '';
	const dash = first.indexOf('-');
	const prefix = dash >= 0 ? first.slice(0, dash) : '';
	const firstOriginalSegment = dash >= 0 ? first.slice(dash + 1) : first;
	const originalParts = [firstOriginalSegment, ...segments].filter(Boolean);
	const deletedAt = Number(prefix);

	return {
		id: normalized,
		trashPath: normalized,
		originalPath: normalizePath(originalParts.join('/')),
		deletedAt: Number.isFinite(deletedAt) ? deletedAt : 0,
	};
}

export class DeletedFilesModal extends Modal {
	private loading = false;
	private localEntries: LocalTrashEntry[] = [];
	private remoteEntries: RemoteTrashEntry[] = [];
	private error = '';

	constructor(app: App, private readonly plugin: GDriveSyncPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Deleted files');
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = '';
		this.render();

		try {
			const trashDir = this.plugin.syncManager.getLocalTrashDirectoryPath();
			this.localEntries = await this.collectLocalTrashEntries(trashDir);

			if (this.plugin.settings.gDriveFolderId) {
				const remoteFiles = await this.plugin.driveClient.listTrashedFiles(this.plugin.settings.gDriveFolderId);
				this.remoteEntries = remoteFiles.map(file => this.toRemoteEntry(file));
			} else {
				this.remoteEntries = [];
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async collectLocalTrashEntries(trashDir: string): Promise<LocalTrashEntry[]> {
		if (!await this.app.vault.adapter.exists(trashDir)) {
			return [];
		}

		const results: LocalTrashEntry[] = [];
		const pending = [normalizePath(trashDir)];
		const visited = new Set<string>();

		while (pending.length > 0) {
			const dir = pending.pop();
			if (!dir || visited.has(dir)) {
				continue;
			}
			visited.add(dir);
			const listed = await this.app.vault.adapter.list(dir);
			for (const file of listed.files) {
				results.push(parseLocalTrashPath(trashDir, file));
			}
			for (const folder of listed.folders) {
				const normalized = normalizePath(folder);
				if (!visited.has(normalized)) {
					pending.push(normalized);
				}
			}
		}

		results.sort((a, b) => b.deletedAt - a.deletedAt);
		return results;
	}

	private toRemoteEntry(file: DriveFileMetadata): RemoteTrashEntry {
		return {
			id: file.id,
			fileId: file.id,
			path: file.name,
			deletedAt: Date.parse(file.modifiedTime),
		};
	}

	private render(): void {
		this.contentEl.empty();
		if (this.loading) {
			this.contentEl.createEl('p', { text: 'Loading deleted files...' });
			return;
		}

		if (this.error) {
			this.contentEl.createEl('p', { text: this.error, cls: 'gdrive-sync-error' });
			return;
		}

		new Setting(this.contentEl)
			.setName('Refresh')
			.addButton(button => {
				button.setButtonText('Reload').onClick(() => {
					void this.load();
				});
			});

		this.contentEl.createEl('h4', { text: 'Local trash' });
		this.renderLocalTable();
		this.contentEl.createEl('h4', { text: 'Google Drive trash' });
		this.renderRemoteTable();
	}

	private renderLocalTable(): void {
		const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-table' });
		const header = table.createTHead().insertRow();
		header.insertCell().setText('File');
		header.insertCell().setText('Deleted');
		header.insertCell().setText('Source');
		header.insertCell().setText('Action');

		const body = table.createTBody();
		if (this.localEntries.length === 0) {
			const row = body.insertRow();
			row.insertCell().setText('No local deleted files');
			row.insertCell();
			row.insertCell();
			row.insertCell();
			return;
		}

		for (const entry of this.localEntries) {
			const row = body.insertRow();
			row.insertCell().setText(entry.originalPath);
			row.insertCell().setText(formatDate(entry.deletedAt));
			row.insertCell().setText('Local');
			const action = row.insertCell();
			const button = action.createEl('button', { text: 'Restore' });
			button.addEventListener('click', () => {
				void (async () => {
					button.disabled = true;
					try {
						await this.plugin.syncManager.restoreLocalTrashFile(entry.trashPath, entry.originalPath);
						new Notice(`Restored ${entry.originalPath}`);
						await this.load();
					} catch (err) {
						button.disabled = false;
						new Notice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
					}
				})();
			});
		}
	}

	private renderRemoteTable(): void {
		const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-table' });
		const header = table.createTHead().insertRow();
		header.insertCell().setText('File');
		header.insertCell().setText('Deleted');
		header.insertCell().setText('Source');
		header.insertCell().setText('Action');

		const body = table.createTBody();
		if (this.remoteEntries.length === 0) {
			const row = body.insertRow();
			row.insertCell().setText('No Google Drive deleted files');
			row.insertCell();
			row.insertCell();
			row.insertCell();
			return;
		}

		for (const entry of this.remoteEntries) {
			const row = body.insertRow();
			row.insertCell().setText(entry.path);
			row.insertCell().setText(formatDate(entry.deletedAt));
			row.insertCell().setText('Remote');
			const action = row.insertCell();
			const button = action.createEl('button', { text: 'Restore' });
			button.addEventListener('click', () => {
				void (async () => {
					button.disabled = true;
					try {
						const restoredPath = await this.plugin.syncManager.restoreFileFromRemoteTrash(entry.fileId, entry.path);
						new Notice(`Restored ${restoredPath}`);
						await this.load();
					} catch (err) {
						button.disabled = false;
						new Notice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
					}
				})();
			});
		}
	}
}
