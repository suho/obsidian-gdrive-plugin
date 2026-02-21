import { Notice, Platform, Plugin, TFile } from 'obsidian';
import { GoogleAuthManager } from './auth/GoogleAuthManager';
import { DriveClient } from './gdrive/DriveClient';
import { DEFAULT_SETTINGS, type GDrivePluginSettings } from './settings';
import { SyncManager } from './sync/SyncManager';
import type { ActivityLogEntry } from './types';
import { ActivityLogModal, ActivityLogView, ACTIVITY_LOG_VIEW_TYPE, type ActivityLogFilter } from './ui/ActivityLogView';
import { ConfirmModal } from './ui/ConfirmModal';
import { DeletedFilesModal } from './ui/DeletedFilesModal';
import { LargestFilesModal } from './ui/LargestFilesModal';
import { ProgressModal } from './ui/ProgressModal';
import { GDriveSettingTab } from './ui/SettingTab';
import { SetupWizard } from './ui/SetupWizard';
import { SyncStatusBar, type SyncStatusSnapshot } from './ui/SyncStatusBar';
import { SyncStatusModal } from './ui/SyncStatusModal';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { generateDeviceId } from './utils/deviceId';

export default class GDriveSyncPlugin extends Plugin {
	settings: GDrivePluginSettings;
	authManager!: GoogleAuthManager;
	driveClient!: DriveClient;
	syncManager!: SyncManager;
	statusBar!: SyncStatusBar;
	settingTab!: GDriveSettingTab;

