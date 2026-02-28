import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import {
	analyzeConflictMarkers,
	resolveConflictMarkers,
	type ConflictMarkerAnalysis,
	type ConflictResolveStrategy,
} from '../sync/conflictMarkers';
import { runWithConcurrencyLimit } from '../utils/concurrency';

interface ConflictedFileEntry {
	file: TFile;
	analysis: ConflictMarkerAnalysis;
}

const SCAN_CONCURRENCY = 8;

function formatConflictCount(count: number): string {
	return count === 1 ? '1 conflict block' : `${count} conflict blocks`;
}

function strategyLabel(strategy: ConflictResolveStrategy): string {
	return strategy === 'local-first' ? 'local first' : 'remote first';
}

export class ConflictedFilesModal extends Modal {
	private scanRunId = 0;
	private isScanning = false;
	private conflictedFiles: ConflictedFileEntry[] = [];

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Review conflicted files');
		this.startScan();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private startScan(): void {
		this.isScanning = true;
		this.render();
		void this.scanConflictedFiles();
	}

	private async scanConflictedFiles(): Promise<void> {
		const runId = this.scanRunId + 1;
		this.scanRunId = runId;
		const files = this.app.vault.getFiles();
		const matches: ConflictedFileEntry[] = [];

		await runWithConcurrencyLimit(files, SCAN_CONCURRENCY, async (file) => {
			try {
				const content = await this.app.vault.cachedRead(file);
				const analysis = analyzeConflictMarkers(content);
				if (!analysis.hasConflictMarkers) {
					return;
				}
				matches.push({ file, analysis });
			} catch {
				// Ignore unreadable files and continue scanning.
			}
		});

		if (runId !== this.scanRunId) {
			return;
		}

		matches.sort((a, b) => a.file.path.localeCompare(b.file.path));
		this.conflictedFiles = matches;
		this.isScanning = false;
		this.render();
	}

	private render(): void {
		this.contentEl.empty();

		new Setting(this.contentEl)
			.setName('Conflict marker scan')
			.setDesc(
				this.isScanning
					? 'Scanning all files for conflict markers...'
					: `Found ${this.conflictedFiles.length} files with conflict markers.`
			)
			.addButton(button => {
				button
					.setButtonText('Rescan')
					.setDisabled(this.isScanning)
					.onClick(() => {
						this.startScan();
					});
			});

		if (this.isScanning) {
			this.contentEl.createEl('p', { text: 'Scanning files...' });
			return;
		}

		if (this.conflictedFiles.length === 0) {
			this.contentEl.createEl('p', { text: 'No files with conflict markers were found.' });
			return;
		}

		this.contentEl.createEl('p', {
			text: 'Use quick resolve to keep local sections or remote sections, or open a file for manual resolve.',
			cls: 'gdrive-sync-conflict-review-summary',
		});

		const table = this.contentEl.createEl('table', { cls: 'gdrive-sync-conflict-table' });
		const headRow = table.createTHead().insertRow();
		headRow.insertCell().setText('File');
		headRow.insertCell().setText('Markers');
		headRow.insertCell().setText('Actions');

		const body = table.createTBody();
		for (const entry of this.conflictedFiles) {
			const row = body.insertRow();
			row.insertCell().setText(entry.file.path);

			const markersCell = row.insertCell();
			if (entry.analysis.conflictCount > 0) {
				markersCell.createDiv({ text: formatConflictCount(entry.analysis.conflictCount) });
			} else {
				markersCell.createDiv({ text: 'Markers found but no complete conflict blocks.' });
			}
			if (entry.analysis.hasUnbalancedMarkers) {
				markersCell.createDiv({
					text: 'Markers look unbalanced. Use manual resolve.',
					cls: 'gdrive-sync-conflict-warning',
				});
			}

			const actionsCell = row.insertCell();
			const actions = actionsCell.createDiv({ cls: 'gdrive-sync-conflict-actions' });

			const localButton = actions.createEl('button');
			localButton.setText('Local first');
			const remoteButton = actions.createEl('button');
			remoteButton.setText('Remote first');
			const manualButton = actions.createEl('button');
			manualButton.setText('Manual');

			const canQuickResolve = entry.analysis.conflictCount > 0 && !entry.analysis.hasUnbalancedMarkers;
			localButton.disabled = !canQuickResolve;
			remoteButton.disabled = !canQuickResolve;
			if (!canQuickResolve) {
				localButton.title = 'Quick resolve is disabled for malformed markers.';
				remoteButton.title = 'Quick resolve is disabled for malformed markers.';
			}

			localButton.addEventListener('click', () => {
				void this.applyQuickResolve(entry, 'local-first', [localButton, remoteButton, manualButton]);
			});
			remoteButton.addEventListener('click', () => {
				void this.applyQuickResolve(entry, 'remote-first', [localButton, remoteButton, manualButton]);
			});
			manualButton.addEventListener('click', () => {
				this.openFileForManualResolve(entry.file.path);
			});
		}
	}

