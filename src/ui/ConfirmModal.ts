import { App, Modal } from 'obsidian';

interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	warning?: boolean;
}

export class ConfirmModal extends Modal {
	private resolve: (result: boolean) => void;
	private resolved = false;

	constructor(app: App, private readonly options: ConfirmModalOptions, resolve: (result: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	static ask(app: App, options: ConfirmModalOptions): Promise<boolean> {
		return new Promise(resolve => {
			const modal = new ConfirmModal(app, options, resolve);
			modal.open();
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: this.options.message });
		const buttonRow = this.contentEl.createDiv({ cls: 'gdrive-sync-button-row' });

		const cancelButton = buttonRow.createEl('button', { text: this.options.cancelText ?? 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.finish(false);
		});

		const confirmButton = buttonRow.createEl('button', { text: this.options.confirmText ?? 'Confirm' });
		if (this.options.warning) {
			confirmButton.addClass('mod-warning');
		} else {
			confirmButton.addClass('mod-cta');
		}
		confirmButton.addEventListener('click', () => {
			this.finish(true);
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(false);
		}
		this.contentEl.empty();
	}

	private finish(result: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(result);
		this.close();
	}
}
