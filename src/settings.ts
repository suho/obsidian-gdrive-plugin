import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import type GDriveSyncPlugin from './main';

export interface GDrivePluginSettings {
	// Authentication (device-local, never synced to GDrive)
	refreshToken: string;
	tokenExpiry: number;           // Unix ms timestamp of access token expiry
	connectedEmail: string;
	needsReauthentication: boolean;

	// Sync target
	gDriveFolderId: string;
	gDriveFolderName: string;

	// Sync behavior (device-local)
	autoSync: boolean;
	pullIntervalSeconds: number;   // default: 30
	pushQuiescenceMs: number;      // default: 2000 — inactivity delay before pushing a modified file
	syncOnStartup: boolean;        // default: true
	wifiOnlySync: boolean;         // default: true on mobile, false on desktop
	maxFileSizeBytes: number;      // default: 20971520 (20 MB)
	keepRevisionsForever: boolean; // default: true — set keepRevisionForever on .md uploads

	// Selective sync (device-local — never propagated to other devices)
	syncImages: boolean;
	syncAudio: boolean;
	syncVideo: boolean;
	syncPdfs: boolean;
	syncOtherTypes: boolean;
	excludedPaths: string[];

	// Conflict resolution
	mdConflictStrategy: 'auto-merge' | 'conflict-file' | 'local-wins' | 'remote-wins';
	binaryConflictStrategy: 'last-modified-wins' | 'conflict-file';

	// Vault config sync
	syncEditorSettings: boolean;
	syncAppearance: boolean;
	syncHotkeys: boolean;
	syncCommunityPluginList: boolean;

	// Internal state
	setupComplete: boolean;        // false triggers the setup wizard on first load
	syncPaused: boolean;
	lastSyncPageToken: string;     // GDrive Changes API incremental token
	deviceId: string;              // UUID generated on first run, identifies this device
	pendingOAuthState: string;     // mobile OAuth callback CSRF state
	pendingCodeVerifier: string;   // mobile OAuth PKCE verifier
}

export const DEFAULT_SETTINGS: GDrivePluginSettings = {
	// Authentication
	refreshToken: '',
	tokenExpiry: 0,
	connectedEmail: '',
	needsReauthentication: false,

	// Sync target
	gDriveFolderId: '',
	gDriveFolderName: '',

	// Sync behavior
	autoSync: true,
	pullIntervalSeconds: 30,
	pushQuiescenceMs: 2000,
	syncOnStartup: true,
	wifiOnlySync: Platform.isMobile,
	maxFileSizeBytes: 20 * 1024 * 1024, // 20 MB
	keepRevisionsForever: true,

	// Selective sync
	syncImages: true,
	syncAudio: true,
	syncVideo: false,
	syncPdfs: true,
	syncOtherTypes: true,
	excludedPaths: [],

	// Conflict resolution
	mdConflictStrategy: 'auto-merge',
	binaryConflictStrategy: 'last-modified-wins',

	// Vault config sync
	syncEditorSettings: true,
	syncAppearance: true,
	syncHotkeys: false,
	syncCommunityPluginList: false,

	// Internal
	setupComplete: false,
	syncPaused: false,
	lastSyncPageToken: '',
	deviceId: '',
	pendingOAuthState: '',
	pendingCodeVerifier: '',
};

export class GDriveSettingTab extends PluginSettingTab {
	plugin: GDriveSyncPlugin;

