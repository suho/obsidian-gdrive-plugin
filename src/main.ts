import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, GDrivePluginSettings, GDriveSettingTab } from "./settings";

export default class GDriveSyncPlugin extends Plugin {
	settings: GDrivePluginSettings;

	async onload() {
		await this.loadSettings();
		
		// Add settings tab
		this.addSettingTab(new GDriveSettingTab(this.app, this));
		
		// Add commands for Google Drive integration
		this.addCommand({
			id: 'sync-now',
			name: 'Sync with Google Drive',
			callback: () => {
				void this.syncWithGoogleDrive();
			}
		});
		
		this.addCommand({
			id: 'authenticate',
			name: 'Authenticate with Google Drive',
			callback: () => {
				void this.authenticateWithGoogle();
			}
		});
	}

	onunload() {
		// Cleanup operations if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<GDrivePluginSettings>);
	
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
	
	async authenticateWithGoogle() {
		// Placeholder for Google authentication logic
		console.debug('Initiating Google Drive authentication');
		// Implementation would go here
	}
	
	async syncWithGoogleDrive() {
		// Placeholder for Google Drive sync logic
		console.debug('Starting Google Drive sync');
		// Implementation would go here
	}
}