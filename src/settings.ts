import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import type GDriveSyncPlugin from './main';
import { ExcludedFoldersModal } from './ui/ExcludedFoldersModal';

function formatStorageBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0.0 GB';
	}

	const gibibytes = bytes / (1024 ** 3);
	if (gibibytes >= 1024) {
		return `${(gibibytes / 1024).toFixed(1)} TB`;
	}

	return `${gibibytes.toFixed(1)} GB`;
}

function formatPercent(numerator: number, denominator: number): { ratio: number; label: string } {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
		return { ratio: 0, label: '0.0' };
	}

	const ratio = Math.min(100, Math.max(0, (numerator / denominator) * 100));
	return { ratio, label: ratio.toFixed(1) };
}

function formatLocalDateTime(ts: number): string {
	return new Date(ts).toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

export interface GDrivePluginSettings {
	// Authentication (device-local, never synced to GDrive)
	oauthClientId: string;
	oauthClientSecret: string;
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
	maxFileSizeBytes: number;      // default: 20 MB
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
}

export const DEFAULT_SETTINGS: GDrivePluginSettings = {
	// Authentication
	oauthClientId: '',
	oauthClientSecret: '',
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
	maxFileSizeBytes: 20 * 1024 * 1024,
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
};

export class GDriveSettingTab extends PluginSettingTab {
	plugin: GDriveSyncPlugin;
	private refreshTokenValidationTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshTokenValidationSeq = 0;
	private lastValidatedRefreshToken = '';

	constructor(app: App, plugin: GDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Project credentials ───────────────────────────────────────
		new Setting(containerEl).setName('Project credentials').setHeading();

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('Google desktop client ID used for token requests.')
			.addText(text =>
				text
					.setPlaceholder('Paste client ID')
					.setValue(this.plugin.settings.oauthClientId)
					.onChange(async value => {
						this.plugin.settings.oauthClientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Client secret')
			.setDesc('Client secret used for token requests. Leave empty if your client works without it.')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Paste client secret')
					.setValue(this.plugin.settings.oauthClientSecret)
					.onChange(async value => {
						this.plugin.settings.oauthClientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		let refreshTokenDraft = this.plugin.settings.refreshToken;
		this.lastValidatedRefreshToken = this.plugin.settings.refreshToken;
		new Setting(containerEl)
			.setName('Refresh token')
			.setDesc(
				Platform.isMobile
					? 'Paste or update the refresh token for this device. It validates automatically.'
					: 'Paste a refresh token from another vault. It validates automatically.'
			)
			.addText(text => {
				text
					.setPlaceholder('Paste refresh token')
					.setValue(refreshTokenDraft)
					.onChange(value => {
						refreshTokenDraft = value;
						this.scheduleRefreshTokenValidation(refreshTokenDraft);
					});
			});

		if (this.plugin.settings.needsReauthentication) {
			if (Platform.isMobile) {
				new Setting(containerEl)
					.setName('Re-authentication required')
					.setDesc('Google account access expired. This token may have been replaced in another vault.');
			} else {
				new Setting(containerEl)
					.setName('Re-authentication required')
					.setDesc('Google account access expired. This token may have been replaced in another vault.')
					.addButton(btn =>
						btn
							.setButtonText('Re-authenticate')
							.setCta()
							.onClick(() => {
								this.plugin.openSetupWizard();
							})
					);
			}
		}

		// ── Account ──────────────────────────────────────────────────
		new Setting(containerEl).setName('Account').setHeading();

		const isConnected = !!this.plugin.settings.refreshToken;
		const vaultFolderPath = this.plugin.settings.setupComplete && this.plugin.settings.gDriveFolderName
			? `My Drive/Obsidian Vaults/${this.plugin.settings.gDriveFolderName}`
			: 'Not set up yet';

		if (isConnected) {
			const accountLabel = this.plugin.settings.connectedEmail || 'Connected (email unavailable)';

			const accountSetting = new Setting(containerEl)
				.setName('Google account')
				.setDesc(accountLabel);

			if (!Platform.isMobile) {
				accountSetting.addButton(btn =>
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
			}

			new Setting(containerEl)
				.setName('Vault folder path')
				.setDesc(vaultFolderPath)
				.addButton(btn =>
					btn
						.setButtonText(this.plugin.settings.setupComplete ? 'Change folder' : 'Choose folder')
						.setCta()
						.onClick(() => {
							this.plugin.openSetupWizard();
						})
				);
		} else {
			if (Platform.isMobile) {
				new Setting(containerEl)
					.setName('Google account')
					.setDesc('Not connected. Paste a refresh token from your desktop app to connect this device.');

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
		}

		this.renderUsageMetrics(containerEl, isConnected);

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

		// ── Conflict resolution ───────────────────────────────────────
		new Setting(containerEl).setName('Conflict resolution').setHeading();

		new Setting(containerEl)
			.setName('Markdown files')
			.setDesc('How to resolve conflicts in .md files when both local and remote have changed.');
		this.renderMarkdownConflictStrategyRadios(containerEl);

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
				t.setValue(this.plugin.settings.syncImages).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncImages = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync audio')
			.setDesc('Includes common audio formats such as mp3, wav, m4a, ogg, and flac.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncAudio).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncAudio = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync video')
			.setDesc('Includes common video formats such as mp4, mov, mkv, and webm.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncVideo).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncVideo = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync PDF files')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncPdfs).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncPdfs = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync other file types')
			.setDesc('Includes canvas files, drawing files, and other file types.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncOtherTypes).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncOtherTypes = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Max file size')
			.setDesc('Skip files larger than this size on this device.')
			.addSlider(slider =>
				slider
					.setLimits(1, 200, 1)
					.setValue(Math.round(this.plugin.settings.maxFileSizeBytes / (1024 * 1024)))
					.setDynamicTooltip()
					.onChange(value => {
						void this.updateSelectiveSyncSettings(() => {
							this.plugin.settings.maxFileSizeBytes = value * 1024 * 1024;
						});
					})
			);

		const excludedSummary = this.plugin.settings.excludedPaths.length === 0
			? 'No excluded folders configured.'
			: `${this.plugin.settings.excludedPaths.length} excluded folders configured.`;
		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc(excludedSummary)
			.addButton(button =>
				button.setButtonText('Manage').onClick(() => {
					new ExcludedFoldersModal(this.app, this.plugin.settings.excludedPaths, (paths) => {
						void this.updateSelectiveSyncSettings(() => {
							this.plugin.settings.excludedPaths = paths;
						}, true);
					}).open();
				})
			);

		new Setting(containerEl)
			.setName('View sync ignored files')
			.setDesc('Show ignored local and remote files with the reason for each file.')
			.addButton(button =>
				button.setButtonText('Open').onClick(() => {
					this.plugin.openSyncIgnoredFilesModal();
				})
			);

		// ── Vault config sync ─────────────────────────────────────────
		new Setting(containerEl).setName('Vault configuration sync').setHeading();

		new Setting(containerEl)
			.setName('Sync editor settings')
			.setDesc('Sync app.json with editor, file, and link settings.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncEditorSettings).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncEditorSettings = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync appearance')
			.setDesc('Sync appearance.json, themes, and CSS snippets.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncAppearance).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncAppearance = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync hotkeys')
			.setDesc('Sync hotkeys.json.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncHotkeys).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncHotkeys = v;
					});
				})
			);

		new Setting(containerEl)
			.setName('Sync community plugin list')
			.setDesc('Sync community-plugins.json only, not plugin binaries.')
			.addToggle(t =>
				t.setValue(this.plugin.settings.syncCommunityPluginList).onChange(v => {
					void this.updateSelectiveSyncSettings(() => {
						this.plugin.settings.syncCommunityPluginList = v;
					});
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

		if (this.plugin.syncManager.isUploadBlockedByStorageQuota()) {
			new Setting(containerEl)
				.setName('Uploads paused due to storage limit')
				.setDesc('Google Drive storage is full. Free space, then acknowledge to resume uploads.')
				.addButton(btn =>
					btn
						.setButtonText('Acknowledge and resume')
						.setWarning()
						.onClick(() => {
							void (async () => {
								const resumed = await this.plugin.syncManager.acknowledgeStorageQuotaPause();
								new Notice(resumed ? 'Uploads can resume.' : 'Uploads are already active.');
								this.display();
							})();
						})
				);
		}

		new Setting(containerEl)
			.setName('View activity log')
			.addButton(btn =>
				btn.setButtonText('Open').onClick(() => {
					void this.plugin.activateActivityLogView();
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
			.setDesc('Clear local sync state, then compare all local and remote files and sync any differences.')
			.addButton(btn =>
				btn.setButtonText('Force re-sync').onClick(() => {
					this.plugin.forceFullResync();
				})
			);

		new Setting(containerEl)
			.setName('Export debug info')
			.setDesc('Copy local diagnostic paths and status summary to clipboard.')
			.addButton(btn =>
				btn.setButtonText('Export').onClick(() => {
					void this.exportDebugInfo();
				})
			);
	}

	private renderMarkdownConflictStrategyRadios(containerEl: HTMLElement): void {
		const choices: Array<{
			value: GDrivePluginSettings['mdConflictStrategy'];
			label: string;
			description: string;
		}> = [
			{
				value: 'auto-merge',
				label: 'Auto-merge (recommended)',
				description: 'Try a three-way merge first and show conflict markers if overlap remains.',
			},
			{
				value: 'conflict-file',
				label: 'Create conflict file',
				description: 'Keep local and write the remote version to a .sync-conflict file.',
			},
			{
				value: 'local-wins',
				label: 'Local wins',
				description: 'Keep local content and overwrite the remote revision.',
			},
			{
				value: 'remote-wins',
				label: 'Remote wins',
				description: 'Replace local content with the remote revision.',
			},
		];

		const fieldset = containerEl.createEl('fieldset', { cls: 'gdrive-sync-radio-group' });
		fieldset.createEl('legend', { text: 'Markdown strategy' });

		for (const choice of choices) {
			const row = fieldset.createDiv({ cls: 'gdrive-sync-radio-row' });
			const input = row.createEl('input', { type: 'radio' });
			input.name = 'gdrive-sync-md-conflict-strategy';
			input.value = choice.value;
			input.checked = this.plugin.settings.mdConflictStrategy === choice.value;

			const textWrap = row.createDiv({ cls: 'gdrive-sync-radio-text' });
			textWrap.createEl('div', { text: choice.label });
			textWrap.createEl('div', { text: choice.description, cls: 'gdrive-sync-radio-desc' });

			input.addEventListener('change', () => {
				if (!input.checked) {
					return;
				}
				void (async () => {
					this.plugin.settings.mdConflictStrategy = choice.value;
					await this.plugin.saveSettings();
				})();
			});
		}
	}

	private renderUsageMetrics(containerEl: HTMLElement, isConnected: boolean): void {
		const storageSetting = new Setting(containerEl).setName('Storage usage');
		const apiSetting = new Setting(containerEl).setName('API usage');
		storageSetting.settingEl.addClass('gdrive-sync-usage-setting');
		apiSetting.settingEl.addClass('gdrive-sync-usage-setting');
		storageSetting.descEl.addClass('gdrive-sync-storage-usage');
		apiSetting.descEl.addClass('gdrive-sync-usage-metric');

		if (!isConnected) {
			storageSetting.setDesc('Unavailable until connected.');
			apiSetting.setDesc('Unavailable until connected.');
			return;
		}

		storageSetting.setDesc('Loading...');
		apiSetting.setDesc('Loading...');

		const snapshot = this.plugin.driveClient.getRateLimitSnapshot();
		const dailyBudget = snapshot.estimatedDailyQuota;
		const usagePercent = formatPercent(snapshot.requestsToday, dailyBudget);
		const projectedPercent = formatPercent(snapshot.projectedRequestsToday, dailyBudget);
		const resetAt = formatLocalDateTime(snapshot.resetAtUtcMs);

		apiSetting.setDesc(
			`${snapshot.requestsToday} requests today (${usagePercent.label}%), projected ${snapshot.projectedRequestsToday} (${projectedPercent.label}%) by ${resetAt}.`
		);
		const apiProgress = this.addUsageProgress(
			apiSetting,
			projectedPercent.ratio,
			'Projected API usage for today'
		);
		if (snapshot.shouldWarn) {
			apiSetting.descEl.addClass('gdrive-sync-error');
			apiProgress.addClass('is-warning');
		}

		void (async () => {
			try {
				const quota = await this.plugin.driveClient.getStorageQuota();
				const usedPercent = formatPercent(quota.used, quota.limit);
				if (quota.limit > 0) {
					storageSetting.setDesc(
						`${formatStorageBytes(quota.used)} of ${formatStorageBytes(quota.limit)} (${usedPercent.label}%).`
					);
					this.addUsageProgress(storageSetting, usedPercent.ratio, 'Storage usage');
				} else {
					storageSetting.setDesc(`${formatStorageBytes(quota.used)} used. No storage limit was reported.`);
				}
			} catch {
				storageSetting.setDesc('Unavailable.');
			}
		})();
	}

	private addUsageProgress(setting: Setting, percent: number, label: string): HTMLProgressElement {
		const progress = setting.descEl.createEl('progress', { cls: 'gdrive-sync-usage-progress' });
		progress.max = 100;
		progress.value = Math.max(0, Math.min(100, percent));
		progress.setAttribute('aria-label', label);
		return progress;
	}

	private scheduleRefreshTokenValidation(candidateToken: string): void {
		const normalized = candidateToken.trim();
		if (this.refreshTokenValidationTimer !== null) {
			clearTimeout(this.refreshTokenValidationTimer);
			this.refreshTokenValidationTimer = null;
		}

		if (!normalized || normalized.length < 20) {
			return;
		}

		const seq = ++this.refreshTokenValidationSeq;
		this.refreshTokenValidationTimer = setTimeout(() => {
			void (async () => {
				if (seq !== this.refreshTokenValidationSeq) {
					return;
				}
				if (
					normalized === this.lastValidatedRefreshToken &&
					!this.plugin.settings.needsReauthentication
				) {
					return;
				}

				try {
					await this.plugin.authManager.importRefreshToken(normalized);
					if (seq !== this.refreshTokenValidationSeq) {
						return;
					}

					this.lastValidatedRefreshToken = this.plugin.settings.refreshToken;
					const connectedEmail = this.plugin.settings.connectedEmail;
					new Notice(
						connectedEmail ? `Connected as ${connectedEmail}` : 'Refresh token saved and validated.'
					);
					this.display();
				} catch (err) {
					if (seq !== this.refreshTokenValidationSeq) {
						return;
					}
					new Notice(
						`Could not validate refresh token: ${err instanceof Error ? err.message : String(err)}`,
						12000
					);
				}
			})();
		}, 700);
	}

	private async updateSelectiveSyncSettings(update: () => void, refreshAfterSave = false): Promise<void> {
		const previous = this.plugin.syncManager.captureSelectiveSyncSnapshot();
		update();
		await this.plugin.saveSettings();
		const queued = await this.plugin.syncManager.handleSelectiveSyncSettingsChange(previous);
		if (queued > 0) {
			new Notice(`${queued} newly included files were queued for sync.`);
		}
		if (refreshAfterSave) {
			this.display();
		}
	}

	private async exportDebugInfo(): Promise<void> {
		const debugInfo = [
			`pluginId=${this.plugin.manifest.id}`,
			`syncDbPath=${this.plugin.syncManager.syncDb.getDatabasePath()}`,
			`activityLogPath=${this.plugin.syncManager.getActivityLogPath()}`,
			`pendingChanges=${this.plugin.syncManager.getPendingChangeCount()}`,
			`conflictAlerts=${this.plugin.syncManager.getConflictAlertCount()}`,
			`lastSyncPageToken=${this.plugin.settings.lastSyncPageToken ? '[set]' : '[empty]'}`,
			`setupComplete=${String(this.plugin.settings.setupComplete)}`,
		].join('\\n');

		try {
			await navigator.clipboard.writeText(debugInfo);
			new Notice('Debug info copied.');
		} catch {
			new Notice('Copy failed. You can run export from desktop or copy manually.');
		}
	}

}
