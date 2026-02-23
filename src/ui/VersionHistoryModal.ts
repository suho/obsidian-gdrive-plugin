import { App, Modal, Notice, Setting } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { DriveRevision } from '../types';

type DiffLineKind = 'context' | 'removed' | 'added';

interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

function isTextLike(path: string, mimeType: string): boolean {
	if (mimeType.startsWith('text/')) {
		return true;
	}
	const lowerPath = path.toLowerCase();
	return (
		lowerPath.endsWith('.md') ||
		lowerPath.endsWith('.txt') ||
		lowerPath.endsWith('.json') ||
		lowerPath.endsWith('.canvas')
	);
}

function diffLines(current: string, selected: string): DiffLine[] {
	const currentLines = current.split('\n');
	const selectedLines = selected.split('\n');
	const max = Math.max(currentLines.length, selectedLines.length);
	const lines: DiffLine[] = [];
	for (let index = 0; index < max; index += 1) {
		const left = currentLines[index] ?? '';
		const right = selectedLines[index] ?? '';
		if (left === right) {
			lines.push({ kind: 'context', text: right });
			continue;
		}
		if (left.length > 0) {
			lines.push({ kind: 'removed', text: left });
		}
		if (right.length > 0) {
			lines.push({ kind: 'added', text: right });
		}
	}
	return lines;
}

function renderDiffLines(container: HTMLElement, lines: DiffLine[]): void {
	container.empty();
	for (const line of lines) {
		const lineEl = container.createDiv({ cls: 'gdrive-sync-history-line' });
		const prefix = line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' ';
		lineEl.addClass(`gdrive-sync-history-line--${line.kind}`);
		lineEl.setText(`${prefix} ${line.text.length > 0 ? line.text : ' '}`);
	}
}

function actorLabel(revision: DriveRevision): string {
	const actor = revision.lastModifyingUser;
	if (!actor) {
		return 'Unknown device';
	}
	if (actor.me) {
		return 'This account';
	}
	if (actor.displayName) {
		return actor.displayName;
	}
	if (actor.emailAddress) {
		return actor.emailAddress;
	}
	return 'Unknown device';
}

export class VersionHistoryModal extends Modal {
	private revisions: DriveRevision[] = [];
	private selectedRevisionId = '';
	private selectedContent = '';
	private loading = false;
	private error = '';
	private selectedContentIsText = false;

	constructor(
		app: App,
		private readonly plugin: GDriveSyncPlugin,
		private readonly filePath: string,
		private readonly fileId: string
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Google Drive version history');
		this.modalEl.addClass('gdrive-sync-history-modal');
		void this.load();
	}

	onClose(): void {
		this.modalEl.removeClass('gdrive-sync-history-modal');
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = '';
		this.render();
		try {
			this.revisions = await this.plugin.driveClient.listRevisions(this.fileId);
			this.revisions.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
			this.selectedRevisionId = this.revisions[0]?.id ?? '';
			if (this.selectedRevisionId) {
				await this.loadSelectedContent();
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async loadSelectedContent(): Promise<void> {
		if (!this.selectedRevisionId) {
			this.selectedContentIsText = false;
			this.selectedContent = '';
			return;
		}

		const selected = this.revisions.find(revision => revision.id === this.selectedRevisionId);
		if (!selected) {
			this.selectedContentIsText = false;
			this.selectedContent = '';
			return;
		}

		const bytes = await this.plugin.driveClient.downloadRevision(this.fileId, this.selectedRevisionId);
		if (!isTextLike(this.filePath, selected.mimeType)) {
			this.selectedContentIsText = false;
			this.selectedContent = '[Binary revision preview unavailable]';
			return;
		}

		this.selectedContentIsText = true;
		this.selectedContent = new TextDecoder().decode(bytes);
	}

	private render(): void {
		this.contentEl.empty();
		if (this.loading) {
			this.contentEl.createEl('p', { text: 'Loading revisions...' });
			return;
		}

		if (this.error) {
			const errorEl = this.contentEl.createEl('p', { text: this.error, cls: 'gdrive-sync-error' });
			errorEl.addClass('gdrive-sync-error');
			return;
		}

		if (this.revisions.length === 0) {
			this.contentEl.createEl('p', { text: 'No revisions available for this file.' });
			return;
		}

		const split = this.contentEl.createDiv({ cls: 'gdrive-sync-history-split' });
		const left = split.createDiv({ cls: 'gdrive-sync-history-left' });
		const right = split.createDiv({ cls: 'gdrive-sync-history-right' });

		left.createEl('h4', { text: 'Revisions' });
		for (const revision of this.revisions) {
			const item = left.createDiv({ cls: 'gdrive-sync-history-revision-item' });
			const button = item.createEl('button', {
				text: new Date(revision.modifiedTime).toLocaleString(),
				cls: revision.id === this.selectedRevisionId ? 'mod-cta' : '',
			});
			item.createDiv({
				cls: 'gdrive-sync-history-revision-meta',
				text: actorLabel(revision),
			});
			button.addEventListener('click', () => {
				void (async () => {
					this.selectedRevisionId = revision.id;
					await this.loadSelectedContent();
					this.render();
				})();
			});
		}

		right.createEl('p', {
			cls: 'gdrive-sync-history-preview-meta',
			text: 'Comparing selected revision with current local file.',
		});

		const preview = right.createDiv({ cls: 'gdrive-sync-history-preview' });
		if (this.selectedContentIsText) {
			void (async () => {
				try {
					const current = await this.plugin.app.vault.adapter.read(this.filePath);
					renderDiffLines(preview, diffLines(current, this.selectedContent));
				} catch {
					preview.setText(this.selectedContent);
				}
			})();
		} else {
			preview.setText(this.selectedContent);
		}

		new Setting(this.contentEl)
			.setName('Restore selected revision')
			.setDesc('Overwrite the local file and upload restored content to Google Drive.')
			.addButton(button => {
				button
					.setButtonText('Restore this version')
					.setWarning()
					.onClick(() => {
						void (async () => {
							if (!this.selectedRevisionId) {
								new Notice('Select a revision first.');
								return;
							}
							button.setDisabled(true);
							button.setButtonText('Restoring...');
							try {
								await this.plugin.syncManager.restoreFileRevision(this.filePath, this.fileId, this.selectedRevisionId);
								new Notice(`Restored ${this.filePath}`);
								this.close();
							} catch (err) {
								button.setDisabled(false);
								button.setButtonText('Restore this version');
								new Notice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
							}
						})();
					});
			});
	}
}
