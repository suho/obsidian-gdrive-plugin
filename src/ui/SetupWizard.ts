import { App, Modal, Notice, Platform, Setting, normalizePath, setIcon } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveFileWithPath } from '../gdrive/DriveClient';
import type { DriveFileMetadata } from '../types';
import { computeContentHash } from '../utils/checksums';
import { isExcluded } from '../sync/exclusions';
import { canonicalPathForGeneratedVariant } from '../sync/generatedArtifacts';
import { ProgressModal } from './ProgressModal';

type WizardStep = 'authenticate' | 'folder' | 'initial-state' | 'conflict-review' | 'confirm' | 'done';
type InitialConflictAction = 'keep-local' | 'keep-remote' | 'merge-markers';

interface LocalScanFile {
	path: string;
	size: number;
	modified: number;
	hash: string;
}

interface RemoteScanFile {
	path: string;
	fileId: string;
	mimeType: string;
	size: number;
	modified: number;
	hash: string;
}

interface InitialConflictItem {
	path: string;
	local: LocalScanFile;
	remote: RemoteScanFile;
	action: InitialConflictAction;
}

interface InitialSyncPlan {
	localCount: number;
	remoteCount: number;
	uploads: LocalScanFile[];
	downloads: RemoteScanFile[];
	conflicts: InitialConflictItem[];
}

const MIME_BY_EXTENSION: Record<string, string> = {
	md: 'text/markdown; charset=utf-8',
	canvas: 'application/json; charset=utf-8',
	json: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	webm: 'video/webm',
};

function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(ts: number): string {
	if (!ts) {
		return 'Unknown';
	}
	return new Date(ts).toLocaleString();
}

function parseRemoteModifiedTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function defaultConflictAction(): InitialConflictAction {
	return 'merge-markers';
}

/**
 * Multi-step first-run setup wizard.
 *
 * Step 1: Connect account.
 * Step 2: Select vault folder in Google Drive.
 * Step 3: Detect initial sync state.
 * Step 4: Review each conflict manually.
 * Step 5: Confirm and run first sync.
 */
export class SetupWizard extends Modal {
	private step: WizardStep = 'authenticate';
	private newFolderName: string;
	private folderMode: 'create' | 'existing' = 'create';
	private rootFolderId: string | null = null;
	private existingFolders: DriveFileMetadata[] = [];
	private existingFoldersLoaded = false;
	private existingFoldersLoading = false;
	private existingFoldersError = '';
	private selectedExistingFolderId = '';

	private selectedFolderId = '';
	private selectedFolderName = '';

	private initialPlan: InitialSyncPlan | null = null;
	private planningInProgress = false;
	private planningError = '';
	private initialSyncInProgress = false;
	private initialSyncProgress = '';
	private oauthClientIdInput = '';
	private oauthClientSecretInput = '';

	constructor(
		app: App,
		private readonly plugin: GDriveSyncPlugin
	) {
		super(app);
		this.newFolderName = this.app.vault.getName();
	}

	onOpen(): void {
		this.step = this.plugin.authManager.isAuthenticated ? 'folder' : 'authenticate';
		this.oauthClientIdInput = this.plugin.settings.oauthClientId;
		this.oauthClientSecretInput = this.plugin.settings.oauthClientSecret;
		this.titleEl.setText('Set up sync with Google Drive');
		this.renderStep();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderStep(): void {
		this.contentEl.empty();

		switch (this.step) {
			case 'authenticate':
				this.renderAuthStep();
				return;
			case 'folder':
				this.renderFolderStep();
				return;
			case 'initial-state':
				this.renderInitialStateStep();
				return;
			case 'conflict-review':
				this.renderConflictReviewStep();
				return;
			case 'confirm':
				this.renderConfirmStep();
				return;
			case 'done':
				this.renderDoneStep();
				return;
		}
	}

	private renderAuthStep(): void {
		this.titleEl.setText(Platform.isMobile ? 'Connect account' : 'Connect to Google Drive');

		const desc = this.contentEl.createEl('p');
		if (Platform.isMobile) {
			desc.setText(
				'On mobile, connect by importing a refresh token from your desktop app. ' +
				'After importing, return here to continue folder setup.'
			);
		} else {
			desc.setText(
				'This plugin will upload your vault files to Google Drive. ' +
				'Only files created by this plugin are visible because this plugin uses drive.file scope.'
			);

			const note = this.contentEl.createEl('p');
			note.addClass('gdrive-sync-notice');
			note.setText('Your browser will open for sign-in. Return to Obsidian after approval.');
		}

		if (this.plugin.authManager.isAuthenticated) {
			const connectedEmail = this.plugin.settings.connectedEmail;
			const connected = this.contentEl.createEl('p');
			connected.addClass('gdrive-sync-connected');
			connected.setText(connectedEmail ? `Connected as ${connectedEmail}` : 'Google account connected.');

			const accountActions = new Setting(this.contentEl)
				.addButton(btn =>
					btn
						.setButtonText('Continue')
						.setCta()
						.onClick(() => {
							this.step = 'folder';
							this.renderStep();
						})
				);

			if (!Platform.isMobile) {
				accountActions.addButton(btn =>
					btn.setButtonText('Use a different account').onClick(() => {
						void (async () => {
							await this.plugin.authManager.signOut();
							this.plugin.refreshSettingTab();
							this.renderStep();
						})();
					})
				);
			}
			return;
		}

		if (Platform.isMobile) {
			new Setting(this.contentEl)
				.setName('Connect on mobile')
				.setDesc('Open plugin settings and paste a refresh token in add refresh token.')
				.addButton(btn =>
					btn
						.setButtonText('Open settings')
						.setCta()
						.onClick(() => {
							this.plugin.openPluginSettings();
							this.close();
						})
				);
			return;
		}

		this.renderDesktopCredentialGuide();

		new Setting(this.contentEl)
			.setName('Client ID')
			.setDesc('Paste your desktop client ID.')
			.addText(text =>
				text
					.setPlaceholder('Paste client ID')
					.setValue(this.oauthClientIdInput)
					.onChange(value => {
						this.oauthClientIdInput = value.trim();
					})
			);

		new Setting(this.contentEl)
			.setName('Client secret')
			.setDesc('Paste client secret. Some projects require it for token exchange.')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Paste client secret')
					.setValue(this.oauthClientSecretInput)
					.onChange(value => {
						this.oauthClientSecretInput = value.trim();
					});
			});

