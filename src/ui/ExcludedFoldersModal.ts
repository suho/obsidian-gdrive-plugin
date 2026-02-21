import { App, Modal, normalizePath } from 'obsidian';

export class ExcludedFoldersModal extends Modal {
	private readonly currentExclusions: Set<string>;
	private readonly onSave: (paths: string[]) => void;
	private folders: string[] = [];
	private query = '';

	constructor(app: App, exclusions: string[], onSave: (paths: string[]) => void) {
		super(app);
		this.currentExclusions = new Set(exclusions.map(path => normalizePath(path)));
		this.onSave = onSave;
	}

	onOpen(): void {
		this.titleEl.setText('Excluded folders');
		void this.loadFolders();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadFolders(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: 'Loading folders...' });
		this.folders = await this.collectFolders();
		this.render();
	}

	private async collectFolders(): Promise<string[]> {
		const found = new Set<string>();
		const pending = [''];
		const visited = new Set<string>();

		while (pending.length > 0) {
			const dir = normalizePath(pending.pop() ?? '');
			if (visited.has(dir)) {
				continue;
			}
			visited.add(dir);
			const listed = await this.app.vault.adapter.list(dir);
			for (const folder of listed.folders) {
				const normalized = normalizePath(folder);
				found.add(normalized);
				if (!visited.has(normalized)) {
					pending.push(normalized);
				}
			}
		}

		return [...found].sort((a, b) => a.localeCompare(b));
	}

	private render(): void {
		this.contentEl.empty();
		const controls = this.contentEl.createDiv({ cls: 'gdrive-sync-folder-controls' });
		const search = controls.createEl('input', {
			type: 'search',
			placeholder: 'Search folders',
		});
		search.value = this.query;
		search.addEventListener('input', () => {
			this.query = search.value;
			this.render();
		});

		const list = this.contentEl.createDiv({ cls: 'gdrive-sync-folder-list' });
		const visibleFolders = this.folders.filter(folder => folder.toLowerCase().includes(this.query.toLowerCase()));
		if (visibleFolders.length === 0) {
			list.createEl('p', { text: 'No folders found.' });
		} else {
			for (const folder of visibleFolders) {
				const row = list.createDiv({ cls: 'gdrive-sync-folder-row' });
				const checkbox = row.createEl('input', { type: 'checkbox' });
				checkbox.checked = this.currentExclusions.has(folder);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.currentExclusions.add(folder);
					} else {
						this.currentExclusions.delete(folder);
					}
				});
				row.createEl('span', { text: folder });
			}
		}

		const buttonRow = this.contentEl.createDiv({ cls: 'gdrive-sync-button-row' });
		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const saveButton = buttonRow.createEl('button', { text: 'Save exclusions', cls: 'mod-cta' });
		saveButton.addEventListener('click', () => {
			this.onSave([...this.currentExclusions].sort((a, b) => a.localeCompare(b)));
			this.close();
		});
	}
}
