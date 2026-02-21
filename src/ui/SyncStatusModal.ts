import { App, Modal, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { SyncStatusSnapshot } from './SyncStatusBar';

export class SyncStatusModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: GDriveSyncPlugin,
		private readonly status: SyncStatusSnapshot
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Google Drive sync status');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: `Current status: ${this.status.status}` });
		if (this.status.lastError) {
			this.contentEl.createEl('p', { text: `Last error: ${this.status.lastError}`, cls: 'gdrive-sync-error' });
		}
		if (this.status.lastSyncAt) {
			this.contentEl.createEl('p', { text: `Last synced: ${new Date(this.status.lastSyncAt).toLocaleString()}` });
		}
		if (this.status.queuedCount > 0) {
			this.contentEl.createEl('p', { text: `${this.status.queuedCount} changes are queued.` });
		}
		if (this.status.conflictCount > 0) {
			this.contentEl.createEl('p', { text: `${this.status.conflictCount} conflicts need review.` });
		}

		new Setting(this.contentEl)
			.setName('Open activity log')
			.addButton(button => {
				button.setButtonText('Open').onClick(() => {
					this.close();
					void this.plugin.activateActivityLogView();
				});
			});

		new Setting(this.contentEl)
			.setName('Run sync now')
			.addButton(button => {
				button.setButtonText('Sync now').setCta().onClick(() => {
					this.close();
					void this.plugin.syncNow();
				});
			});
	}
}
