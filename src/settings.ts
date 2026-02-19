import { App, PluginSettingTab, Setting } from "obsidian";
import GDriveSyncPlugin from "./main";

export interface GDrivePluginSettings {
	googleApiKey: string;
	folderId: string;
	syncInterval: number;
	autoSync: boolean;
}

export const DEFAULT_SETTINGS: GDrivePluginSettings = {
	googleApiKey: '',
	folderId: '',
	syncInterval: 30, // minutes
	autoSync: false
}

export class GDriveSettingTab extends PluginSettingTab {
	plugin: GDriveSyncPlugin;

	constructor(app: App, plugin: GDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Configuration')
			.setHeading();
	}
}
