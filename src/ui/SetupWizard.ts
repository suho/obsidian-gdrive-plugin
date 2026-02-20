import { App, Modal, Notice, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveFileMetadata } from '../types';

type WizardStep = 'authenticate' | 'folder' | 'done';

/**
 * Multi-step first-run setup wizard.
 *
 * Step 1 — Authenticate: Connect Google account via OAuth.
 * Step 2 — Folder: Create a new GDrive folder or select an existing one.
 *
 * This wizard is shown automatically when setupComplete === false.
 * It must be completed before any sync can begin.
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

	constructor(
		app: App,
		private readonly plugin: GDriveSyncPlugin
	) {
		super(app);
		// Default folder name matches vault name
		this.newFolderName = this.app.vault.getName();
	}

	onOpen(): void {
		this.titleEl.setText('Set up Google Drive sync');
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
				break;
			case 'folder':
				this.renderFolderStep();
				break;
			case 'done':
				this.renderDoneStep();
				break;
		}
	}

	// ── Step 1: Authenticate ──────────────────────────────────────────

	private renderAuthStep(): void {
		this.titleEl.setText('Connect to Google Drive');

		const desc = this.contentEl.createEl('p');
		desc.setText(
			'Google Drive Sync will upload your vault files to Google Drive. ' +
			'Only files created by this plugin will be accessible — ' +
			'files added to Google Drive through other apps will not be visible to this plugin.'
		);

		const notice = this.contentEl.createEl('p');
		notice.addClass('gdrive-sync-notice');
		notice.setText(
			'Your browser will open for Google sign-in. ' +
			'After signing in, return to Obsidian to continue.'
		);

		// If already authenticated, skip straight to folder step
		if (this.plugin.authManager.isAuthenticated) {
			const connectedEmail = this.plugin.settings.connectedEmail;
			const alreadyConnected = this.contentEl.createEl('p');
			alreadyConnected.addClass('gdrive-sync-connected');
			alreadyConnected.setText(connectedEmail ? `Connected as ${connectedEmail}` : 'Google account connected.');

			new Setting(this.contentEl)
				.addButton(btn =>
					btn
						.setButtonText('Continue')
						.setCta()
						.onClick(() => {
							this.step = 'folder';
							this.renderStep();
						})
				)
					.addButton(btn =>
						btn.setButtonText('Use a different account').onClick(async () => {
							await this.plugin.authManager.signOut();
							this.plugin.refreshSettingTab();
							this.renderStep();
						})
					);
			return;
		}

		const connectBtn = this.contentEl.createEl('button');
		connectBtn.addClass('mod-cta');
		connectBtn.setText('Connect to Google Drive');
		connectBtn.addEventListener('click', () => {
			void (async () => {
				connectBtn.setAttr('disabled', 'true');
				connectBtn.setText('Waiting for browser...');

				try {
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

	// ── Step 2: Folder selection ──────────────────────────────────────

	private renderFolderStep(): void {
		this.titleEl.setText('Choose a Google Drive folder');

		this.contentEl.createEl('p').setText(
			'Choose where your vault will be stored on Google Drive. ' +
			'You can create a new folder or use an existing folder in Obsidian Vaults.'
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
				.setDesc('Your vault will be stored in a dedicated folder on Google Drive.')
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
						dropdown.addOption('', this.existingFoldersLoading ? 'Loading folders...' : 'No existing folders found');
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
					btn
						.setButtonText('Refresh folder list')
						.onClick(() => {
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

		const createBtn = buttonRow.createEl('button');
		createBtn.addClass('mod-cta');
		createBtn.setText(this.folderMode === 'create' ? 'Create folder and start sync' : 'Use selected folder and start sync');
		createBtn.addEventListener('click', () => {
			void (async () => {
				createBtn.setAttr('disabled', 'true');
				createBtn.setText(this.folderMode === 'create' ? 'Creating folder...' : 'Using selected folder...');

				try {
					if (this.folderMode === 'create') {
						await this.createVaultFolder();
					} else {
						await this.useExistingVaultFolder();
					}
					this.step = 'done';
					this.renderStep();
				} catch (err) {
					createBtn.removeAttribute('disabled');
					createBtn.setText(this.folderMode === 'create' ? 'Create folder and start sync' : 'Use selected folder and start sync');
					const errorEl = this.contentEl.querySelector('.gdrive-sync-error') ?? this.contentEl.createEl('p');
					errorEl.addClass('gdrive-sync-error');
					errorEl.setText(`Failed to configure folder: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		});
	}

	private async createVaultFolder(): Promise<void> {
		const client = this.plugin.driveClient;
		const folderName = this.newFolderName || this.app.vault.getName();
		const rootFolderId = await this.ensureRootFolderId();

		// Create (or reuse) the vault-specific folder
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
		this.newFolderName = folderName;
		this.plugin.settings.gDriveFolderId = folderId;
		this.plugin.settings.gDriveFolderName = folderName;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();
		this.plugin.refreshSettingTab();
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

	// ── Step 3: Done ──────────────────────────────────────────────────

	private renderDoneStep(): void {
		this.titleEl.setText('Setup complete');

		this.contentEl.createEl('p').setText(
			`Your vault is ready to sync to "${this.newFolderName}" on Google Drive. ` +
			'Files will be uploaded automatically as you work.'
		);

		this.contentEl.createEl('p').setText(
			'Note: Sync runs only while Obsidian is open. ' +
			'On mobile, sync pauses when the app is backgrounded and resumes when you return.'
		);

		const doneBtn = this.contentEl.createEl('button');
		doneBtn.addClass('mod-cta');
		doneBtn.setText('Start syncing');
		doneBtn.addEventListener('click', () => {
			this.close();
			// Trigger an initial sync
			void this.plugin.triggerInitialSync();
		});
	}
}
