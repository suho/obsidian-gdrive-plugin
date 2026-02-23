import { App, ItemView, Modal, Notice, Platform, Setting, WorkspaceLeaf } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import type { ActivityLogEntry } from '../types';

export const ACTIVITY_LOG_VIEW_TYPE = 'gdrive-sync-activity-log';

export type ActivityLogFilter = 'all' | 'pushed' | 'pulled' | 'merged' | 'conflicts' | 'errors' | 'deleted';

const FILTER_OPTIONS: Array<{ value: ActivityLogFilter; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'pushed', label: 'Pushed' },
	{ value: 'pulled', label: 'Pulled' },
	{ value: 'merged', label: 'Merged' },
	{ value: 'conflicts', label: 'Conflicts' },
	{ value: 'errors', label: 'Errors' },
	{ value: 'deleted', label: 'Deleted' },
];

function iconForAction(action: ActivityLogEntry['action']): string {
	if (action === 'pushed') return 'UP';
	if (action === 'pulled') return 'DN';
	if (action === 'merged') return 'MG';
	if (action === 'deleted') return 'DL';
	if (action === 'restored') return 'RS';
	if (action === 'conflict') return 'CF';
	if (action === 'error') return 'ER';
	return 'SK';
}

function labelForAction(action: ActivityLogEntry['action']): string {
	if (action === 'pushed') return 'Pushed';
	if (action === 'pulled') return 'Pulled';
	if (action === 'merged') return 'Merged';
	if (action === 'deleted') return 'Deleted';
	if (action === 'restored') return 'Restored';
	if (action === 'conflict') return 'Conflict';
	if (action === 'error') return 'Error';
	return 'Skipped';
}

function matchesFilter(entry: ActivityLogEntry, filter: ActivityLogFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'pushed') return entry.action === 'pushed';
	if (filter === 'pulled') return entry.action === 'pulled';
	if (filter === 'merged') return entry.action === 'merged';
	if (filter === 'conflicts') return entry.action === 'conflict';
	if (filter === 'errors') return entry.action === 'error';
	return entry.action === 'deleted' || entry.action === 'restored';
}

function matchesSearch(entry: ActivityLogEntry, query: string): boolean {
	if (!query) return true;
	const haystack = `${entry.path} ${entry.detail ?? ''} ${entry.error ?? ''}`.toLowerCase();
	return haystack.includes(query.toLowerCase());
}

function sortedEntries(entries: ActivityLogEntry[]): ActivityLogEntry[] {
	return [...entries].sort((a, b) => b.timestamp - a.timestamp);
}

