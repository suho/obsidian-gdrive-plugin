import { App, Modal, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { SyncIgnoredFileEntry } from '../sync/SyncManager';

export class SyncIgnoredFilesModal extends Modal {
	private loading = false;
	private entries: SyncIgnoredFileEntry[] = [];
	private error = '';
	private remoteWarning = '';
	private query = '';
	private summaryEl: HTMLParagraphElement | null = null;
	private tableBodyEl: HTMLTableSectionElement | null = null;

	constructor(app: App, private readonly plugin: GDriveSyncPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Sync ignored files');
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = '';
		this.remoteWarning = '';
		this.render();
		try {
			const snapshot = await this.plugin.syncManager.listSyncIgnoredFiles();
			this.entries = snapshot.entries;
			this.remoteWarning = snapshot.remoteWarning;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private visibleEntries(): SyncIgnoredFileEntry[] {
		const trimmedQuery = this.query.trim().toLowerCase();
		if (!trimmedQuery) {
			return this.entries;
		}
		return this.entries.filter(entry =>
			entry.path.toLowerCase().includes(trimmedQuery) ||
			entry.reasonText.toLowerCase().includes(trimmedQuery) ||
			entry.source.toLowerCase().includes(trimmedQuery)
		);
	}

	private renderVisibleEntries(): void {
		if (!this.summaryEl || !this.tableBodyEl) {
			return;
		}

		const visible = this.visibleEntries();
		this.summaryEl.setText(`Showing ${visible.length} ignored files.`);
		this.tableBodyEl.empty();

		if (visible.length === 0) {
			const row = this.tableBodyEl.insertRow();
			row.insertCell().setText('No ignored files found.');
			row.insertCell();
			row.insertCell();
			return;
		}

		for (const entry of visible) {
			const row = this.tableBodyEl.insertRow();
			row.insertCell().setText(entry.path);
			row.insertCell().setText(entry.source === 'local' ? 'Local' : 'Remote');
			row.insertCell().setText(entry.reasonText);
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.summaryEl = null;
		this.tableBodyEl = null;

		if (this.loading) {
			this.contentEl.createEl('p', { text: 'Loading ignored files...' });
			return;
		}

		if (this.error) {
			this.contentEl.createEl('p', { text: this.error, cls: 'gdrive-sync-error' });
			return;
		}

		new Setting(this.contentEl)
			.setName('Refresh ignored files')
			.setDesc('List local and remote files currently ignored by selective sync settings.')
			.addButton(button => {
				button.setButtonText('Refresh').onClick(() => {
					void this.load();
				});
			});

		const controls = this.contentEl.createDiv({ cls: 'gdrive-sync-folder-controls' });
		const search = controls.createEl('input', {
			type: 'search',
			placeholder: 'Search ignored files',
		});
		search.value = this.query;
		search.addEventListener('input', () => {
			this.query = search.value;
			this.renderVisibleEntries();
		});

		if (this.remoteWarning) {
			this.contentEl.createEl('p', { text: this.remoteWarning, cls: 'gdrive-sync-error' });
		}

		this.summaryEl = this.contentEl.createEl('p');

		const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-table' });
		const header = table.createTHead().insertRow();
		header.insertCell().setText('Path');
		header.insertCell().setText('Source');
		header.insertCell().setText('Reason');

		this.tableBodyEl = table.createTBody();
		this.renderVisibleEntries();
	}
}
