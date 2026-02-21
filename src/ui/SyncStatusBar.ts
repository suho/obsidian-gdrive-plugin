import { setIcon } from 'obsidian';
import type GDriveSyncPlugin from '../main';

export type BasicSyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error' | 'conflict' | 'paused';

export interface SyncStatusSnapshot {
	status: BasicSyncStatus;
	lastSyncAt: number;
	lastError: string;
	queuedCount: number;
	syncingCount: number;
	conflictCount: number;
}

export class SyncStatusBar {
	private readonly element: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly labelEl: HTMLElement;
	private status: BasicSyncStatus = 'synced';
	private lastSyncAt = 0;
	private lastError = '';
	private queuedCount = 0;
	private syncingCount = 0;
	private conflictCount = 0;

	constructor(private readonly plugin: GDriveSyncPlugin) {
		this.element = this.plugin.addStatusBarItem();
		this.element.addClass('gdrive-sync-statusbar');
		this.iconEl = this.element.createSpan({ cls: 'gdrive-sync-statusbar-icon' });
		this.labelEl = this.element.createSpan({ cls: 'gdrive-sync-statusbar-label' });
		this.element.addEventListener('click', () => {
			this.plugin.handleStatusBarClick(this.getState());
		});
		this.setSynced();
	}

	getState(): SyncStatusSnapshot {
		return {
			status: this.status,
			lastSyncAt: this.lastSyncAt,
			lastError: this.lastError,
			queuedCount: this.queuedCount,
			syncingCount: this.syncingCount,
			conflictCount: this.conflictCount,
		};
	}

	setSyncing(fileCount = 0): void {
		this.status = 'syncing';
		this.syncingCount = Math.max(0, fileCount);
		this.lastError = '';
		this.render(fileCount > 0 ? `Syncing ${fileCount}` : 'Syncing');
	}

	setPending(fileCount = 0): void {
		this.status = 'pending';
		this.queuedCount = Math.max(0, fileCount);
		this.syncingCount = 0;
		this.render(fileCount > 0 ? `Pending ${fileCount}` : 'Pending');
	}

	setOffline(queuedCount = 0): void {
		this.status = 'offline';
		this.queuedCount = Math.max(0, queuedCount);
		this.syncingCount = 0;
		this.render(queuedCount > 0 ? `Offline ${queuedCount}` : 'Offline');
	}

	setConflict(conflictCount = 1): void {
		this.status = 'conflict';
		this.conflictCount = Math.max(1, conflictCount);
		this.syncingCount = 0;
		this.render(this.conflictCount === 1 ? 'Conflict' : `Conflicts ${this.conflictCount}`);
	}

	setPaused(): void {
		this.status = 'paused';
		this.syncingCount = 0;
		this.render('Paused');
	}

	setSynced(): void {
		this.status = 'synced';
		this.lastSyncAt = Date.now();
		this.lastError = '';
		this.queuedCount = 0;
		this.syncingCount = 0;
		this.conflictCount = 0;
		this.render('Synced');
	}

	setError(message: string): void {
		this.status = 'error';
		this.lastError = message;
		this.syncingCount = 0;
		this.render('Sync error');
	}

	private render(label: string): void {
		this.element.removeClass(
			'gdrive-sync-status--synced',
			'gdrive-sync-status--syncing',
			'gdrive-sync-status--pending',
			'gdrive-sync-status--offline',
			'gdrive-sync-status--paused',
			'gdrive-sync-status--error',
			'gdrive-sync-status--conflict'
		);
		this.element.addClass(`gdrive-sync-status--${this.status}`);
		this.iconEl.removeClass('gdrive-sync-spin');
		this.iconEl.empty();
		setIcon(this.iconEl, this.iconNameForState());
		if (this.status === 'syncing') {
			this.iconEl.addClass('gdrive-sync-spin');
		}
		this.labelEl.setText(`Google Drive: ${label}`);
		this.element.setAttr('aria-label', this.tooltipForState());
		this.element.title = this.tooltipForState();
	}

	private iconNameForState(): string {
		if (this.status === 'synced') return 'cloud-check';
		if (this.status === 'syncing') return 'refresh-cw';
		if (this.status === 'pending') return 'cloud-upload';
		if (this.status === 'offline') return 'cloud-off';
		if (this.status === 'paused') return 'pause-circle';
		if (this.status === 'conflict') return 'zap';
		return 'alert-triangle';
	}

	private tooltipForState(): string {
		if (this.status === 'synced') return 'All changes synced';
		if (this.status === 'syncing') {
			return this.syncingCount > 0 ? `Syncing ${this.syncingCount} files...` : 'Sync in progress';
		}
		if (this.status === 'pending') {
			return this.queuedCount > 0
				? `${this.queuedCount} changes waiting to sync`
				: 'Local changes are queued for upload';
		}
		if (this.status === 'offline') {
			return this.queuedCount > 0
				? `Offline. ${this.queuedCount} changes queued`
				: 'Offline. Changes will sync when online';
		}
		if (this.status === 'paused') return 'Sync is paused';
		if (this.status === 'conflict') {
			return this.conflictCount > 1
				? `${this.conflictCount} conflicts need attention`
				: '1 conflict needs attention';
		}
		return `Sync error${this.lastError ? `: ${this.lastError}` : ''}`;
	}
}
