import { App, Modal, Setting } from 'obsidian';

export type ConflictModalChoice = 'local-wins' | 'remote-wins' | 'auto-merge' | 'keep-both';

interface ConflictModalOptions {
	filePath: string;
	localContent: string;
	remoteContent: string;
	localModified: number;
	remoteModified: number;
	localDeviceName: string;
	remoteDeviceName: string;
}

function changedLineIndexes(local: string, remote: string): { local: Set<number>; remote: Set<number> } {
	const localLines = local.split('\n');
	const remoteLines = remote.split('\n');
	const localChanged = new Set<number>();
	const remoteChanged = new Set<number>();
	const maxLines = Math.max(localLines.length, remoteLines.length);

	for (let index = 0; index < maxLines; index += 1) {
		const localLine = localLines[index] ?? '';
		const remoteLine = remoteLines[index] ?? '';
		if (localLine !== remoteLine) {
			localChanged.add(index);
			remoteChanged.add(index);
		}
	}

	return {
		local: localChanged,
		remote: remoteChanged,
	};
}

function renderPreLines(pre: HTMLElement, content: string, changedIndexes: Set<number>, side: 'local' | 'remote'): void {
	pre.empty();
	const lines = content.split('\n');
	if (lines.length === 0) {
		pre.setText('');
		return;
	}

	for (const [index, line] of lines.entries()) {
		const lineEl = pre.createDiv({ cls: 'gdrive-sync-conflict-line' });
		if (changedIndexes.has(index)) {
			lineEl.addClass(side === 'local' ? 'gdrive-sync-conflict-local-change' : 'gdrive-sync-conflict-remote-change');
		}
		lineEl.setText(line.length > 0 ? line : ' ');
	}
}

export class ConflictModal extends Modal {
	private resolveChoice: (choice: ConflictModalChoice | null) => void;

	constructor(
		app: App,
		private readonly options: ConflictModalOptions,
		resolveChoice: (choice: ConflictModalChoice | null) => void
	) {
		super(app);
		this.resolveChoice = resolveChoice;
	}

	static choose(app: App, options: ConflictModalOptions): Promise<ConflictModalChoice | null> {
		return new Promise(resolve => {
			const modal = new ConflictModal(app, options, resolve);
			modal.open();
		});
	}

	onOpen(): void {
		this.titleEl.setText('Resolve sync conflict');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveChoice(null);
		this.resolveChoice = () => {};
	}

	private render(): void {
		const { filePath, localModified, remoteModified, localDeviceName, remoteDeviceName, localContent, remoteContent } = this.options;

		new Setting(this.contentEl)
			.setName('File')
			.setDesc(filePath);

		const details = this.contentEl.createEl('p');
		details.addClass('gdrive-sync-conflict-meta');
		details.setText(
			`${localDeviceName}: ${new Date(localModified).toLocaleString()} | ${remoteDeviceName}: ${new Date(remoteModified).toLocaleString()}`
		);

		const split = this.contentEl.createDiv({ cls: 'gdrive-sync-conflict-split' });
		const localPane = split.createDiv({ cls: 'gdrive-sync-conflict-pane' });
		const remotePane = split.createDiv({ cls: 'gdrive-sync-conflict-pane' });

		localPane.createEl('h4', { text: `Local (${localDeviceName})` });
		remotePane.createEl('h4', { text: `Remote (${remoteDeviceName})` });

		const changedIndexes = changedLineIndexes(localContent, remoteContent);
		const localPre = localPane.createEl('pre', { cls: 'gdrive-sync-conflict-pre' });
		const remotePre = remotePane.createEl('pre', { cls: 'gdrive-sync-conflict-pre' });
		renderPreLines(localPre, localContent, changedIndexes.local, 'local');
		renderPreLines(remotePre, remoteContent, changedIndexes.remote, 'remote');

		const buttonRow = this.contentEl.createDiv({ cls: 'gdrive-sync-button-row' });
		this.addChoiceButton(buttonRow, 'Keep local', 'local-wins');
		this.addChoiceButton(buttonRow, 'Keep remote', 'remote-wins');
		this.addChoiceButton(buttonRow, 'Auto-merge', 'auto-merge');
		this.addChoiceButton(buttonRow, 'Keep both', 'keep-both');
	}

	private addChoiceButton(container: HTMLElement, text: string, choice: ConflictModalChoice): void {
		const button = container.createEl('button');
		button.setText(text);
		if (choice === 'auto-merge') {
			button.addClass('mod-cta');
		}
		button.addEventListener('click', () => {
			this.resolveChoice(choice);
			this.resolveChoice = () => {};
			this.close();
		});
	}
}