	constructor(app: App, plugin: GDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Account ──────────────────────────────────────────────────
		new Setting(containerEl).setName('Account').setHeading();
		if (this.plugin.settings.needsReauthentication) {
			new Setting(containerEl)
				.setName('Re-authentication required')
				.setDesc('Google account access expired. Select re-authenticate to resume sync.')
				.addButton(btn =>
					btn
						.setButtonText('Re-authenticate')
						.setCta()
						.onClick(() => {
							this.plugin.openSetupWizard();
						})
				);
		}

		const isConnected = !!this.plugin.settings.refreshToken;
		if (isConnected) {
			const accountLabel = this.plugin.settings.connectedEmail || 'Connected (email unavailable)';
			const vaultFolderPath = this.plugin.settings.setupComplete && this.plugin.settings.gDriveFolderName
				? `My Drive/Obsidian Vaults/${this.plugin.settings.gDriveFolderName}`
				: 'Not set up yet';

			new Setting(containerEl)
				.setName('Google account')
				.setDesc(accountLabel)
				.addButton(btn =>
					btn
						.setButtonText('Sign out')
						.setWarning()
						.onClick(() => {
							void (async () => {
								await this.plugin.authManager.signOut();
								this.display();
							})();
						})
				);

			new Setting(containerEl)
				.setName('Vault folder path')
				.setDesc(vaultFolderPath);
		} else {
			new Setting(containerEl)
				.setName('Google account')
				.setDesc('Not connected')
				.addButton(btn =>
					btn
						.setButtonText('Connect to Google Drive')
						.setCta()
						.onClick(() => {
							this.plugin.openSetupWizard();
						})
				);
		}

		// ── Sync behavior ─────────────────────────────────────────────
		new Setting(containerEl).setName('Sync behavior').setHeading();

		new Setting(containerEl)
			.setName('Auto-sync')
			.setDesc('Automatically sync changes as you work.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async val => {
					this.plugin.settings.autoSync = val;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Pull interval')
			.setDesc('How often to check Google Drive for remote changes (seconds).')
			.addSlider(slider =>
				slider
					.setLimits(10, 300, 10)
					.setValue(this.plugin.settings.pullIntervalSeconds)
					.setDynamicTooltip()
					.onChange(async val => {
						this.plugin.settings.pullIntervalSeconds = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Edit quiescence delay')
			.setDesc('How long to wait after the last edit before uploading a file (milliseconds).')
			.addSlider(slider =>
				slider
					.setLimits(500, 10000, 500)
					.setValue(this.plugin.settings.pushQuiescenceMs)
					.setDynamicTooltip()
					.onChange(async val => {
						this.plugin.settings.pushQuiescenceMs = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Pull remote changes when Obsidian opens.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async val => {
					this.plugin.settings.syncOnStartup = val;
					await this.plugin.saveSettings();
				})
			);

		if (Platform.isMobile) {
			new Setting(containerEl)
				.setName('Wireless sync only')
				.setDesc('Only sync when connected to a wireless network.')
				.addToggle(toggle =>
					toggle.setValue(this.plugin.settings.wifiOnlySync).onChange(async val => {
						this.plugin.settings.wifiOnlySync = val;
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName('Max file size')
			.setDesc(`Skip files larger than ${Math.round(this.plugin.settings.maxFileSizeBytes / (1024 * 1024))} MB.`)
			.addDropdown(drop => {
					drop.addOption(String(5 * 1024 * 1024), '5 megabytes');
					drop.addOption(String(20 * 1024 * 1024), '20 megabytes');
					drop.addOption(String(50 * 1024 * 1024), '50 megabytes');
					drop.addOption(String(100 * 1024 * 1024), '100 megabytes');
					drop.addOption(String(200 * 1024 * 1024), '200 megabytes');
				drop
					.setValue(String(this.plugin.settings.maxFileSizeBytes))
					.onChange(async val => {
						this.plugin.settings.maxFileSizeBytes = Number(val);
						await this.plugin.saveSettings();
					});
			});

		// ── Conflict resolution ───────────────────────────────────────
		new Setting(containerEl).setName('Conflict resolution').setHeading();

		new Setting(containerEl)
			.setName('Markdown files')
			.setDesc('How to resolve conflicts in .md files when both local and remote have changed.')
			.addDropdown(drop =>
				drop
					.addOption('auto-merge', 'Auto-merge (recommended)')
					.addOption('conflict-file', 'Create conflict file')
					.addOption('local-wins', 'Local wins')
					.addOption('remote-wins', 'Remote wins')
					.setValue(this.plugin.settings.mdConflictStrategy)
					.onChange(async val => {
						this.plugin.settings.mdConflictStrategy = val as GDrivePluginSettings['mdConflictStrategy'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Binary files')
			.setDesc('How to resolve conflicts in images, PDF files, and other binary files.')
			.addDropdown(drop =>
				drop
					.addOption('last-modified-wins', 'Last modified wins')
					.addOption('conflict-file', 'Create conflict file')
					.setValue(this.plugin.settings.binaryConflictStrategy)
					.onChange(async val => {
						this.plugin.settings.binaryConflictStrategy = val as GDrivePluginSettings['binaryConflictStrategy'];
						await this.plugin.saveSettings();
					})
			);

		// ── Selective sync ────────────────────────────────────────────
		new Setting(containerEl).setName('Selective sync').setHeading();
		new Setting(containerEl)
			.setDesc('These settings apply to this device only.')
			.setClass('gdrive-sync-notice');

		new Setting(containerEl)
			.setName('Sync images')
				.setDesc('Includes common image file formats.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncImages).onChange(async v => {
					this.plugin.settings.syncImages = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync audio')
			.setDesc('.mp3, .wav, .m4a, .ogg, .flac')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncAudio).onChange(async v => {
					this.plugin.settings.syncAudio = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync video')
			.setDesc('.mp4, .mov, .mkv, .webm')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncVideo).onChange(async v => {
					this.plugin.settings.syncVideo = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync PDF files')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncPdfs).onChange(async v => {
					this.plugin.settings.syncPdfs = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync other file types')
				.setDesc('Includes canvas and drawing files, plus other file types.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncOtherTypes).onChange(async v => {
					this.plugin.settings.syncOtherTypes = v;
					await this.plugin.saveSettings();
				})
			);

		// ── Vault config sync ─────────────────────────────────────────
		new Setting(containerEl).setName('Vault configuration sync').setHeading();

		new Setting(containerEl)
			.setName('Sync editor settings')
			.setDesc('Sync app.json (editor preferences, file & link settings).')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncEditorSettings).onChange(async v => {
					this.plugin.settings.syncEditorSettings = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync appearance')
			.setDesc('Sync appearance.json, themes, and CSS snippets.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncAppearance).onChange(async v => {
					this.plugin.settings.syncAppearance = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync hotkeys')
			.setDesc('Sync hotkeys.json.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncHotkeys).onChange(async v => {
					this.plugin.settings.syncHotkeys = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync community plugin list')
			.setDesc('Sync community-plugins.json (enabled plugin list only, not plugin binaries).')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncCommunityPluginList).onChange(async v => {
					this.plugin.settings.syncCommunityPluginList = v;
					await this.plugin.saveSettings();
				})
			);

		// ── Version history ───────────────────────────────────────────
		new Setting(containerEl).setName('Version history').setHeading();

		new Setting(containerEl)
			.setName('Keep revisions forever')
			.setDesc(
				'Prevent Google Drive from auto-deleting older file versions. ' +
				'Uses additional storage quota. ' +
				'Without this, Google Drive keeps revisions for 30 days or up to 100 versions.'
			)
			.addToggle(t =>
				t.setValue(this.plugin.settings.keepRevisionsForever).onChange(async v => {
					this.plugin.settings.keepRevisionsForever = v;
					await this.plugin.saveSettings();
				})
			);

		// ── Advanced ──────────────────────────────────────────────────
		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('View activity log')
			.addButton(btn =>
				btn.setButtonText('Open').onClick(() => {
					this.plugin.activateActivityLogView();
				})
			);

		new Setting(containerEl)
			.setName('View deleted files')
			.addButton(btn =>
				btn.setButtonText('Open').onClick(() => {
					this.plugin.openDeletedFilesModal();
				})
			);

		new Setting(containerEl)
			.setName('View largest synced files')
			.addButton(btn =>
				btn.setButtonText('Open').onClick(() => {
					this.plugin.openLargestFilesModal();
				})
			);

		new Setting(containerEl)
			.setName('Force full re-sync')
			.setDesc('Compare all local and remote files and sync any differences.')
			.addButton(btn =>
				btn.setButtonText('Force re-sync').onClick(() => {
					this.plugin.forceFullResync();
				})
			);

		new Setting(containerEl)
			.setName('Reset sync state')
			.setDesc(
				'Clears the local sync database. All files will be re-compared on next sync. ' +
				'Use this to recover from a corrupted sync state.'
			)
			.addButton(btn =>
				btn
					.setButtonText('Reset')
					.setWarning()
					.onClick(() => {
						this.plugin.resetSyncState();
					})
			);
	}
}
