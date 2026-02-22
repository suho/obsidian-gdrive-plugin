import { normalizePath } from 'obsidian';

function splitPath(path: string): { dir: string; fileName: string } {
	const normalizedPath = normalizePath(path);
	const slashIndex = normalizedPath.lastIndexOf('/');
	if (slashIndex < 0) {
		return { dir: '', fileName: normalizedPath };
	}
	return {
		dir: normalizedPath.slice(0, slashIndex),
		fileName: normalizedPath.slice(slashIndex + 1),
	};
}

export function stripGeneratedSuffixes(path: string): string {
	const { dir, fileName } = splitPath(path);
	const dotIndex = fileName.lastIndexOf('.');
	let stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
	const ext = dotIndex >= 0 ? fileName.slice(dotIndex) : '';

	let changed = false;
	for (;;) {
		if (stem.endsWith('.remote')) {
			stem = stem.slice(0, -'.remote'.length);
			changed = true;
			continue;
		}
		const conflictMatch = stem.match(/^(.*)\.sync-conflict-\d{8}-\d{6}$/u);
		if (conflictMatch) {
			stem = conflictMatch[1] ?? stem;
			changed = true;
			continue;
		}
		break;
	}

	if (!changed || !stem) {
		stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
	}

	const canonicalName = `${stem}${ext}`;
	return dir ? normalizePath(`${dir}/${canonicalName}`) : normalizePath(canonicalName);
}

export function canonicalPathForGeneratedVariant(path: string): string | null {
	const normalizedPath = normalizePath(path);
	const canonicalPath = stripGeneratedSuffixes(path);
	if (canonicalPath === normalizedPath) {
		return null;
	}
	return canonicalPath;
}

export function isGeneratedArtifactPath(path: string): boolean {
	return canonicalPathForGeneratedVariant(path) !== null;
}
