import { App, Modal, Notice, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';

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
			'A new folder will be created with the name you specify.'
		);

		// Folder name input
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
		createBtn.setText('Create folder and start sync');
		createBtn.addEventListener('click', () => {
			void (async () => {
				createBtn.setAttr('disabled', 'true');
				createBtn.setText('Creating folder...');

				try {
					await this.createVaultFolder();
					this.step = 'done';
					this.renderStep();
				} catch (err) {
					createBtn.removeAttribute('disabled');
					createBtn.setText('Create folder and start sync');
					const errorEl = this.contentEl.querySelector('.gdrive-sync-error') ?? this.contentEl.createEl('p');
					errorEl.addClass('gdrive-sync-error');
					errorEl.setText(`Failed to create folder: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		});
	}

	private async createVaultFolder(): Promise<void> {
		const client = this.plugin.driveClient;
		const folderName = this.newFolderName || this.app.vault.getName();

		// Ensure the "Obsidian Vaults" root folder exists
		let rootFolderId = await client.findFolder('Obsidian Vaults');
		if (!rootFolderId) {
			rootFolderId = await client.createFolder('Obsidian Vaults');
		}

		// Create (or reuse) the vault-specific folder
		let vaultFolderId = await client.findFolder(folderName, rootFolderId);
		if (!vaultFolderId) {
			vaultFolderId = await client.createFolder(folderName, rootFolderId);
		}

		this.plugin.settings.gDriveFolderId = vaultFolderId;
		this.plugin.settings.gDriveFolderName = folderName;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();
		this.plugin.refreshSettingTab();
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
