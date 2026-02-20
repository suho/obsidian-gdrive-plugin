import type { GDrivePluginSettings } from '../settings';

export type FileCategory = 'image' | 'audio' | 'video' | 'pdf' | 'other';

type SelectiveSettings = Pick<
	GDrivePluginSettings,
	| 'syncImages'
	| 'syncAudio'
	| 'syncVideo'
	| 'syncPdfs'
	| 'syncOtherTypes'
	| 'syncEditorSettings'
	| 'syncAppearance'
	| 'syncHotkeys'
	| 'syncCommunityPluginList'
>;

const IMAGE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff',
]);
const AUDIO_EXTENSIONS = new Set([
	'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus',
]);
const VIDEO_EXTENSIONS = new Set([
	'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
]);

function normalize(value: string): string {
	return value.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+/gu, '/');
}

function normalizePrefix(value: string): string {
	const normalized = normalize(value);
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function extensionFor(path: string): string {
	const fileName = path.split('/').pop() ?? path;
	const dotIndex = fileName.lastIndexOf('.');
	if (dotIndex < 0) return '';
	return fileName.slice(dotIndex + 1).toLowerCase();
}

function isWithinConfigDir(path: string, configDir: string): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
}

function isAllowedVaultConfigPath(relativePath: string, settings: SelectiveSettings): boolean {
	if (relativePath === 'app.json') return settings.syncEditorSettings;
	if (relativePath === 'appearance.json') return settings.syncAppearance;
	if (relativePath === 'hotkeys.json') return settings.syncHotkeys;
	if (relativePath === 'community-plugins.json') return settings.syncCommunityPluginList;
	if (relativePath.startsWith('themes/') || relativePath.startsWith('snippets/')) return settings.syncAppearance;
	return false;
}

export function classifyFileType(path: string): FileCategory {
	const ext = extensionFor(path);
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
	if (VIDEO_EXTENSIONS.has(ext)) return 'video';
	if (ext === 'pdf') return 'pdf';
	return 'other';
}

export function isHardExcluded(path: string, configDir: string): boolean {
	const normalized = normalize(path);
	const lower = normalized.toLowerCase();
	const normalizedConfigDir = normalizePrefix(configDir);
	const configDirLower = normalizedConfigDir.toLowerCase();

	if (lower === '.ds_store' || lower.endsWith('/.ds_store')) return true;
	if (lower === 'thumbs.db' || lower.endsWith('/thumbs.db')) return true;

	if (lower === '.git' || lower.startsWith('.git/')) return true;
	if (lower === '.trash' || lower.startsWith('.trash/')) return true;
	if (lower === 'node_modules' || lower.startsWith('node_modules/')) return true;

	if (lower === `${configDirLower}/cache` || lower.startsWith(`${configDirLower}/cache/`)) return true;
	if (lower === `${configDirLower}/workspace.json`) return true;
	if (lower === `${configDirLower}/workspace-mobile.json`) return true;
	if (lower.startsWith(`${configDirLower}/plugins/`) && lower.endsWith('/main.js')) return true;

	const segments = normalized.split('/');
	const configDirSegments = normalizedConfigDir.split('/');
	const withinConfigDir = isWithinConfigDir(normalized, normalizedConfigDir);
	for (const [index, segment] of segments.entries()) {
		if (!segment.startsWith('.')) continue;
		if (withinConfigDir && segment === (configDirSegments[index] ?? '')) continue;
		if (segment === '.' || segment === '..') continue;
		// Dot-prefixed folders/files are excluded except for the vault config directory.
		if (index < segments.length - 1 || !segment.includes('.')) {
			return true;
		}
	}

	return false;
}

function matchesUserExclusion(path: string, rawExclusion: string): boolean {
	const normalizedPath = normalize(path);
	const exclusion = normalizePrefix(rawExclusion);
	if (!exclusion) return false;
	return normalizedPath === exclusion || normalizedPath.startsWith(`${exclusion}/`);
}

function isTypeExcluded(path: string, settings: SelectiveSettings): boolean {
	const type = classifyFileType(path);
	if (type === 'image' && !settings.syncImages) return true;
	if (type === 'audio' && !settings.syncAudio) return true;
	if (type === 'video' && !settings.syncVideo) return true;
	if (type === 'pdf' && !settings.syncPdfs) return true;
	if (type === 'other' && !settings.syncOtherTypes) return true;
	return false;
}

function isVaultConfigExcluded(path: string, settings: SelectiveSettings, configDir: string): boolean {
	const normalizedPath = normalize(path);
	const normalizedConfigDir = normalizePrefix(configDir);
	if (!isWithinConfigDir(normalizedPath, normalizedConfigDir)) {
		return false;
	}

	const relativePath = normalizedPath.slice(normalizedConfigDir.length + 1);
	return !isAllowedVaultConfigPath(relativePath, settings);
}

export function isExcluded(
	path: string,
	userExclusions: string[],
	settings: SelectiveSettings,
	configDir: string
): boolean {
	const normalizedPath = normalize(path);
	const normalizedConfigDir = normalizePrefix(configDir);

	if (isHardExcluded(path, configDir)) return true;
	if (userExclusions.some(exclusion => matchesUserExclusion(normalizedPath, exclusion))) return true;
	if (isWithinConfigDir(normalizedPath, normalizedConfigDir)) {
		return isVaultConfigExcluded(normalizedPath, settings, normalizedConfigDir);
	}
	if (isTypeExcluded(normalizedPath, settings)) return true;
	return false;
}
