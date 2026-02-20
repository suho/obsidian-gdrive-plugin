import { requestUrl, RequestUrlParam } from 'obsidian';
import type { GoogleAuthManager } from '../auth/GoogleAuthManager';
import type { DriveFileMetadata, DriveRevision } from '../types';

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// Fields to request for file metadata (minimizes response size)
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,md5Checksum,size,parents,trashed';

// Max bytes for simple upload — use resumable above this
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5 MB
type DriveResponse = Awaited<ReturnType<typeof requestUrl>>;

export class DriveClientError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly code?: string
	) {
		super(message);
		this.name = 'DriveClientError';
	}
}

export class StorageQuotaError extends DriveClientError {
	constructor() {
		super('Google Drive storage quota exceeded', 403, 'storageQuotaExceeded');
	}
}

export class DriveClient {
	constructor(private readonly auth: GoogleAuthManager) {}

	// ── File operations ───────────────────────────────────────────────

	/**
	 * Upload a new file to Google Drive.
	 * Returns the created file's metadata.
	 */
	async createFile(
		name: string,
		content: ArrayBuffer,
		mimeType: string,
		parentId: string,
		keepRevisionForever = false
	): Promise<DriveFileMetadata> {
		const metadata = { name, parents: [parentId] };

		let fileId: string;

		if (content.byteLength > RESUMABLE_THRESHOLD) {
			fileId = await this.resumableUpload(metadata, content, mimeType, undefined);
		} else {
			fileId = await this.multipartUpload(metadata, content, mimeType);
		}

		if (keepRevisionForever) {
			await this.keepLatestRevisionForever(fileId);
		}

		return this.getFileMetadata(fileId);
	}

	/** Backward-compatible alias used by the Phase 1 API checklist. */
	async uploadFile(
		name: string,
		content: ArrayBuffer,
		mimeType: string,
		parentId: string,
		keepRevisionForever = false
	): Promise<string> {
		const created = await this.createFile(name, content, mimeType, parentId, keepRevisionForever);
		return created.id;
	}

	/**
	 * Update an existing file's content.
	 * Returns the updated file's metadata.
	 */
	async updateFile(
		fileId: string,
		content: ArrayBuffer,
		mimeType: string,
		keepRevisionForever = false
	): Promise<DriveFileMetadata> {
		if (content.byteLength > RESUMABLE_THRESHOLD) {
			await this.resumableUpload({}, content, mimeType, fileId);
		} else {
			await this.simplePatchUpload(fileId, content, mimeType);
		}

		if (keepRevisionForever) {
			await this.keepLatestRevisionForever(fileId);
		}

		return this.getFileMetadata(fileId);
	}

