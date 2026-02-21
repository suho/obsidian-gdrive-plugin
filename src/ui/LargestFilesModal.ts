import { App, Modal, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveFileMetadata } from '../types';

function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export class LargestFilesModal extends Modal {
	private loading = false;
	private entries: DriveFileMetadata[] = [];
	private error = '';

	constructor(app: App, private readonly plugin: GDriveSyncPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Largest synced files');
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		if (!this.plugin.settings.gDriveFolderId) {
			this.error = 'Set up Google Drive sync first.';
			this.render();
			return;
		}

		this.loading = true;
		this.error = '';
		this.render();
		try {
			this.entries = await this.plugin.driveClient.listLargestFiles(this.plugin.settings.gDriveFolderId, 20);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private render(): void {
		this.contentEl.empty();
		if (this.loading) {
			this.contentEl.createEl('p', { text: 'Loading largest files...' });
			return;
		}

		if (this.error) {
			this.contentEl.createEl('p', { text: this.error, cls: 'gdrive-sync-error' });
			return;
		}

		new Setting(this.contentEl)
			.setName('Google Drive storage')
			.setDesc('Open Google Drive storage settings in your browser.')
			.addButton(button => {
				button.setButtonText('Open storage settings').onClick(() => {
					window.open('https://drive.google.com/settings/storage', '_blank');
				});
			});

		const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-table' });
		const header = table.createTHead().insertRow();
		header.insertCell().setText('Path');
		header.insertCell().setText('Size');
		header.insertCell().setText('Last modified');

		const body = table.createTBody();
		for (const entry of this.entries) {
			const row = body.insertRow();
			row.insertCell().setText(entry.name);
			row.insertCell().setText(formatSize(Number(entry.size ?? 0)));
			row.insertCell().setText(new Date(entry.modifiedTime).toLocaleString());
		}

		if (this.entries.length === 0) {
			const row = body.insertRow();
			row.insertCell().setText('No files found.');
			row.insertCell();
			row.insertCell();
		}
	}
}
