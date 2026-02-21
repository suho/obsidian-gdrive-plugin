import { App, Modal } from 'obsidian';

interface ProgressModalOptions {
	title: string;
	total: number;
	onCancel?: () => void;
}

export class ProgressModal extends Modal {
	private readonly titleText: string;
	private readonly total: number;
	private readonly onCancel?: () => void;
	private allowClose = false;
	private cancelled = false;
	private current = 0;
	private currentFile = '';
	private startedAt = Date.now();
	private intervalId = 0;
	private progressEl!: HTMLProgressElement;
	private metaEl!: HTMLElement;
	private fileEl!: HTMLElement;

	constructor(app: App, options: ProgressModalOptions) {
		super(app);
		this.titleText = options.title;
		this.total = Math.max(1, options.total);
		this.onCancel = options.onCancel;
	}

	override close(): void {
		if (!this.allowClose) {
			return;
		}
		super.close();
	}

	isCancelled(): boolean {
		return this.cancelled;
	}

	updateProgress(current: number, fileName: string): void {
		this.current = Math.min(Math.max(0, current), this.total);
		this.currentFile = fileName;
		this.renderState();
	}

	finish(): void {
		this.allowClose = true;
		if (this.intervalId) {
			window.clearInterval(this.intervalId);
			this.intervalId = 0;
		}
		this.close();
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.contentEl.empty();
		this.progressEl = this.contentEl.createEl('progress', { cls: 'gdrive-sync-progress-bar' });
		this.progressEl.max = this.total;
		this.metaEl = this.contentEl.createDiv({ cls: 'gdrive-sync-progress-meta' });
		this.fileEl = this.contentEl.createDiv({ cls: 'gdrive-sync-progress-file' });

		const cancelButton = this.contentEl.createEl('button', { text: 'Cancel' });
		cancelButton.addClass('mod-warning');
		cancelButton.addEventListener('click', () => {
			if (this.cancelled) {
				return;
			}
			this.cancelled = true;
			cancelButton.disabled = true;
			cancelButton.setText('Cancelling...');
			this.onCancel?.();
		});

		this.startedAt = Date.now();
		this.renderState();
		this.intervalId = window.setInterval(() => {
			this.renderState();
		}, 1000);
	}

	onClose(): void {
		if (this.intervalId) {
			window.clearInterval(this.intervalId);
			this.intervalId = 0;
		}
		this.contentEl.empty();
	}

	private renderState(): void {
		if (!this.progressEl) {
			return;
		}
		this.progressEl.value = this.current;
		const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
		this.metaEl.setText(`${this.current} of ${this.total} files · ${elapsedSeconds}s elapsed`);
		this.fileEl.setText(this.currentFile ? `Current file: ${this.currentFile}` : 'Preparing...');
	}
}
