// Core sync state for a single file tracked in sync-db.json
export interface SyncRecord {
	gDriveFileId: string;
	localPath: string;
	localHash: string;       // MD5 of local content at last sync
	remoteHash: string;      // MD5 from GDrive at last sync
	lastSyncedTimestamp: number; // Unix ms
	status: SyncStatus;
}

export type SyncStatus = 'synced' | 'pending-push' | 'pending-pull' | 'conflict';

// Queued local change waiting to be pushed
export interface SyncQueueEntry {
	action: 'create' | 'update' | 'delete' | 'rename';
	path: string;
	oldPath?: string;        // only for rename
	localHash?: string;
	timestamp: number;
	retryCount: number;
}

// A resolved or detected conflict between local and remote
export interface ConflictInfo {
	path: string;
	localHash: string;
	remoteHash: string;
	baseHash: string;        // hash of last synced (base) version
	localModified: number;   // Unix ms
	remoteModified: number;  // Unix ms
	resolution?: ConflictResolution;
}

export type ConflictResolution =
	| 'auto-merge'
	| 'conflict-file'
	| 'local-wins'
	| 'remote-wins'
	| 'keep-both';

// A single entry in the sync activity log
export interface ActivityLogEntry {
	id: string;              // UUID
	timestamp: number;       // Unix ms
	action: ActivityAction;
	path: string;
	detail?: string;         // e.g. "Merged 3 chunks cleanly"
	error?: string;
}

export type ActivityAction =
	| 'pushed'
	| 'pulled'
	| 'merged'
	| 'conflict'
	| 'deleted'
	| 'restored'
	| 'error'
	| 'skipped';

// GDrive file metadata as returned by the API
export interface DriveFileMetadata {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;    // ISO 8601
	md5Checksum?: string;
	size?: string;           // string because Google returns large ints as strings
	parents?: string[];
	trashed?: boolean;
}

// GDrive revision metadata
export interface DriveRevision {
	id: string;
	modifiedTime: string;
	mimeType: string;
	size?: string;
	keepForever?: boolean;
}

export interface MergeConflictRegion {
	startLine: number;
	endLine: number;
	localText: string;
	remoteText: string;
}

// Result of a three-way merge
export interface MergeResult {
	merged: string;
	hasConflicts: boolean;
	conflictCount: number;
	conflictRegions: MergeConflictRegion[];
}

// Sync engine state snapshot
export type SyncState =
	| 'idle'
	| 'syncing'
	| 'pending'
	| 'offline'
	| 'error'
	| 'conflict'
	| 'paused';