export class ActivityLogView extends ItemView {
	private filter: ActivityLogFilter = 'all';
	private query = '';
	private lastRenderedSignature = '';

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GDriveSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ACTIVITY_LOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Google Drive activity log';
	}

	getIcon(): string {
		return 'history';
	}

	setFilter(filter: ActivityLogFilter): void {
		this.filter = filter;
		this.render();
	}

	async onOpen(): Promise<void> {
		this.render();
		this.registerInterval(window.setInterval(() => {
			this.renderIfChanged();
		}, 1000));
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private renderIfChanged(): void {
		const entries = this.filteredEntries();
		const signature = `${entries.length}:${entries[0]?.id ?? ''}:${this.filter}:${this.query}`;
		if (signature === this.lastRenderedSignature) {
			return;
		}
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('gdrive-sync-activity-view');
		const controls = this.contentEl.createDiv({ cls: 'gdrive-sync-activity-controls' });
		const filterRow = controls.createDiv({ cls: 'gdrive-sync-activity-filters' });
		for (const option of FILTER_OPTIONS) {
			const button = filterRow.createEl('button', {
				text: option.label,
				cls: option.value === this.filter ? 'mod-cta' : '',
			});
			button.addEventListener('click', () => {
				this.filter = option.value;
				this.render();
			});
		}

		new Setting(controls)
			.setName('Search path')
			.addSearch(search => {
				search
					.setPlaceholder('Find file path')
					.setValue(this.query)
					.onChange(value => {
						this.query = value;
						this.render();
					});
			});

		const list = this.contentEl.createDiv({ cls: 'gdrive-sync-activity-list' });
		const entries = this.filteredEntries();
		if (entries.length === 0) {
			list.createEl('p', { text: 'No activity entries match the current filter.' });
			this.lastRenderedSignature = `0:${this.filter}:${this.query}`;
			return;
		}

		for (const entry of entries) {
			this.renderEntry(list, entry);
		}

		this.lastRenderedSignature = `${entries.length}:${entries[0]?.id ?? ''}:${this.filter}:${this.query}`;
	}

	private filteredEntries(): ActivityLogEntry[] {
		const entries = this.plugin.syncManager.getAllActivityEntries();
		return sortedEntries(entries).filter(entry => matchesFilter(entry, this.filter) && matchesSearch(entry, this.query));
	}

	private renderEntry(container: HTMLElement, entry: ActivityLogEntry): void {
		const row = container.createDiv({ cls: 'gdrive-sync-activity-entry' });
		const head = row.createDiv({ cls: 'gdrive-sync-activity-entry-head' });
		head.createSpan({ cls: 'gdrive-sync-activity-icon', text: iconForAction(entry.action) });
		head.createSpan({ cls: 'gdrive-sync-activity-time', text: new Date(entry.timestamp).toLocaleString() });
		head.createSpan({ cls: 'gdrive-sync-activity-action', text: labelForAction(entry.action) });

		row.createDiv({ cls: 'gdrive-sync-activity-path', text: entry.path });

		if (entry.error) {
			row.createDiv({ cls: 'gdrive-sync-activity-error', text: entry.error });
		}

		if (entry.detail) {
			if (entry.action === 'merged') {
				const toggle = row.createEl('button', { text: 'View merge diff', cls: 'gdrive-sync-linkish' });
				const detail = row.createDiv({ cls: 'gdrive-sync-activity-detail is-hidden', text: entry.detail });
				toggle.addEventListener('click', () => {
					detail.toggleClass('is-hidden', !detail.hasClass('is-hidden'));
					toggle.setText(detail.hasClass('is-hidden') ? 'View merge diff' : 'Hide merge diff');
				});
			} else {
				row.createDiv({ cls: 'gdrive-sync-activity-detail', text: entry.detail });
			}
		}

		if (entry.action === 'deleted' && entry.fileId) {
			const restoreButton = row.createEl('button', { text: 'Restore from Google Drive', cls: 'gdrive-sync-linkish' });
			restoreButton.addEventListener('click', () => {
				void (async () => {
					restoreButton.disabled = true;
					try {
						await this.plugin.restoreDeletedFromActivity(entry);
						new Notice(`Restored ${entry.path}`);
						this.render();
					} catch (err) {
						restoreButton.disabled = false;
						new Notice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, 10000);
					}
				})();
			});
		}
	}
}

export class ActivityLogModal extends Modal {
	private filter: ActivityLogFilter;
	private query = '';

	constructor(
		app: App,
		private readonly plugin: GDriveSyncPlugin,
		initialFilter: ActivityLogFilter = 'all'
	) {
		super(app);
		this.filter = initialFilter;
	}

	onOpen(): void {
		this.titleEl.setText('Google Drive activity log');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const controls = this.contentEl.createDiv({ cls: 'gdrive-sync-activity-controls' });
		new Setting(controls)
			.setName('Filter')
			.addDropdown(drop => {
				for (const option of FILTER_OPTIONS) {
					drop.addOption(option.value, option.label);
				}
				drop.setValue(this.filter);
				drop.onChange(value => {
					this.filter = value as ActivityLogFilter;
					this.render();
				});
			})
			.addSearch(search => {
				search
					.setPlaceholder('Find file path')
					.setValue(this.query)
					.onChange(value => {
						this.query = value;
						this.render();
					});
			});

		const entries = sortedEntries(this.plugin.syncManager.getAllActivityEntries())
			.filter(entry => matchesFilter(entry, this.filter) && matchesSearch(entry, this.query));
		const list = this.contentEl.createDiv({ cls: 'gdrive-sync-activity-list' });
		if (entries.length === 0) {
			list.createEl('p', { text: 'No matching entries.' });
			return;
		}

		for (const entry of entries.slice(0, Platform.isMobile ? 120 : 250)) {
			const row = list.createDiv({ cls: 'gdrive-sync-activity-entry' });
			const title = `${iconForAction(entry.action)} ${new Date(entry.timestamp).toLocaleString()} · ${labelForAction(entry.action)}`;
			row.createDiv({ text: title });
			row.createDiv({ cls: 'gdrive-sync-activity-path', text: entry.path });
			if (entry.error) {
				row.createDiv({ cls: 'gdrive-sync-activity-error', text: entry.error });
			} else if (entry.detail) {
				row.createDiv({ cls: 'gdrive-sync-activity-detail', text: entry.detail });
			}
		}
	}
}