		const connectBtn = this.contentEl.createEl('button');
		connectBtn.addClass('mod-cta');
		connectBtn.setText('Connect to Google Drive');
		connectBtn.addEventListener('click', () => {
			void (async () => {
				const clientId = this.oauthClientIdInput.trim();
				const clientSecret = this.oauthClientSecretInput.trim();
				if (!clientId) {
					const errorEl = this.contentEl.querySelector('.gdrive-sync-error') ?? this.contentEl.createEl('p');
					errorEl.addClass('gdrive-sync-error');
					errorEl.setText('Add client ID first.');
					return;
				}

				connectBtn.setAttr('disabled', 'true');
				connectBtn.setText('Waiting for browser...');

				try {
					await this.plugin.authManager.saveOAuthClientCredentials(clientId, clientSecret);
					await this.plugin.authManager.authenticate();
					this.plugin.refreshSettingTab();
					const connectedEmail = this.plugin.settings.connectedEmail;
					new Notice(connectedEmail ? `Connected as ${connectedEmail}` : 'Google account connected.');
					this.step = 'folder';
					this.renderStep();
				} catch (err) {
					connectBtn.removeAttribute('disabled');
					connectBtn.setText('Connect to Google Drive');
					const errorEl = this.contentEl.querySelector('.gdrive-sync-error') ?? this.contentEl.createEl('p');
					errorEl.addClass('gdrive-sync-error');
					errorEl.setText(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		});
	}

	private renderDesktopCredentialGuide(): void {
		const guide = this.contentEl.createEl('div');
		guide.addClass('gdrive-sync-notice');
		guide.createEl('p').setText('Before connecting, create credentials in cloud console.');

		const steps = guide.createEl('ol');
		this.addGuideStep(steps, 'Create a project', 'https://console.cloud.google.com/projectcreate');
		this.addGuideStep(steps, 'Open credentials page', 'https://console.cloud.google.com/apis/credentials');
		this.addGuideStep(steps, 'Enable Google Drive API', 'https://console.cloud.google.com/apis/api/drive.googleapis.com');
		this.addGuideStep(steps, 'Set up consent screen', 'https://console.cloud.google.com/auth/branding');
		this.addGuideStep(steps, 'Add test users if app is in testing', 'https://console.cloud.google.com/auth/audience');
		this.addGuideStep(steps, 'Create client and choose desktop app', 'https://console.cloud.google.com/auth/clients');

		guide.createEl('p').setText('Copy client ID and client secret, then paste them below.');
	}

	private addGuideStep(listEl: HTMLOListElement, label: string, href: string): void {
		const item = listEl.createEl('li');
		const link = item.createEl('a', { text: label, href });
		link.setAttr('target', '_blank');
		link.setAttr('rel', 'noopener noreferrer');
	}

	private renderFolderStep(): void {
		this.titleEl.setText('Choose a Google Drive folder');

		this.contentEl.createEl('p').setText(
			'Choose where your vault should live on Google Drive. ' +
			'You can create a folder or select one that already exists.'
		);

		new Setting(this.contentEl)
			.setName('Folder source')
			.setDesc('Choose whether to create a folder or use an existing folder.')
			.addDropdown(dropdown =>
				dropdown
					.addOption('create', 'Create a new folder')
					.addOption('existing', 'Use an existing folder')
					.setValue(this.folderMode)
					.onChange(value => {
						this.folderMode = value as 'create' | 'existing';
						if (this.folderMode === 'existing' && !this.existingFoldersLoaded && !this.existingFoldersLoading) {
							void this.reloadExistingFolders();
						}
						this.renderStep();
					})
			);

		if (this.folderMode === 'create') {
			new Setting(this.contentEl)
				.setName('Folder name')
				.setDesc('Your vault will be stored in a dedicated folder.')
				.addText(text =>
					text
						.setValue(this.newFolderName)
						.setPlaceholder(this.app.vault.getName())
						.onChange(val => {
							this.newFolderName = val.trim() || this.app.vault.getName();
						})
				);
		} else {
			if (!this.existingFoldersLoaded && !this.existingFoldersLoading && !this.existingFoldersError) {
				void this.reloadExistingFolders();
			}

			new Setting(this.contentEl)
				.setName('Existing folder')
				.setDesc('Select a folder under Obsidian vaults.')
				.addDropdown(dropdown => {
					if (this.existingFolders.length === 0) {
						dropdown.addOption('', this.existingFoldersLoading ? 'Loading folders...' : 'No folders found');
						dropdown.setValue('');
						dropdown.setDisabled(true);
						return;
					}

					for (const folder of this.existingFolders) {
						dropdown.addOption(folder.id, folder.name);
					}

					if (!this.selectedExistingFolderId) {
						this.selectedExistingFolderId = this.existingFolders[0]?.id ?? '';
					}
					dropdown.setValue(this.selectedExistingFolderId);
					dropdown.onChange(value => {
						this.selectedExistingFolderId = value;
					});
					dropdown.setDisabled(this.existingFoldersLoading);
				});

			new Setting(this.contentEl)
				.setDesc('Reload folders from Google Drive.')
				.addButton(btn =>
					btn.setButtonText('Refresh folder list').onClick(() => {
						this.existingFoldersLoaded = false;
						void this.reloadExistingFolders();
					})
				);

			if (this.existingFoldersError) {
				const errorEl = this.contentEl.createEl('p');
				errorEl.addClass('gdrive-sync-error');
				errorEl.setText(this.existingFoldersError);
			}
		}

		const buttonRow = this.contentEl.createEl('div');
		buttonRow.addClass('gdrive-sync-button-row');

		const backBtn = buttonRow.createEl('button');
		backBtn.setText('Back');
		backBtn.addEventListener('click', () => {
			this.step = 'authenticate';
			this.renderStep();
		});

		const continueBtn = buttonRow.createEl('button');
		continueBtn.addClass('mod-cta');
		continueBtn.setText(this.folderMode === 'create' ? 'Continue' : 'Use selected folder');
		continueBtn.addEventListener('click', () => {
			void (async () => {
				continueBtn.setAttr('disabled', 'true');
				continueBtn.setText(this.folderMode === 'create' ? 'Preparing folder...' : 'Preparing selection...');

				try {
					if (this.folderMode === 'create') {
						await this.createVaultFolder();
					} else {
						await this.useExistingVaultFolder();
					}

					this.initialPlan = null;
					this.planningError = '';
					this.step = 'initial-state';
					this.renderStep();
					void this.prepareInitialSyncPlan();
				} catch (err) {
					continueBtn.removeAttribute('disabled');
					continueBtn.setText(this.folderMode === 'create' ? 'Continue' : 'Use selected folder');
					const errorEl = this.contentEl.querySelector('.gdrive-sync-error') ?? this.contentEl.createEl('p');
					errorEl.addClass('gdrive-sync-error');
					errorEl.setText(`Failed to configure folder: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		});
	}

	private renderInitialStateStep(): void {
		this.titleEl.setText('Initial sync review');

		if (this.planningInProgress) {
			const loading = this.contentEl.createDiv({ cls: 'gdrive-sync-loading' });
			const loadingIcon = loading.createSpan({ cls: 'gdrive-sync-loading-icon gdrive-sync-spin' });
			setIcon(loadingIcon, 'refresh-cw');
			loading.createSpan({ text: 'Scanning local and remote files. This may take a moment.' });
			return;
		}

		if (this.planningError) {
			const errorEl = this.contentEl.createEl('p');
			errorEl.addClass('gdrive-sync-error');
			errorEl.setText(this.planningError);

			const retryBtn = this.contentEl.createEl('button');
			retryBtn.addClass('mod-cta');
			retryBtn.setText('Retry scan');
			retryBtn.addEventListener('click', () => {
				void this.prepareInitialSyncPlan();
			});
			return;
		}

		if (!this.initialPlan) {
			this.contentEl.createEl('p').setText('Preparing initial sync plan...');
			void this.prepareInitialSyncPlan();
			return;
		}

		const { localCount, remoteCount, uploads, downloads, conflicts } = this.initialPlan;
		if (remoteCount === 0) {
			this.contentEl.createEl('p').setText('Google Drive folder is empty. This vault will be uploaded.');
		} else {
			this.contentEl.createEl('p').setText(
				`${remoteCount} remote files were found. Review the plan before first sync.`
			);
		}

		const summary = this.contentEl.createEl('ul');
		summary.createEl('li', { text: `${localCount} local files scanned` });
		summary.createEl('li', { text: `${remoteCount} remote files scanned` });
		summary.createEl('li', { text: `${uploads.length} files to upload` });
		summary.createEl('li', { text: `${downloads.length} files to download` });
		summary.createEl('li', { text: `${conflicts.length} conflicts requiring review` });

		const buttonRow = this.contentEl.createEl('div', { cls: 'gdrive-sync-button-row' });
		const backBtn = buttonRow.createEl('button');
		backBtn.setText('Back');
		backBtn.addEventListener('click', () => {
			this.step = 'folder';
			this.renderStep();
		});

		const nextBtn = buttonRow.createEl('button');
		nextBtn.addClass('mod-cta');
		nextBtn.setText(conflicts.length > 0 ? 'Review conflicts' : 'Continue');
		nextBtn.addEventListener('click', () => {
			this.step = conflicts.length > 0 ? 'conflict-review' : 'confirm';
			this.renderStep();
		});
	}

	private renderConflictReviewStep(): void {
		this.titleEl.setText('Conflict review');
		const plan = this.initialPlan;
		if (!plan) {
			this.step = 'initial-state';
			this.renderStep();
			return;
		}

		if (plan.conflicts.length === 0) {
			this.contentEl.createEl('p').setText('No conflicts were detected.');
		} else {
			this.contentEl.createEl('p').setText(
				'Review each file. First sync never auto-resolves conflicts; your choices below will be used.'
			);

			const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-conflict-table' });
			const thead = table.createTHead();
			const headerRow = thead.insertRow();
			headerRow.insertCell().setText('Path');
			headerRow.insertCell().setText('Local');
			headerRow.insertCell().setText('Remote');
			headerRow.insertCell().setText('Action');

			const tbody = table.createTBody();
			for (const conflict of plan.conflicts) {
				const row = tbody.insertRow();
				row.insertCell().setText(conflict.path);
				row.insertCell().setText(`${formatBytes(conflict.local.size)} • ${formatTime(conflict.local.modified)}`);
				row.insertCell().setText(`${formatBytes(conflict.remote.size)} • ${formatTime(conflict.remote.modified)}`);
				const actionCell = row.insertCell();

				const select = actionCell.createEl('select');
				select.createEl('option', { value: 'keep-local', text: 'Keep local' });
				select.createEl('option', { value: 'keep-remote', text: 'Keep remote' });
				select.createEl('option', { value: 'merge-markers', text: 'Merge with conflict markers' });
				select.value = conflict.action;
				select.addEventListener('change', () => {
					conflict.action = select.value as InitialConflictAction;
				});
			}
		}

		const buttonRow = this.contentEl.createEl('div', { cls: 'gdrive-sync-button-row' });
		const backBtn = buttonRow.createEl('button');
		backBtn.setText('Back');
		backBtn.addEventListener('click', () => {
			this.step = 'initial-state';
			this.renderStep();
		});

		const nextBtn = buttonRow.createEl('button');
		nextBtn.addClass('mod-cta');
		nextBtn.setText('Continue');
		nextBtn.addEventListener('click', () => {
			this.step = 'confirm';
			this.renderStep();
		});
	}

	private renderConfirmStep(): void {
		this.titleEl.setText('Confirm initial sync');
		const plan = this.initialPlan;
		if (!plan) {
			this.step = 'initial-state';
			this.renderStep();
			return;
		}

		const keepLocalCount = plan.conflicts.filter(conflict => conflict.action === 'keep-local').length;
		const keepRemoteCount = plan.conflicts.filter(conflict => conflict.action === 'keep-remote').length;
		const mergeCount = plan.conflicts.filter(conflict => conflict.action === 'merge-markers').length;
		const uploadCount = plan.uploads.length + keepLocalCount + mergeCount;
		const downloadCount = plan.downloads.length + keepRemoteCount + mergeCount;

		this.contentEl.createEl('p').setText(
			`${uploadCount} files will be uploaded, ${downloadCount} files will be downloaded, and ${plan.conflicts.length} conflicts will be resolved.`
		);

		if (mergeCount > 0) {
			this.contentEl.createEl('p').setText(
				`${mergeCount} files will include Git-style conflict markers so you can resolve them in place.`
			);
		}

		if (this.initialSyncInProgress) {
			const progress = this.contentEl.createEl('p');
			progress.addClass('gdrive-sync-notice');
			progress.setText(this.initialSyncProgress || 'Running initial sync...');
		}

		const buttonRow = this.contentEl.createEl('div', { cls: 'gdrive-sync-button-row' });
		const backBtn = buttonRow.createEl('button');
		backBtn.setText('Back');
		backBtn.toggleClass('is-disabled', this.initialSyncInProgress);
		backBtn.addEventListener('click', () => {
			if (this.initialSyncInProgress) {
				return;
			}
			this.step = plan.conflicts.length > 0 ? 'conflict-review' : 'initial-state';
			this.renderStep();
		});

		const confirmBtn = buttonRow.createEl('button');
		confirmBtn.addClass('mod-cta');
		confirmBtn.setText(this.initialSyncInProgress ? 'Syncing...' : 'Confirm and run initial sync');
		if (this.initialSyncInProgress) {
			confirmBtn.setAttr('disabled', 'true');
		}
		confirmBtn.addEventListener('click', () => {
			if (this.initialSyncInProgress) {
				return;
			}
			void this.executeInitialSyncPlan();
		});
	}

	private renderDoneStep(): void {
		this.titleEl.setText('Setup complete');
		this.contentEl.createEl('p').setText(
			`Initial sync is complete. Your vault is now connected to "${this.selectedFolderName || this.newFolderName}" on Google Drive.`
		);
		this.contentEl.createEl('p').setText(
			'Sync runs while Obsidian is in the foreground. On mobile, sync pauses in the background and resumes when you return.'
		);

		const doneBtn = this.contentEl.createEl('button');
		doneBtn.addClass('mod-cta');
		doneBtn.setText('Start syncing');
		doneBtn.addEventListener('click', () => {
			this.close();
			void this.plugin.triggerInitialSync();
		});
	}

	private async createVaultFolder(): Promise<void> {
		const client = this.plugin.driveClient;
		const folderName = this.newFolderName || this.app.vault.getName();
		const rootFolderId = await this.ensureRootFolderId();

		let vaultFolderId = await client.findFolder(folderName, rootFolderId);
		if (!vaultFolderId) {
			vaultFolderId = await client.createFolder(folderName, rootFolderId);
		}

		await this.persistSelectedFolder(vaultFolderId, folderName);
	}

	private async useExistingVaultFolder(): Promise<void> {
		const selected = this.existingFolders.find(folder => folder.id === this.selectedExistingFolderId);
		if (!selected) {
			throw new Error('Select an existing folder first');
		}
		await this.persistSelectedFolder(selected.id, selected.name);
	}

	private async persistSelectedFolder(folderId: string, folderName: string): Promise<void> {
		this.selectedFolderId = folderId;
		this.selectedFolderName = folderName;
		this.newFolderName = folderName;

		this.plugin.settings.gDriveFolderId = folderId;
		this.plugin.settings.gDriveFolderName = folderName;
		this.plugin.settings.setupComplete = false;
		this.plugin.settings.lastSyncPageToken = '';
		await this.resetSyncDatabase();
		await this.plugin.saveSettings();
		this.plugin.refreshSettingTab();
	}

	private async prepareInitialSyncPlan(): Promise<void> {
		if (this.planningInProgress) {
			return;
		}
		if (!this.selectedFolderId && !this.plugin.settings.gDriveFolderId) {
			this.planningError = 'No target folder selected.';
			this.renderStep();
			return;
		}

		this.planningInProgress = true;
		this.planningError = '';
		this.initialPlan = null;
		this.renderStep();

		try {
			const localFiles = await this.scanLocalFiles();
			const localPaths = new Set<string>(localFiles.keys());
			const remoteWithPaths = await this.plugin.driveClient.listAllFilesRecursiveWithPaths(
				this.selectedFolderId || this.plugin.settings.gDriveFolderId
			);
			const remotePaths = new Set<string>();
			for (const item of remoteWithPaths) {
				const normalizedPath = normalizePath(item.path);
				remotePaths.add(normalizedPath);
			}

			const remoteFiles = await this.scanRemoteFiles(remoteWithPaths, remotePaths, localPaths);
			const uploads: LocalScanFile[] = [];
			const downloads: RemoteScanFile[] = [];
			const conflicts: InitialConflictItem[] = [];

			for (const [path, localFile] of localFiles.entries()) {
				const remoteFile = remoteFiles.get(path);
				if (!remoteFile) {
					uploads.push(localFile);
					continue;
				}
				if (remoteFile.hash && remoteFile.hash === localFile.hash) {
					continue;
				}

				conflicts.push({
					path,
					local: localFile,
					remote: remoteFile,
					action: defaultConflictAction(),
				});
			}

			for (const [path, remoteFile] of remoteFiles.entries()) {
				if (!localFiles.has(path)) {
					downloads.push(remoteFile);
				}
			}

			this.initialPlan = {
				localCount: localFiles.size,
				remoteCount: remoteFiles.size,
				uploads: uploads.sort((a, b) => a.path.localeCompare(b.path)),
				downloads: downloads.sort((a, b) => a.path.localeCompare(b.path)),
				conflicts: conflicts.sort((a, b) => a.path.localeCompare(b.path)),
			};
		} catch (err) {
			this.planningError = `Failed to prepare initial sync plan: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			this.planningInProgress = false;
			this.renderStep();
		}
	}

	private async executeInitialSyncPlan(): Promise<void> {
		const plan = this.initialPlan;
		if (!plan) {
			return;
		}

		this.initialSyncInProgress = true;
		this.initialSyncProgress = 'Starting initial sync...';
		this.renderStep();

		let progressModal: ProgressModal | null = null;
		try {
			const folderId = this.selectedFolderId || this.plugin.settings.gDriveFolderId;
			if (!folderId) {
				throw new Error('No Google Drive folder selected.');
			}

			const syncDb = this.plugin.syncManager.syncDb;
			syncDb.reset();
			const totalOperations = plan.downloads.length + plan.conflicts.length + plan.uploads.length;
			let completedOperations = 0;
			progressModal = new ProgressModal(this.app, {
				title: 'Initial sync in progress',
				total: Math.max(totalOperations, 1),
			});
			progressModal.open();
			progressModal.updateProgress(0, 'Preparing initial sync...');

			await this.plugin.syncManager.runWithLocalChangeSuppressed(async () => {
				this.initialSyncProgress = `Downloading ${plan.downloads.length} remote files...`;
				this.renderStep();
				for (const remoteFile of plan.downloads) {
					if (progressModal?.isCancelled()) {
						throw new Error('Initial sync cancelled by user.');
					}
					await this.applyRemoteFile(remoteFile.path, remoteFile);
					completedOperations += 1;
					progressModal?.updateProgress(completedOperations, remoteFile.path);
				}

				this.initialSyncProgress = `Resolving ${plan.conflicts.length} conflicts...`;
				this.renderStep();
				for (const conflict of plan.conflicts) {
					if (progressModal?.isCancelled()) {
						throw new Error('Initial sync cancelled by user.');
					}
					if (conflict.action === 'keep-remote') {
						await this.applyRemoteFile(conflict.path, conflict.remote);
						completedOperations += 1;
						progressModal?.updateProgress(completedOperations, conflict.path);
						continue;
					}

					if (conflict.action === 'merge-markers') {
						await this.applyConflictWithMarkers(conflict.path, conflict.remote);
						completedOperations += 1;
						progressModal?.updateProgress(completedOperations, conflict.path);
						continue;
					}

					await this.applyLocalFile(conflict.path, conflict.remote.fileId, conflict.remote.mimeType);
					completedOperations += 1;
					progressModal?.updateProgress(completedOperations, conflict.path);
				}

				this.initialSyncProgress = `Uploading ${plan.uploads.length} local files...`;
				this.renderStep();
				for (const localFile of plan.uploads) {
					if (progressModal?.isCancelled()) {
						throw new Error('Initial sync cancelled by user.');
					}
					await this.uploadLocalFile(localFile.path, folderId);
					completedOperations += 1;
					progressModal?.updateProgress(completedOperations, localFile.path);
				}

				this.initialSyncProgress = 'Cleaning duplicate files...';
				this.renderStep();
				progressModal?.updateProgress(Math.max(completedOperations, totalOperations), 'Cleaning duplicate files...');
				const cleanupSummary = await this.plugin.syncManager.cleanDuplicateArtifacts({
					shouldCancel: () => progressModal?.isCancelled() ?? false,
				});
				if (!cleanupSummary) {
					throw new Error('Duplicate cleanup could not start because sync is busy.');
				}

				await syncDb.save();
			});

			this.initialSyncProgress = 'Finalizing setup...';
			this.renderStep();
			this.plugin.settings.setupComplete = true;
			try {
				this.plugin.settings.lastSyncPageToken = await this.plugin.driveClient.getStartPageToken();
			} catch {
				this.plugin.settings.lastSyncPageToken = '';
			}
			await this.plugin.saveSettings();
			this.plugin.refreshSettingTab();

			this.step = 'done';
		} catch (err) {
			new Notice(`Initial sync failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
		} finally {
			progressModal?.finish();
			this.initialSyncInProgress = false;
			this.initialSyncProgress = '';
			this.renderStep();
		}
	}

	private async applyRemoteFile(path: string, remoteFile: RemoteScanFile): Promise<void> {
		const content = await this.plugin.driveClient.downloadFile(remoteFile.fileId);
		await this.ensureParentDirectories(path);
		await this.plugin.app.vault.adapter.writeBinary(path, content);

		const hash = await computeContentHash(content);
		this.plugin.syncManager.syncDb.setRecord(path, {
			gDriveFileId: remoteFile.fileId,
			localPath: path,
			localHash: hash,
			remoteHash: hash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.saveMarkdownSnapshot(path, content);
	}

	private async applyLocalFile(path: string, existingRemoteId: string, mimeType: string): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(path)) {
			throw new Error(`File not found: ${path}`);
		}

		const content = await this.plugin.app.vault.adapter.readBinary(path);
		const hash = await computeContentHash(content);
		await this.plugin.driveClient.updateFile(
			existingRemoteId,
			content,
			mimeType || this.getMimeType(path),
			this.plugin.settings.keepRevisionsForever && path.toLowerCase().endsWith('.md')
		);

		this.plugin.syncManager.syncDb.setRecord(path, {
			gDriveFileId: existingRemoteId,
			localPath: path,
			localHash: hash,
			remoteHash: hash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.saveMarkdownSnapshot(path, content);
	}

	private async applyConflictWithMarkers(path: string, remoteFile: RemoteScanFile): Promise<void> {
		if (!await this.plugin.app.vault.adapter.exists(path)) {
			await this.applyRemoteFile(path, remoteFile);
			return;
		}

		const localContent = await this.plugin.app.vault.adapter.readBinary(path);
		const remoteContent = await this.plugin.driveClient.downloadFile(remoteFile.fileId);
		const mergedContent = this.buildConflictMarkerContent(path, localContent, remoteContent, remoteFile.mimeType);
		const mergedHash = await computeContentHash(mergedContent);

		await this.ensureParentDirectories(path);
		await this.plugin.app.vault.adapter.writeBinary(path, mergedContent);
		await this.plugin.driveClient.updateFile(
			remoteFile.fileId,
			mergedContent,
			remoteFile.mimeType || this.getMimeType(path),
			this.plugin.settings.keepRevisionsForever && path.toLowerCase().endsWith('.md')
		);

		this.plugin.syncManager.syncDb.setRecord(path, {
			gDriveFileId: remoteFile.fileId,
			localPath: path,
			localHash: mergedHash,
			remoteHash: mergedHash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.saveMarkdownSnapshot(path, mergedContent);
	}

	private async uploadLocalFile(path: string, folderId: string): Promise<void> {
		if (this.isGeneratedArtifactPath(path)) {
			return;
		}
		if (!await this.plugin.app.vault.adapter.exists(path)) {
			return;
		}
		const content = await this.plugin.app.vault.adapter.readBinary(path);
		const hash = await computeContentHash(content);
		const { parentId, fileName } = await this.resolveRemoteParent(path, folderId);
		const metadata = await this.plugin.driveClient.createFile(
			fileName,
			content,
			this.getMimeType(path),
			parentId,
			this.plugin.settings.keepRevisionsForever && path.toLowerCase().endsWith('.md')
		);

		this.plugin.syncManager.syncDb.setRecord(path, {
			gDriveFileId: metadata.id,
			localPath: path,
			localHash: hash,
			remoteHash: hash,
			lastSyncedTimestamp: Date.now(),
			status: 'synced',
		});
		await this.saveMarkdownSnapshot(path, content);
	}

	private async scanLocalFiles(): Promise<Map<string, LocalScanFile>> {
		const localFiles = new Map<string, LocalScanFile>();
		const paths = await this.collectAllLocalPaths();
		for (const path of paths) {
			if (this.isGeneratedArtifactPath(path)) {
				continue;
			}
			const stat = await this.plugin.app.vault.adapter.stat(path);
			if (this.isPathExcluded(path, stat?.size)) {
				continue;
			}

			const content = await this.plugin.app.vault.adapter.readBinary(path);
			const hash = await computeContentHash(content);
			localFiles.set(path, {
				path,
				size: stat?.size ?? content.byteLength,
				modified: stat?.mtime ?? Date.now(),
				hash,
			});
		}
		return localFiles;
	}

	private isGeneratedArtifactPath(path: string): boolean {
		return canonicalPathForGeneratedVariant(path) !== null;
	}

	private isTextConflictCandidate(path: string, mimeType?: string): boolean {
		const lowerMime = (mimeType ?? '').toLowerCase();
		if (lowerMime.startsWith('text/')) {
			return true;
		}
		if (lowerMime.includes('json') || lowerMime.includes('xml')) {
			return true;
		}

		const lowerPath = normalizePath(path).toLowerCase();
		return (
			lowerPath.endsWith('.md') ||
			lowerPath.endsWith('.txt') ||
			lowerPath.endsWith('.json') ||
			lowerPath.endsWith('.canvas') ||
			lowerPath.endsWith('.csv') ||
			lowerPath.endsWith('.js') ||
			lowerPath.endsWith('.ts')
		);
	}

	private buildConflictMarkerContent(
		path: string,
		localContent: ArrayBuffer,
		remoteContent: ArrayBuffer,
		mimeType?: string
	): ArrayBuffer {
		if (!this.isTextConflictCandidate(path, mimeType)) {
			return localContent;
		}

		const localText = new TextDecoder().decode(localContent);
		const remoteText = new TextDecoder().decode(remoteContent);
		const merged = [
			'<<<<<<< LOCAL',
			localText,
			'=======',
			remoteText,
			'>>>>>>> REMOTE',
			'',
		].join('\n');
		return new TextEncoder().encode(merged).buffer;
	}

	private async scanRemoteFiles(
		remoteWithPaths: DriveFileWithPath[],
		remotePaths: Set<string>,
		localPaths: Set<string>
	): Promise<Map<string, RemoteScanFile>> {
		const remoteFiles = new Map<string, RemoteScanFile>();

		for (const item of remoteWithPaths) {
			const rawPath = normalizePath(item.path);
			const canonicalPath = canonicalPathForGeneratedVariant(rawPath);
			if (canonicalPath && remotePaths.has(canonicalPath)) {
				continue;
			}
			const path = canonicalPath ?? rawPath;
			if (this.isGeneratedArtifactPath(path)) {
				continue;
			}
			const size = Number(item.file.size ?? 0);
			if (this.isPathExcluded(path, Number.isFinite(size) ? size : undefined)) {
				continue;
			}

			let hash = '';
			if (localPaths.has(path)) {
				const content = await this.plugin.driveClient.downloadFile(item.file.id);
				hash = await computeContentHash(content);
			}

			const candidate: RemoteScanFile = {
				path,
				fileId: item.file.id,
				mimeType: item.file.mimeType,
				size,
				modified: parseRemoteModifiedTime(item.file.modifiedTime),
				hash,
			};

			const existing = remoteFiles.get(path);
			if (!existing || candidate.modified >= existing.modified) {
				remoteFiles.set(path, candidate);
			}
		}

		return remoteFiles;
	}

	private async collectAllLocalPaths(): Promise<string[]> {
		const discoveredFiles = new Set<string>();
		const pendingDirs: string[] = [''];
		const visitedDirs = new Set<string>();

		while (pendingDirs.length > 0) {
			const dir = pendingDirs.pop() ?? '';
			const normalizedDir = normalizePath(dir);
			if (visitedDirs.has(normalizedDir)) {
				continue;
			}
			visitedDirs.add(normalizedDir);

			const listed = await this.plugin.app.vault.adapter.list(dir);
			for (const file of listed.files) {
				discoveredFiles.add(normalizePath(file));
			}

			for (const folder of listed.folders) {
				const normalizedFolder = normalizePath(folder);
				if (visitedDirs.has(normalizedFolder)) {
					continue;
				}
				pendingDirs.push(normalizedFolder);
			}
		}

		return [...discoveredFiles].sort((a, b) => a.localeCompare(b));
	}

	private async resolveRemoteParent(path: string, rootFolderId: string): Promise<{ parentId: string; fileName: string }> {
		const segments = normalizePath(path).split('/');
		const fileName = segments.pop() ?? path;
		const parentSegments = segments.filter(Boolean);

		let parentId = rootFolderId;
		if (parentSegments.length > 0) {
			parentId = await this.plugin.driveClient.ensureFolderPath(parentSegments, rootFolderId);
		}

		return { parentId, fileName };
	}

	private getMimeType(path: string): string {
		const fileName = normalizePath(path).split('/').pop() ?? path;
		const dot = fileName.lastIndexOf('.');
		if (dot < 0) {
			return 'application/octet-stream';
		}
		const ext = fileName.slice(dot + 1).toLowerCase();
		return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
	}

	private async ensureParentDirectories(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		parts.pop();
		if (parts.length === 0) {
			return;
		}

		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.plugin.app.vault.adapter.exists(current)) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
	}

	private async saveMarkdownSnapshot(path: string, content: ArrayBuffer): Promise<void> {
		if (!path.toLowerCase().endsWith('.md')) {
			return;
		}
		await this.plugin.syncManager.snapshotManager.saveSnapshot(path, new TextDecoder().decode(content));
	}

	private isPathExcluded(path: string, fileSizeBytes?: number): boolean {
		return isExcluded(
			path,
			this.plugin.settings.excludedPaths,
			this.plugin.settings,
			this.plugin.app.vault.configDir,
			fileSizeBytes
		);
	}

	private async resetSyncDatabase(): Promise<void> {
		this.plugin.syncManager.syncDb.reset();
		await this.plugin.syncManager.syncDb.save();
	}

	private async ensureRootFolderId(): Promise<string> {
		if (this.rootFolderId) {
			return this.rootFolderId;
		}

		let rootFolderId = await this.plugin.driveClient.findFolder('Obsidian Vaults');
		if (!rootFolderId) {
			rootFolderId = await this.plugin.driveClient.createFolder('Obsidian Vaults');
		}
		this.rootFolderId = rootFolderId;
		return rootFolderId;
	}

	private async reloadExistingFolders(): Promise<void> {
		this.existingFoldersLoading = true;
		this.existingFoldersError = '';
		this.renderStep();

		try {
			const rootFolderId = await this.ensureRootFolderId();
			this.existingFolders = await this.plugin.driveClient.listFolders(rootFolderId);
			this.existingFoldersLoaded = true;
			if (!this.existingFolders.some(folder => folder.id === this.selectedExistingFolderId)) {
				this.selectedExistingFolderId = this.existingFolders[0]?.id ?? '';
			}
		} catch (err) {
			this.existingFolders = [];
			this.existingFoldersLoaded = false;
			this.selectedExistingFolderId = '';
			this.existingFoldersError = `Failed to load folders: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			this.existingFoldersLoading = false;
			this.renderStep();
		}
	}
}
