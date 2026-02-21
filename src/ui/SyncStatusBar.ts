import { Notice } from 'obsidian';
import type GDriveSyncPlugin from '../main';

export type BasicSyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error' | 'paused';

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

	setPending(fileCount = 0): void {
		this.status = 'pending';
		this.lastError = '';
		this.render(fileCount > 0 ? `Pending ${fileCount}` : 'Pending');
	}

	setOffline(): void {
		this.status = 'offline';
		this.render('Offline');
	}

	setPaused(): void {
		this.status = 'paused';
		this.lastError = '';
		this.render('Paused');
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
			'gdrive-sync-status--pending',
			'gdrive-sync-status--offline',
			'gdrive-sync-status--paused',
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
		if (this.status === 'pending') return 'Local changes are queued for upload';
		if (this.status === 'offline') return 'Offline. Changes will sync when online';
		if (this.status === 'paused') return 'Sync is paused';
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

		if (this.status === 'offline') {
			new Notice('Google Drive sync is offline. Changes will sync when online.');
			return;
		}

		if (this.status === 'paused') {
			new Notice('Google Drive sync is paused.');
			return;
		}

		new Notice(`Last synced at ${new Date(this.lastSyncAt).toLocaleString()}`);
	}
}
