function normalize(value: string): string {
	return value.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+/gu, '/');
}

export function isHardExcluded(path: string): boolean {
	const normalized = normalize(path);
	const lower = normalized.toLowerCase();

	if (lower === '.ds_store' || lower.endsWith('/.ds_store')) return true;
	if (lower === 'thumbs.db' || lower.endsWith('/thumbs.db')) return true;

	return false;
}

export function isExcluded(path: string): boolean {
	return isHardExcluded(path);
}