	async onload() {
		await this.loadSettings();

		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		this.authManager = new GoogleAuthManager(this);
		this.registerObsidianProtocolHandler('gdrive-callback', async (params) => {
			const searchParams = new URLSearchParams();
			for (const [key, value] of Object.entries(params)) {
				searchParams.append(key, value);
			}
			try {
				await this.authManager.handleMobileCallback(searchParams);
				new Notice('Google account connected successfully.');
				this.refreshSettingTab();
			} catch (err) {
				new Notice(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		this.driveClient = new DriveClient(this.authManager);
		this.statusBar = new SyncStatusBar(this);
		this.syncManager = new SyncManager(this, this.driveClient, this.statusBar);
		await this.syncManager.initialize();

		this.registerView(ACTIVITY_LOG_VIEW_TYPE, (leaf) => new ActivityLogView(leaf, this));

		if (this.settings.refreshToken) {
			void this.authManager.restoreSession();
		}

		this.settingTab = new GDriveSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon('cloud', 'Sync now', () => {
			void this.syncNow();
		});

		this.registerCommands();
		this.registerFileMenuEntry();

		if (!this.settings.setupComplete) {
			this.app.workspace.onLayoutReady(() => {
				if (Platform.isMobile && !this.settings.refreshToken) {
					return;
				}
				this.openSetupWizard();
			});
		} else if (this.settings.syncOnStartup) {
			void this.syncNow();
		}
	}

	onunload() {
		void this.syncManager?.shutdown();
		this.authManager?.destroy();
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => { void this.syncNow(); },
		});

		this.addCommand({
			id: 'push-changes',
			name: 'Push changes',
			callback: () => { void this.pushChangesNow(); },
		});

		this.addCommand({
			id: 'pull-changes',
			name: 'Pull changes',
			callback: () => { void this.pullChangesNow(); },
		});

		if (!Platform.isMobile) {
			this.addCommand({
				id: 'authenticate',
				name: 'Connect to Google Drive',
				callback: () => { this.openSetupWizard(); },
			});
		}

		this.addCommand({
			id: 'view-activity-log',
			name: 'View activity log',
			callback: () => { void this.activateActivityLogView(); },
		});

		this.addCommand({
			id: 'view-conflicts',
			name: 'View conflicts',
			callback: () => {
				void this.activateActivityLogView('conflicts');
			},
		});

		this.addCommand({
			id: 'view-deleted-files',
			name: 'View deleted files',
			callback: () => { this.openDeletedFilesModal(); },
		});

		this.addCommand({
			id: 'view-largest-files',
			name: 'View largest synced files',
			callback: () => { this.openLargestFilesModal(); },
		});

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			callback: () => {
				void (async () => {
					await this.syncManager.pauseSync();
					new Notice('Google Drive sync paused.');
				})();
			},
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			callback: () => {
				void (async () => {
					await this.syncManager.resumeSync();
					new Notice('Google Drive sync resumed.');
					void this.syncNow();
				})();
			},
		});

		this.addCommand({
			id: 'acknowledge-storage-full',
			name: 'Resume uploads after storage warning',
			callback: () => {
				void (async () => {
					const resumed = await this.syncManager.acknowledgeStorageQuotaPause();
					new Notice(resumed ? 'Storage warning acknowledged. Uploads can resume.' : 'Uploads are already active.');
				})();
			},
		});

		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				this.openPluginSettings();
			},
		});
	}

	private registerFileMenuEntry(): void {
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile)) {
				return;
			}
			const record = this.syncManager.syncDb.getRecord(file.path);
			if (!record?.gDriveFileId) {
				return;
			}
			menu.addItem((item) => {
				item
					.setTitle('View Google Drive history')
					.setIcon('history')
					.onClick(() => {
						this.openVersionHistory(file.path, record.gDriveFileId);
					});
			});
		}));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<GDrivePluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshSettingTab(): void {
		this.settingTab?.display();
	}

	handleStatusBarClick(status: SyncStatusSnapshot): void {
		if (status.status === 'storage-full') {
			this.openPluginSettings();
			return;
		}
		if (Platform.isMobile) {
			new SyncStatusModal(this.app, this, status).open();
			return;
		}
		void this.activateActivityLogView(status.status === 'conflict' ? 'conflicts' : 'all');
	}

	openSetupWizard(): void {
		if (Platform.isMobile && !this.settings.refreshToken) {
			new Notice('Add a refresh token in plugin settings to connect on mobile.');
			this.openPluginSettings();
			return;
		}
		new SetupWizard(this.app, this).open();
	}

	openPluginSettings(): void {
		(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
		(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('gdrive-sync');
	}

	async syncNow(): Promise<void> {
		if (!this.settings.setupComplete) {
			if (Platform.isMobile && !this.settings.refreshToken) {
				new Notice('Add a refresh token in plugin settings first.');
				this.openPluginSettings();
			} else {
				new Notice('Complete Google Drive setup first.');
				this.openSetupWizard();
			}
			return;
		}

		const result = await this.syncManager.runSync();
		if (!result) return;

		const total = result.pulled + result.created + result.updated + result.renamed + result.deleted;
		if (total === 0) {
			new Notice('Google Drive sync complete. No changes found.');
			return;
		}

		new Notice(
			`Google Drive sync complete. Pulled ${result.pulled}, created ${result.created}, updated ${result.updated}, renamed ${result.renamed}, deleted ${result.deleted}.`
		);
	}

	async pushChangesNow(): Promise<void> {
		const result = await this.syncManager.runPushNow();
		if (!result) {
			return;
		}
		const total = result.created + result.updated + result.renamed + result.deleted;
		if (total === 0) {
			new Notice('Push complete. No local changes found.');
			return;
		}
		new Notice(`Push complete. Created ${result.created}, updated ${result.updated}, renamed ${result.renamed}, deleted ${result.deleted}.`);
	}

	async pullChangesNow(): Promise<void> {
		const result = await this.syncManager.runPullNow();
		if (!result) {
			return;
		}
		if (result.processed === 0) {
			new Notice('Pull complete. No remote changes found.');
			return;
		}
		new Notice(`Pull complete. Applied ${result.processed} changes.`);
	}

	async triggerInitialSync(): Promise<void> {
		await this.syncNow();
	}

	async activateActivityLogView(filter: ActivityLogFilter = 'all'): Promise<void> {
		if (Platform.isMobile) {
			new ActivityLogModal(this.app, this, filter).open();
			return;
		}

		const existingLeaf = this.app.workspace.getLeavesOfType(ACTIVITY_LOG_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice('Could not open the activity log view.');
			return;
		}

		await leaf.setViewState({ type: ACTIVITY_LOG_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);

		const view = leaf.view;
		if (view instanceof ActivityLogView) {
			view.setFilter(filter);
		}
	}

	restoreDeletedFromActivity(entry: ActivityLogEntry): Promise<string> {
		if (!entry.fileId) {
			throw new Error('This entry does not include a Google Drive file ID.');
		}
		return this.syncManager.restoreFileFromRemoteTrash(entry.fileId, entry.path);
	}

	openDeletedFilesModal(): void {
		new DeletedFilesModal(this.app, this).open();
	}

	openLargestFilesModal(): void {
		new LargestFilesModal(this.app, this).open();
	}

	openVersionHistory(filePath: string, fileId: string): void {
		new VersionHistoryModal(this.app, this, filePath, fileId).open();
	}

	forceFullResync(): void {
		void (async () => {
			const firstConfirm = await ConfirmModal.ask(this.app, {
				title: 'Force full re-sync',
				message: 'This will compare all local and remote files. Continue?',
				confirmText: 'Continue',
				cancelText: 'Cancel',
				warning: true,
			});
			if (!firstConfirm) {
				return;
			}

			const preview = await this.syncManager.previewFullResync();
			const secondConfirm = await ConfirmModal.ask(this.app, {
				title: 'Confirm full re-sync',
				message:
					`${preview.uploads} files will be uploaded, ` +
					`${preview.downloads} files will be downloaded, ` +
					`${preview.conflicts} conflicts may require resolution. Continue?`,
				confirmText: 'Run full re-sync',
				cancelText: 'Cancel',
				warning: true,
			});
			if (!secondConfirm) {
				return;
			}

			let cancelled = false;
			const progress = new ProgressModal(this.app, {
				title: 'Full re-sync in progress',
				total: 8,
				onCancel: () => {
					cancelled = true;
				},
			});
			let currentStep = 0;
			progress.open();
			progress.updateProgress(0, 'Preparing full sync...');
			try {
				const result = await this.syncManager.forceFullResync(
					(message) => {
						currentStep = Math.min(currentStep + 1, 8);
						progress.updateProgress(currentStep, message);
					},
					() => cancelled
				);
				progress.updateProgress(8, 'Finalizing');
				progress.finish();
				if (!result) {
					if (cancelled) {
						new Notice('Full re-sync cancelled. Partial sync state was kept.');
					}
					return;
				}
				const total = result.pulled + result.created + result.updated + result.renamed + result.deleted;
				new Notice(
					total > 0
						? `Full re-sync complete. ${total} changes applied.`
						: 'Full re-sync complete. No changes found.'
				);
			} catch (err) {
				progress.finish();
				new Notice(`Full re-sync failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
			}
		})();
	}

	resetSyncState(): void {
		void (async () => {
			const confirmed = await ConfirmModal.ask(this.app, {
				title: 'Reset sync state',
				message: 'This will clear the sync database. All files will be re-compared on next sync. Continue?',
				confirmText: 'Reset sync state',
				cancelText: 'Cancel',
				warning: true,
			});
			if (!confirmed) {
				return;
			}

			await this.syncManager.resetSyncStateArtifacts();
			new Notice('Sync state was reset. Running a fresh sync comparison.');
			void this.syncNow();
		})();
	}
}
