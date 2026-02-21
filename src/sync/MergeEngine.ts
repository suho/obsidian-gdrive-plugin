import DiffMatchPatch from 'diff-match-patch';
import type { MergeConflictRegion, MergeResult } from '../types';

function countLines(content: string): number {
	if (!content) {
		return 0;
	}
	return content.split('\n').length;
}

function buildConflictRegion(local: string, remote: string): { merged: string; region: MergeConflictRegion } {
	let prefixLength = 0;
	const maxPrefix = Math.min(local.length, remote.length);
	while (prefixLength < maxPrefix && local[prefixLength] === remote[prefixLength]) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	const maxSuffix = Math.min(local.length - prefixLength, remote.length - prefixLength);
	while (
		suffixLength < maxSuffix &&
		local[local.length - 1 - suffixLength] === remote[remote.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	const prefix = local.slice(0, prefixLength);
	const suffix = suffixLength > 0 ? local.slice(local.length - suffixLength) : '';
	const localMiddle = local.slice(prefixLength, local.length - suffixLength);
	const remoteMiddle = remote.slice(prefixLength, remote.length - suffixLength);

	const marker = [
		'<<<<<<< LOCAL',
		localMiddle,
		'=======',
		remoteMiddle,
		'>>>>>>> REMOTE',
	].join('\n');

	const startLine = countLines(prefix) + 1;
	const endLine = startLine + countLines(marker) - 1;

	return {
		merged: `${prefix}${marker}${suffix}`,
		region: {
			startLine,
			endLine,
			localText: localMiddle,
			remoteText: remoteMiddle,
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === '[object Object]';
}

function deepMergeValue(remoteValue: unknown, localValue: unknown): unknown {
	if (typeof localValue === 'undefined') {
		return remoteValue;
	}

	if (Array.isArray(remoteValue) && Array.isArray(localValue)) {
		return Array.from(localValue as unknown[]);
	}

	if (isPlainObject(remoteValue) && isPlainObject(localValue)) {
		const merged: Record<string, unknown> = { ...remoteValue };
		for (const [key, localChild] of Object.entries(localValue)) {
			merged[key] = deepMergeValue(remoteValue[key], localChild);
		}
		return merged;
	}

	return localValue;
}

export class MergeEngine {
	private readonly dmp = new DiffMatchPatch();

	threeWayMerge(base: string, local: string, remote: string): MergeResult {
		if (local === remote) {
			return {
				merged: local,
				hasConflicts: false,
				conflictCount: 0,
				conflictRegions: [],
			};
		}

		if (local === base) {
			return {
				merged: remote,
				hasConflicts: false,
				conflictCount: 0,
				conflictRegions: [],
			};
		}

		if (remote === base) {
			return {
				merged: local,
				hasConflicts: false,
				conflictCount: 0,
				conflictRegions: [],
			};
		}

		const localPatches = this.dmp.patch_make(base, local);
		const remotePatches = this.dmp.patch_make(base, remote);
		const [localThenRemote, remoteApplied] = this.dmp.patch_apply(remotePatches, local);
		const [remoteThenLocal, localApplied] = this.dmp.patch_apply(localPatches, remote);

		const allRemoteApplied = remoteApplied.every(applied => applied);
		const allLocalApplied = localApplied.every(applied => applied);

		if (allRemoteApplied && allLocalApplied && localThenRemote === remoteThenLocal) {
			return {
				merged: localThenRemote,
				hasConflicts: false,
				conflictCount: 0,
				conflictRegions: [],
			};
		}

		const conflict = buildConflictRegion(local, remote);
		return {
			merged: conflict.merged,
			hasConflicts: true,
			conflictCount: 1,
			conflictRegions: [conflict.region],
		};
	}

	deepMergeJson(localJson: string, remoteJson: string): string | null {
		try {
			const local = JSON.parse(localJson) as unknown;
			const remote = JSON.parse(remoteJson) as unknown;
			const merged = deepMergeValue(remote, local);
			return `${JSON.stringify(merged, null, 2)}\n`;
		} catch {
			return null;
		}
	}
}
