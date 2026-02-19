import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, GDrivePluginSettings, GDriveSettingTab } from './settings';
import { GoogleAuthManager } from './auth/GoogleAuthManager';
import { DriveClient } from './gdrive/DriveClient';
import { SetupWizard } from './ui/SetupWizard';
import { generateDeviceId } from './utils/deviceId';

export default class GDriveSyncPlugin extends Plugin {
	settings: GDrivePluginSettings;
	authManager: GoogleAuthManager;
	driveClient: DriveClient;

	async onload() {
		await this.loadSettings();

		// Assign a stable device ID on first run
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// Initialize core services
		this.authManager = new GoogleAuthManager(this);
		this.driveClient = new DriveClient(this.authManager);

		// Restore OAuth session from persisted refresh token (non-blocking)
		if (this.settings.refreshToken) {
			void this.authManager.restoreSession();
		}

		// Settings tab
		this.addSettingTab(new GDriveSettingTab(this.app, this));

		// Register URI handler for mobile OAuth callback: obsidian://gdrive-callback
		this.registerObsidianProtocolHandler('gdrive-callback', async (params) => {
			const searchParams = new URLSearchParams(
				Object.entries(params)
					.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
					.join('&')
			);
			try {
				await this.authManager.handleMobileCallback(searchParams);
				new Notice('Google account connected successfully.');
			} catch (err) {
				new Notice(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		// Commands
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => { void this.syncNow(); },
		});

		this.addCommand({
			id: 'authenticate',
			name: 'Connect to Google Drive',
			callback: () => { this.openSetupWizard(); },
		});

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			callback: async () => {
				this.settings.syncPaused = true;
				await this.saveSettings();
				new Notice('Google Drive sync paused.');
			},
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			callback: async () => {
				this.settings.syncPaused = false;
				await this.saveSettings();
				new Notice('Google Drive sync resumed.');
				void this.syncNow();
			},
		});

		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				// @ts-ignore — Obsidian's internal setting open API
				(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
				// @ts-ignore
				(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('gdrive-sync');
			},
		});

		// Show setup wizard if not yet configured
		if (!this.settings.setupComplete) {
			// Defer until workspace is ready
			this.app.workspace.onLayoutReady(() => {
				this.openSetupWizard();
			});
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

	// ── Public methods called by UI components ────────────────────────

	openSetupWizard(): void {
		new SetupWizard(this.app, this).open();
	}

	async syncNow(): Promise<void> {
		if (!this.settings.setupComplete) {
			new Notice('Complete Google Drive setup first.');
			this.openSetupWizard();
			return;
		}
		// SyncManager will be implemented in Phase 2
		new Notice('Sync triggered.');
	}

	async triggerInitialSync(): Promise<void> {
		// Full initial sync will be implemented in Phase 4 (Setup Wizard steps 3-5)
		new Notice('Setup complete.');
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
		new Notice('Force re-sync coming soon.');
	}

	resetSyncState(): void {
		new Notice('Reset sync state coming soon.');
	}
}
