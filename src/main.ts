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
import { SyncIgnoredFilesModal } from './ui/SyncIgnoredFilesModal';
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
					new Notice('Sync paused.');
				})();
			},
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			callback: () => {
				void (async () => {
					await this.syncManager.resumeSync();
					new Notice('Sync resumed.');
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

		this.addCommand({
			id: 'clean-duplicate-artifacts',
			name: 'Clean duplicate sync artifacts',
			callback: () => {
				this.cleanDuplicateArtifacts();
			},
		});

		this.addCommand({
			id: 'reset-sync-state',
			name: 'Force full re-sync',
			callback: () => {
				this.forceFullResync();
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
			new Notice('Add a refresh token in plugin settings. It validates automatically.');
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
				new Notice('Add a refresh token in plugin settings. It validates automatically.');
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
			new Notice('Sync complete. No changes found.');
			return;
		}

		new Notice(
			`Sync complete. Pulled ${result.pulled}, created ${result.created}, updated ${result.updated}, renamed ${result.renamed}, deleted ${result.deleted}.`
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

	openSyncIgnoredFilesModal(): void {
		new SyncIgnoredFilesModal(this.app, this).open();
	}

	openVersionHistory(filePath: string, fileId: string): void {
		new VersionHistoryModal(this.app, this, filePath, fileId).open();
	}

	forceFullResync(): void {
		void (async () => {
			const firstConfirm = await ConfirmModal.ask(this.app, {
				title: 'Force full re-sync',
				message: 'This will clear local sync state, then compare all local and remote files. Continue?',
				confirmText: 'Continue',
				cancelText: 'Cancel',
				warning: true,
			});
				if (!firstConfirm) {
					return;
				}

				let preview;
				try {
					preview = await this.syncManager.previewFullResync();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (message !== 'Re-authentication required.') {
						new Notice(`Could not prepare full re-sync: ${message}`, 12000);
					}
					return;
				}
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
			progress.updateProgress(0, 'Clearing local sync state...');
			try {
				await this.syncManager.resetSyncStateArtifacts();
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

	cleanDuplicateArtifacts(): void {
		void (async () => {
			const confirmed = await ConfirmModal.ask(this.app, {
				title: 'Clean duplicate sync artifacts',
				message:
					'This will remove duplicate and generated artifact files (.remote, .sync-conflict) on local vault and Google Drive. Continue?',
				confirmText: 'Clean artifacts',
				cancelText: 'Cancel',
				warning: true,
			});
			if (!confirmed) {
				return;
			}

			let cancelled = false;
			const progress = new ProgressModal(this.app, {
				title: 'Cleaning duplicate artifacts',
				total: 5,
				onCancel: () => {
					cancelled = true;
				},
			});
			let currentStep = 0;
			progress.open();
			progress.updateProgress(0, 'Preparing cleanup...');
			try {
				const result = await this.syncManager.cleanDuplicateArtifacts({
					progress: (message) => {
						currentStep = Math.min(currentStep + 1, 5);
						progress.updateProgress(currentStep, message);
					},
					shouldCancel: () => cancelled,
				});
				progress.updateProgress(5, 'Finalizing');
				progress.finish();
				if (!result) {
					new Notice('Cleanup could not start because sync is busy.');
					return;
				}
				const total =
					result.localRemoved +
					result.localRenamed +
					result.localMerged +
					result.remoteTrashed +
					result.remoteRenamed +
					result.remoteMerged;
				if (total === 0) {
					new Notice('Cleanup complete. No duplicate artifacts found.');
					return;
				}
				new Notice(
					`Cleanup complete. Local removed ${result.localRemoved}, local renamed ${result.localRenamed}, local merged ${result.localMerged}, remote trashed ${result.remoteTrashed}, remote renamed ${result.remoteRenamed}, remote merged ${result.remoteMerged}.`
				);
			} catch (err) {
				progress.finish();
				if (cancelled) {
					new Notice('Cleanup cancelled.');
					return;
				}
				new Notice(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
			}
		})();
	}
}
