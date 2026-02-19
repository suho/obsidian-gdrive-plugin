import { Notice } from 'obsidian';
import type GDriveSyncPlugin from '../main';

export type BasicSyncStatus = 'synced' | 'syncing' | 'error';

export class SyncStatusBar {
	private readonly element: HTMLElement;
	private status: BasicSyncStatus = 'synced';
	private lastSyncAt = 0;
	private lastError = '';

	constructor(private readonly plugin: GDriveSyncPlugin) {
		this.element = this.plugin.addStatusBarItem();
		this.element.addClass('gdrive-sync-statusbar');
		this.element.addEventListener('click', () => {
			this.showLastSyncNotice();
		});
		this.setSynced();
	}

	setSyncing(fileCount = 0): void {
		this.status = 'syncing';
		this.lastError = '';
		this.render(`Syncing${fileCount > 0 ? ` ${fileCount} files...` : '...'}`);
	}

	setSynced(): void {
		this.status = 'synced';
		this.lastSyncAt = Date.now();
		this.lastError = '';
		this.render('Synced');
	}

	setError(message: string): void {
		this.status = 'error';
		this.lastError = message;
		this.render('Sync error');
	}

	private render(label: string): void {
		this.element.removeClass(
			'gdrive-sync-status--synced',
			'gdrive-sync-status--syncing',
			'gdrive-sync-status--error'
		);
		this.element.addClass(`gdrive-sync-status--${this.status}`);
		this.element.setText(`Google Drive: ${label}`);
		this.element.setAttr('aria-label', this.tooltipForState());
		this.element.title = this.tooltipForState();
	}

	private tooltipForState(): string {
		if (this.status === 'synced') return 'All changes synced';
		if (this.status === 'syncing') return 'Sync in progress';
		return `Sync error${this.lastError ? `: ${this.lastError}` : ''}`;
	}

	private showLastSyncNotice(): void {
		if (this.status === 'error' && this.lastError) {
			new Notice(`Google Drive sync error: ${this.lastError}`);
			return;
		}

		if (!this.lastSyncAt) {
			new Notice('Google Drive sync has not run yet.');
			return;
		}

		new Notice(`Last synced at ${new Date(this.lastSyncAt).toLocaleString()}`);
	}
}
