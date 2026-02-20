import { Notice, Platform, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, GDrivePluginSettings, GDriveSettingTab } from './settings';
import { GoogleAuthManager } from './auth/GoogleAuthManager';
import { DriveClient } from './gdrive/DriveClient';
import { SetupWizard } from './ui/SetupWizard';
import { generateDeviceId } from './utils/deviceId';
import { SyncManager } from './sync/SyncManager';
import { SyncStatusBar } from './ui/SyncStatusBar';

export default class GDriveSyncPlugin extends Plugin {
	settings: GDrivePluginSettings;
	authManager!: GoogleAuthManager;
	driveClient!: DriveClient;
	syncManager!: SyncManager;
	statusBar!: SyncStatusBar;
	settingTab!: GDriveSettingTab;

	async onload() {
		await this.loadSettings();

		// Assign a stable device ID on first run
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// Initialize core services
		this.authManager = new GoogleAuthManager(this);

		// Register URI handler for mobile OAuth callback as early as possible
		// to avoid missing deep links during startup/resume.
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

		// Restore OAuth session from persisted refresh token (non-blocking)
		if (this.settings.refreshToken) {
			void this.authManager.restoreSession();
		}

		// Settings tab
		this.settingTab = new GDriveSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Commands
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => { void this.syncNow(); },
		});

		if (!Platform.isMobile) {
			this.addCommand({
				id: 'authenticate',
				name: 'Connect to Google Drive',
				callback: () => { this.openSetupWizard(); },
			});
		}

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			callback: () => {
				void (async () => {
					this.settings.syncPaused = true;
					await this.saveSettings();
					new Notice('Google Drive sync paused.');
				})();
			},
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			callback: () => {
				void (async () => {
					this.settings.syncPaused = false;
					await this.saveSettings();
					new Notice('Google Drive sync resumed.');
					void this.syncNow();
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

		// Show setup wizard if not yet configured
		if (!this.settings.setupComplete) {
			// Defer until workspace is ready
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
		this.authManager?.destroy();
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

	// ── Public methods called by UI components ────────────────────────

	openSetupWizard(): void {
		if (Platform.isMobile && !this.settings.refreshToken) {
			new Notice('Add a refresh token in plugin settings to connect on mobile.');
			this.openPluginSettings();
			return;
		}
		new SetupWizard(this.app, this).open();
	}

	openPluginSettings(): void {
		// @ts-ignore — Obsidian's internal setting open API
		(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
		// @ts-ignore
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

	async triggerInitialSync(): Promise<void> {
		await this.syncNow();
	}

	// Stubs for settings tab buttons — will be wired in later phases
	activateActivityLogView(): void {
		new Notice('Activity log coming soon.');
	}

	openDeletedFilesModal(): void {
		new Notice('Deleted files recovery coming soon.');
	}

	openLargestFilesModal(): void {
		new Notice('Largest files view coming soon.');
	}

	forceFullResync(): void {
		void this.syncNow();
	}

	resetSyncState(): void {
		void (async () => {
			this.syncManager.syncDb.reset();
			await this.syncManager.syncDb.save();
			new Notice('Sync state was reset. The next sync will rebuild state from local files.');
		})();
	}
}