	/**
	 * Download a file's content by its GDrive file ID.
	 */
	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return response.arrayBuffer;
	}

	/**
	 * Rename a file on Google Drive (preserves its file ID and version history).
	 */
	async renameFile(fileId: string, newName: string): Promise<void> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}?fields=${encodeURIComponent(FILE_FIELDS)}`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: newName }),
		}));
		this.assertOk(response.status, response.text);
	}

	/**
	 * Move a file to a new parent folder (preserves file ID and version history).
	 */
	async moveFile(fileId: string, newParentId: string, oldParentId: string): Promise<void> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}?addParents=${newParentId}&removeParents=${oldParentId}`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		}));
		this.assertOk(response.status, response.text);
	}

	/**
	 * Move a file to GDrive Trash (recoverable for 30 days).
	 */
	async trashFile(fileId: string): Promise<void> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}?fields=id,trashed`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ trashed: true }),
		}));
		this.assertOk(response.status, response.text);
	}

	/** Backward-compatible alias used by the Phase 1 API checklist. */
	async deleteFile(fileId: string): Promise<void> {
		await this.trashFile(fileId);
	}

	/**
	 * Permanently delete a file (not recoverable).
	 * Only used for prune operations; normal deletes use trashFile.
	 */
	async deleteFilePermanently(fileId: string): Promise<void> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}`,
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` },
		}));
		// 204 No Content is the success response for DELETE
		if (response.status !== 204 && response.status !== 200) {
			this.assertOk(response.status, response.text);
		}
	}

	// ── Folder operations ─────────────────────────────────────────────

	/**
	 * Create a folder on Google Drive. Returns the folder's file ID.
	 */
	async createFolder(name: string, parentId?: string): Promise<string> {
		const body: Record<string, unknown> = {
			name,
			mimeType: 'application/vnd.google-apps.folder',
		};
		if (parentId) body.parents = [parentId];

		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?fields=id`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { id: string }).id;
	}

	/**
	 * Find a folder by name under a given parent. Returns the folder ID or null.
	 */
	async findFolder(name: string, parentId?: string): Promise<string | null> {
		let q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
		if (parentId) q += ` and '${parentId}' in parents`;

		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		const files = (response.json as { files: DriveFileMetadata[] }).files;
		return files.length > 0 ? files[0]?.id ?? null : null;
	}

	/** List immediate child folders under a parent folder. */
	async listFolders(parentId: string): Promise<DriveFileMetadata[]> {
		const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		const files = (response.json as { files: DriveFileMetadata[] }).files;
		return files.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Ensure a folder path exists (creates intermediate folders as needed).
	 * Returns the leaf folder's ID.
	 */
	async ensureFolderPath(pathSegments: string[], rootFolderId: string): Promise<string> {
		let currentId = rootFolderId;
		for (const segment of pathSegments) {
			if (!segment) continue;
			const existing = await this.findFolderInParent(segment, currentId);
			currentId = existing ?? await this.createFolder(segment, currentId);
		}
		return currentId;
	}

	private async findFolderInParent(name: string, parentId: string): Promise<string | null> {
		const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;

		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		const files = (response.json as { files: { id: string }[] }).files;
		return files[0]?.id ?? null;
	}

	// ── File listing ──────────────────────────────────────────────────

	/**
	 * List all files in a folder (handles pagination automatically).
	 * Uses pageSize=1000 to minimize API calls for large vaults.
	 */
	async listAllFiles(folderId: string): Promise<DriveFileMetadata[]> {
		const results: DriveFileMetadata[] = [];
		let pageToken: string | undefined;

		do {
			const q = `'${folderId}' in parents and trashed=false`;
			const params = new URLSearchParams({
				q,
				fields: `nextPageToken,files(${FILE_FIELDS})`,
				pageSize: '1000',
			});
			if (pageToken) params.set('pageToken', pageToken);

			const response = await this.requestWithAuth(token => ({
				url: `${API_BASE}/files?${params.toString()}`,
				headers: { Authorization: `Bearer ${token}` },
			}));
			this.assertOk(response.status, response.text);

			const data = response.json as { files: DriveFileMetadata[]; nextPageToken?: string };
			results.push(...data.files);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return results;
	}

	/** Backward-compatible alias used by the Phase 1 API checklist. */
	async listFiles(folderId: string, pageToken?: string, pageSize = 1000): Promise<DriveFileMetadata[]> {
		const q = `'${folderId}' in parents and trashed=false`;
		const params = new URLSearchParams({
			q,
			fields: `nextPageToken,files(${FILE_FIELDS})`,
			pageSize: String(pageSize),
		});
		if (pageToken) {
			params.set('pageToken', pageToken);
		}
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { files: DriveFileMetadata[] }).files;
	}

	/**
	 * List trashed files in the vault folder.
	 */
	async listTrashedFiles(folderId: string): Promise<DriveFileMetadata[]> {
		const q = `'${folderId}' in parents and trashed=true`;
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { files: DriveFileMetadata[] }).files;
	}

	/**
	 * List largest files in the vault folder (for storage diagnostics).
	 */
	async listLargestFiles(folderId: string, limit = 20): Promise<DriveFileMetadata[]> {
		const q = `'${folderId}' in parents and trashed=false`;
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files?q=${encodeURIComponent(q)}&orderBy=quotaBytesUsed+desc&pageSize=${limit}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { files: DriveFileMetadata[] }).files;
	}

	// ── Single file metadata ──────────────────────────────────────────

	async getFileMetadata(fileId: string, fields = FILE_FIELDS): Promise<DriveFileMetadata> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}?fields=${encodeURIComponent(fields)}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return response.json as DriveFileMetadata;
	}

	// ── Changes API ───────────────────────────────────────────────────

	/**
	 * Get the initial page token for the Changes API.
	 * Store this and use it for subsequent incremental change queries.
	 */
	async getStartPageToken(): Promise<string> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/changes/startPageToken`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { startPageToken: string }).startPageToken;
	}

	/**
	 * List changes since a given page token.
	 * Returns changed file metadata and the next page token to store.
	 */
	async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken: string; newStartPageToken?: string }> {
		const params = new URLSearchParams({
			pageToken,
			fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
			spaces: 'drive',
		});

		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/changes?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return response.json as { changes: DriveChange[]; nextPageToken: string; newStartPageToken?: string };
	}

	// ── Revisions ────────────────────────────────────────────────────

	/**
	 * List all revisions for a file.
	 */
	async listRevisions(fileId: string): Promise<DriveRevision[]> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}/revisions?fields=revisions(id,modifiedTime,mimeType,size,keepForever)`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return (response.json as { revisions: DriveRevision[] }).revisions ?? [];
	}

	/**
	 * Download a specific revision's content.
	 */
	async downloadRevision(fileId: string, revisionId: string): Promise<ArrayBuffer> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}/revisions/${revisionId}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		return response.arrayBuffer;
	}

	/**
	 * Mark the latest revision of a file as keepForever.
	 * Prevents Google from auto-pruning old revisions.
	 */
	async keepLatestRevisionForever(fileId: string): Promise<void> {
		const revisions = await this.listRevisions(fileId);
		const latest = revisions[revisions.length - 1];
		if (!latest || latest.keepForever) return;

		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/files/${fileId}/revisions/${latest.id}`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ keepForever: true }),
		}));
		this.assertOk(response.status, response.text);
	}

	// ── About / Quota ─────────────────────────────────────────────────

	/**
	 * Get storage usage information for the connected Google account.
	 */
	async getStorageQuota(): Promise<{ used: number; limit: number }> {
		const response = await this.requestWithAuth(token => ({
			url: `${API_BASE}/about?fields=storageQuota`,
			headers: { Authorization: `Bearer ${token}` },
		}));
		this.assertOk(response.status, response.text);
		const quota = (response.json as { storageQuota: { usage: string; limit: string } }).storageQuota;
		return {
			used: parseInt(quota.usage, 10),
			limit: parseInt(quota.limit, 10),
		};
	}

	// ── Upload helpers ────────────────────────────────────────────────

	private async multipartUpload(
		metadata: Record<string, unknown>,
		content: ArrayBuffer,
		mimeType: string
	): Promise<string> {
		// Build multipart/related body manually
		const boundary = `boundary_${Date.now()}`;
		const metadataStr = JSON.stringify(metadata);
		const metadataBytes = new TextEncoder().encode(metadataStr);
		const contentBytes = new Uint8Array(content);

		// Assemble: --boundary\r\nContent-Type: application/json\r\n\r\n<metadata>\r\n--boundary\r\nContent-Type: <mimeType>\r\n\r\n<content>\r\n--boundary--
		const nl = new TextEncoder().encode('\r\n');
		const parts: Uint8Array[] = [
			new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
			metadataBytes,
			nl,
			new TextEncoder().encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
			contentBytes,
			new TextEncoder().encode(`\r\n--${boundary}--`),
		];
		const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
		const body = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of parts) {
			body.set(part, offset);
			offset += part.byteLength;
		}

		const response = await this.requestWithAuth(token => ({
			url: `${UPLOAD_BASE}/files?uploadType=multipart&fields=id`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
			},
			body: body.buffer,
		}));

		this.assertOk(response.status, response.text);
		return (response.json as { id: string }).id;
	}

	private async simplePatchUpload(
		fileId: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<void> {
		const response = await this.requestWithAuth(token => ({
			url: `${UPLOAD_BASE}/files/${fileId}?uploadType=media&fields=id`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': mimeType,
			},
			body: content,
		}));
		this.assertOk(response.status, response.text);
	}

	/**
	 * Resumable upload for large files (> 5 MB).
	 * Supports pause/resume via the GDrive resumable upload protocol.
	 * Returns the uploaded file's ID.
	 */
	private async resumableUpload(
		metadata: Record<string, unknown>,
		content: ArrayBuffer,
		mimeType: string,
		fileId?: string
	): Promise<string> {
		// Step 1: Initiate resumable session
		const initiateUrl = fileId
			? `${UPLOAD_BASE}/files/${fileId}?uploadType=resumable`
			: `${UPLOAD_BASE}/files?uploadType=resumable`;

		const initiateResponse = await this.requestWithAuth(token => ({
			url: initiateUrl,
			method: fileId ? 'PATCH' : 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'X-Upload-Content-Type': mimeType,
				'X-Upload-Content-Length': String(content.byteLength),
			},
			body: JSON.stringify(metadata),
		}));

		if (initiateResponse.status !== 200) {
			this.assertOk(initiateResponse.status, initiateResponse.text);
		}

		const sessionUri = initiateResponse.headers['location'];
		if (!sessionUri) {
			throw new DriveClientError('Resumable upload: no session URI in response');
		}

		// Step 2: Upload content
		const uploadResponse = await requestUrl({
			url: sessionUri,
			method: 'PUT',
			headers: {
				'Content-Length': String(content.byteLength),
				'Content-Type': mimeType,
			},
			body: content,
		});

		this.assertOk(uploadResponse.status, uploadResponse.text);
		const result = uploadResponse.json as { id?: string };
		if (!result.id && fileId) return fileId;
		if (!result.id) throw new DriveClientError('Resumable upload: no file ID in response');
		return result.id;
	}

	private async requestWithAuth(buildRequest: (token: string) => RequestUrlParam): Promise<DriveResponse> {
		const initialToken = await this.auth.getAccessToken();
		let response = await requestUrl(buildRequest(initialToken));
		if (response.status !== 401) {
			return response;
		}

		const refreshedToken = await this.auth.refreshAfterUnauthorized();
		response = await requestUrl(buildRequest(refreshedToken));
		return response;
	}

	// ── Error handling ────────────────────────────────────────────────

	private assertOk(status: number, body: string): void {
		if (status >= 200 && status < 300) return;

		let errorData: { error?: { errors?: { reason?: string; message?: string }[] } } = {};
		try {
			errorData = JSON.parse(body) as typeof errorData;
		} catch {
			// Non-JSON error response
		}

		const reason = errorData.error?.errors?.[0]?.reason;
		const message = errorData.error?.errors?.[0]?.message ?? body;

		if (reason === 'storageQuotaExceeded') {
			throw new StorageQuotaError();
		}

		throw new DriveClientError(`Google Drive API error (${status}): ${message}`, status, reason);
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveChange {
	fileId: string;
	removed: boolean;
	file?: DriveFileMetadata;
}
