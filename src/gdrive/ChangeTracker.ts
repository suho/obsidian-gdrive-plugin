import type GDriveSyncPlugin from '../main';
import type { DriveClient, DriveChange } from './DriveClient';
import type { SyncDatabase } from '../sync/SyncDatabase';

export class ChangeTracker {
	private readonly folderMembershipCache = new Map<string, boolean>();

	constructor(
		private readonly plugin: GDriveSyncPlugin,
		private readonly driveClient: DriveClient,
		private readonly syncDb: SyncDatabase
	) {
		this.folderMembershipCache.set(this.plugin.settings.gDriveFolderId, true);
	}

	async listChangesSinceLastSync(): Promise<DriveChange[]> {
		const startToken = await this.ensureStartPageToken();
		if (!startToken) return [];

		const allChanges: DriveChange[] = [];
		let pageToken = startToken;
		let finalToken = startToken;

		while (pageToken) {
			const page = await this.listChanges(pageToken);

			for (const change of page.changes) {
				if (await this.isRelevantChange(change)) {
					allChanges.push(change);
				}
			}

			if (page.nextPageToken) {
				pageToken = page.nextPageToken;
				finalToken = page.nextPageToken;
				continue;
			}

			if (page.newStartPageToken) {
				finalToken = page.newStartPageToken;
			}
			break;
		}

		if (finalToken !== this.plugin.settings.lastSyncPageToken) {
			this.plugin.settings.lastSyncPageToken = finalToken;
			await this.plugin.saveSettings();
		}

		return allChanges;
	}

	async getStartPageToken(): Promise<string> {
		return this.driveClient.getStartPageToken();
	}

	async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken: string; newStartPageToken?: string }> {
		return this.driveClient.listChanges(pageToken);
	}

	private async ensureStartPageToken(): Promise<string> {
		if (this.plugin.settings.lastSyncPageToken) {
			return this.plugin.settings.lastSyncPageToken;
		}

		const token = await this.driveClient.getStartPageToken();
		this.plugin.settings.lastSyncPageToken = token;
		await this.plugin.saveSettings();
		return token;
	}

	private async isRelevantChange(change: DriveChange): Promise<boolean> {
		if (change.removed) {
			return this.syncDb.getByGDriveId(change.fileId) !== null;
		}

		if (!change.file) return false;
		if (change.file.mimeType === 'application/vnd.google-apps.folder') return false;

		// Track already-synced files even if they were moved inside the vault tree.
		if (this.syncDb.getByGDriveId(change.fileId)) {
			return true;
		}

		const parents = change.file.parents ?? [];
		for (const parentId of parents) {
			if (await this.isInVaultFolder(parentId, new Set<string>())) {
				return true;
			}
		}

		return false;
	}

	private async isInVaultFolder(folderId: string, visited: Set<string>): Promise<boolean> {
		if (visited.has(folderId)) return false;
		visited.add(folderId);

		const cached = this.folderMembershipCache.get(folderId);
		if (typeof cached === 'boolean') {
			return cached;
		}

		if (folderId === this.plugin.settings.gDriveFolderId) {
			this.folderMembershipCache.set(folderId, true);
			return true;
		}

		try {
			const metadata = await this.driveClient.getFileMetadata(folderId);
			const parents = metadata.parents ?? [];
			for (const parentId of parents) {
				if (await this.isInVaultFolder(parentId, visited)) {
					this.folderMembershipCache.set(folderId, true);
					return true;
				}
			}
		} catch {
			this.folderMembershipCache.set(folderId, false);
			return false;
		}

		this.folderMembershipCache.set(folderId, false);
		return false;
	}
}