	private async applyQuickResolve(
		entry: ConflictedFileEntry,
		strategy: ConflictResolveStrategy,
		buttons: HTMLButtonElement[]
	): Promise<void> {
		this.setButtonsBusy(buttons, true);
		try {
			const file = this.app.vault.getAbstractFileByPath(entry.file.path);
			if (!(file instanceof TFile)) {
				this.removeEntry(entry.file.path);
				new Notice(`File not found: ${entry.file.path}`);
				this.render();
				return;
			}

			const content = await this.app.vault.cachedRead(file);
			const latestAnalysis = analyzeConflictMarkers(content);
			if (!latestAnalysis.hasConflictMarkers) {
				this.removeEntry(file.path);
				new Notice(`No conflict markers remain in ${file.path}.`);
				this.render();
				return;
			}
			if (latestAnalysis.hasUnbalancedMarkers || latestAnalysis.conflictCount === 0) {
				new Notice(`Quick resolve could not run for ${file.path}. Open the file and resolve manually.`, 10000);
				this.render();
				return;
			}

			const resolved = resolveConflictMarkers(content, strategy);
			await this.app.vault.modify(file, resolved.content);

			const updatedAnalysis = analyzeConflictMarkers(resolved.content);
			if (updatedAnalysis.hasConflictMarkers) {
				this.upsertEntry(file, updatedAnalysis);
			} else {
				this.removeEntry(file.path);
			}

			new Notice(
				`Resolved ${resolved.resolvedCount} ${resolved.resolvedCount === 1 ? 'conflict block' : 'conflict blocks'} in ${file.path} using ${strategyLabel(strategy)}.`
			);
			this.render();
		} catch (err) {
			new Notice(`Quick resolve failed: ${err instanceof Error ? err.message : String(err)}`, 10000);
			this.setButtonsBusy(buttons, false);
		}
	}

	private setButtonsBusy(buttons: HTMLButtonElement[], busy: boolean): void {
		for (const button of buttons) {
			button.disabled = busy;
		}
	}

	private openFileForManualResolve(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		if (!leaf) {
			new Notice('Could not open a workspace leaf for manual resolve.');
			return;
		}
		void leaf.openFile(file);
		this.close();
	}

	private upsertEntry(file: TFile, analysis: ConflictMarkerAnalysis): void {
		const index = this.conflictedFiles.findIndex(entry => entry.file.path === file.path);
		const value = { file, analysis };
		if (index === -1) {
			this.conflictedFiles.push(value);
		} else {
			this.conflictedFiles[index] = value;
		}
		this.conflictedFiles.sort((a, b) => a.file.path.localeCompare(b.file.path));
	}

	private removeEntry(path: string): void {
		this.conflictedFiles = this.conflictedFiles.filter(entry => entry.file.path !== path);
	}
}
