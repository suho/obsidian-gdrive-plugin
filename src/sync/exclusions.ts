import type { GDrivePluginSettings } from '../settings';
import { isGeneratedArtifactPath } from './generatedArtifacts';

export type FileCategory = 'image' | 'audio' | 'video' | 'pdf' | 'other';
export type ExclusionReason =
	| 'hard-excluded'
	| 'excluded-folder'
	| 'vault-config-disabled'
	| 'type-disabled'
	| 'file-too-large';
export type UserAdjustableSkipReason = 'selective-sync-disabled' | 'max-file-size' | 'excluded-folders';

export interface UserAdjustableSkipCounts {
	selectiveSyncDisabled: number;
	maxFileSize: number;
	excludedFolders: number;
}

type SelectiveSettings = Pick<
	GDrivePluginSettings,
	| 'syncImages'
	| 'syncAudio'
	| 'syncVideo'
	| 'syncPdfs'
	| 'syncOtherTypes'
	| 'maxFileSizeBytes'
	| 'syncEditorSettings'
	| 'syncAppearance'
	| 'syncHotkeys'
	| 'syncCommunityPluginList'
	| 'syncCorePluginSettings'
	| 'syncCommunityPluginFiles'
>;

export interface ExclusionDescriptionContext {
	userExclusions?: string[];
	settings?: SelectiveSettings;
	fileSizeBytes?: number;
}

const IMAGE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff',
]);
const AUDIO_EXTENSIONS = new Set([
	'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus',
]);
const VIDEO_EXTENSIONS = new Set([
	'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
]);
const CORE_PLUGIN_SETTINGS_FILES = new Set([
	'core-plugins.json',
	'daily-notes.json',
	'templates.json',
	'types.json',
	'zk-prefixer.json',
]);
const COMMUNITY_PLUGIN_SYNC_FILES = new Set([
	'manifest.json',
	'data.json',
	'styles.css',
	'main.js',
]);

export function emptyUserAdjustableSkipCounts(): UserAdjustableSkipCounts {
	return {
		selectiveSyncDisabled: 0,
		maxFileSize: 0,
		excludedFolders: 0,
	};
}

export function mergeUserAdjustableSkipCounts(
	target: UserAdjustableSkipCounts,
	source: UserAdjustableSkipCounts
): UserAdjustableSkipCounts {
	target.selectiveSyncDisabled += source.selectiveSyncDisabled;
	target.maxFileSize += source.maxFileSize;
	target.excludedFolders += source.excludedFolders;
	return target;
}

export function totalUserAdjustableSkipCounts(counts: UserAdjustableSkipCounts): number {
	return counts.selectiveSyncDisabled + counts.maxFileSize + counts.excludedFolders;
}

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

function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function isWithinConfigDir(path: string, configDir: string): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
}

function relativeConfigPath(path: string, configDir: string): string | null {
	const normalizedPath = normalize(path);
	const normalizedConfigDir = normalizePrefix(configDir);
	if (!isWithinConfigDir(normalizedPath, normalizedConfigDir)) {
		return null;
	}
	return normalizedPath.slice(normalizedConfigDir.length + 1);
}

function isCorePluginSettingsPath(relativePath: string): boolean {
	return CORE_PLUGIN_SETTINGS_FILES.has(relativePath);
}

function isCommunityPluginAssetPath(relativePath: string): boolean {
	const segments = relativePath.split('/');
	if (segments.length !== 3) return false;
	if (segments[0] !== 'plugins') return false;
	if (!segments[1]) return false;
	return COMMUNITY_PLUGIN_SYNC_FILES.has(segments[2] ?? '');
}

function isAllowedVaultConfigPath(relativePath: string, settings: SelectiveSettings): boolean {
	if (relativePath === 'app.json') return settings.syncEditorSettings;
	if (relativePath === 'appearance.json') return settings.syncAppearance;
	if (relativePath === 'hotkeys.json') return settings.syncHotkeys;
	if (relativePath === 'community-plugins.json') return settings.syncCommunityPluginList;
	if (isCorePluginSettingsPath(relativePath)) return settings.syncCorePluginSettings;
	if (isCommunityPluginAssetPath(relativePath)) return settings.syncCommunityPluginFiles;
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

	if (isGeneratedArtifactPath(normalized)) return true;

	if (lower === '.ds_store' || lower.endsWith('/.ds_store')) return true;
	if (lower === 'thumbs.db' || lower.endsWith('/thumbs.db')) return true;

	if (lower === '.git' || lower.startsWith('.git/')) return true;
	if (lower === '.trash' || lower.startsWith('.trash/')) return true;
	if (lower === 'node_modules' || lower.startsWith('node_modules/')) return true;

	if (lower === `${configDirLower}/cache` || lower.startsWith(`${configDirLower}/cache/`)) return true;
	if (lower === `${configDirLower}/workspace.json`) return true;
	if (lower === `${configDirLower}/workspace-mobile.json`) return true;
	if (lower.includes('/plugins/') && lower.includes('/snapshots/')) return true;

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

function matchedUserExclusion(path: string, userExclusions: string[]): string | null {
	const normalizedPath = normalize(path);
	let bestMatch = '';
	for (const exclusion of userExclusions) {
		const normalizedExclusion = normalizePrefix(exclusion);
		if (!normalizedExclusion) {
			continue;
		}
		if (
			(normalizedPath === normalizedExclusion || normalizedPath.startsWith(`${normalizedExclusion}/`)) &&
			normalizedExclusion.length > bestMatch.length
		) {
			bestMatch = normalizedExclusion;
		}
	}
	return bestMatch || null;
}

function typeExclusionReason(path: string, settings: SelectiveSettings): ExclusionReason | null {
	const type = classifyFileType(path);
	if (type === 'image' && !settings.syncImages) return 'type-disabled';
	if (type === 'audio' && !settings.syncAudio) return 'type-disabled';
	if (type === 'video' && !settings.syncVideo) return 'type-disabled';
	if (type === 'pdf' && !settings.syncPdfs) return 'type-disabled';
	if (type === 'other' && !settings.syncOtherTypes) return 'type-disabled';
	return null;
}

function isOverMaxFileSize(fileSizeBytes: number | undefined, settings: SelectiveSettings): boolean {
	if (typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
		return false;
	}
	return fileSizeBytes > settings.maxFileSizeBytes;
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

export function getExclusionReason(
	path: string,
	userExclusions: string[],
	settings: SelectiveSettings,
	configDir: string,
	fileSizeBytes?: number
): ExclusionReason | null {
	const normalizedPath = normalize(path);
	const normalizedConfigDir = normalizePrefix(configDir);

	if (isHardExcluded(path, configDir)) return 'hard-excluded';
	if (userExclusions.some(exclusion => matchesUserExclusion(normalizedPath, exclusion))) return 'excluded-folder';
	if (isWithinConfigDir(normalizedPath, normalizedConfigDir)) {
		return isVaultConfigExcluded(normalizedPath, settings, normalizedConfigDir)
			? 'vault-config-disabled'
			: null;
	}
	const typeReason = typeExclusionReason(normalizedPath, settings);
	if (typeReason) return typeReason;
	if (isOverMaxFileSize(fileSizeBytes, settings)) return 'file-too-large';
	return null;
}

export function toUserAdjustableSkipReason(reason: ExclusionReason): UserAdjustableSkipReason | null {
	if (reason === 'excluded-folder') return 'excluded-folders';
	if (reason === 'file-too-large') return 'max-file-size';
	if (reason === 'type-disabled' || reason === 'vault-config-disabled') return 'selective-sync-disabled';
	return null;
}

export function describeUserAdjustableExclusionReason(
	path: string,
	reason: ExclusionReason,
	configDir: string,
	context: ExclusionDescriptionContext = {}
): string | null {
	if (reason === 'excluded-folder') {
		const matchedExclusion = context.userExclusions ? matchedUserExclusion(path, context.userExclusions) : null;
		if (matchedExclusion) {
			return `Path matches excluded folder "${matchedExclusion}".`;
		}
		return 'Path matches an excluded folder rule.';
	}
	if (reason === 'file-too-large') {
		const maxSizeBytes = context.settings?.maxFileSizeBytes;
		const fileSizeBytes = context.fileSizeBytes;
		if (
			typeof fileSizeBytes === 'number' &&
			fileSizeBytes > 0 &&
			typeof maxSizeBytes === 'number' &&
			maxSizeBytes > 0
		) {
			return `File size is ${formatByteSize(fileSizeBytes)} and exceeds the max file size of ${formatByteSize(maxSizeBytes)}.`;
		}
		if (typeof maxSizeBytes === 'number' && maxSizeBytes > 0) {
			return `File is larger than the max file size setting (${formatByteSize(maxSizeBytes)}).`;
		}
		return 'File is larger than the max file size setting.';
	}
	if (reason === 'type-disabled') {
		const type = classifyFileType(path);
		const extension = extensionFor(path);
		if (type === 'image') {
			return extension
				? `Image file type (.${extension}) is disabled by Sync images.`
				: 'Image file sync is disabled by Sync images.';
		}
		if (type === 'audio') {
			return extension
				? `Audio file type (.${extension}) is disabled by Sync audio.`
				: 'Audio file sync is disabled by Sync audio.';
		}
		if (type === 'video') {
			return extension
				? `Video file type (.${extension}) is disabled by Sync video.`
				: 'Video file sync is disabled by Sync video.';
		}
		if (type === 'pdf') {
			return 'PDF files are disabled by Sync PDF files.';
		}
		return extension
			? `File type (.${extension}) is disabled by Sync other file types.`
			: 'Files without a known media type are disabled by Sync other file types.';
	}
	if (reason === 'vault-config-disabled') {
		const relativePath = relativeConfigPath(path, configDir);
		const normalizedConfigDir = normalizePrefix(configDir);
		const configPathLabel = relativePath ? `${normalizedConfigDir}/${relativePath}` : normalize(path);
		if (relativePath === 'app.json') {
			return `Vault config file "${configPathLabel}" is disabled by Sync editor settings.`;
		}
		if (relativePath === 'appearance.json') {
			return `Vault config file "${configPathLabel}" is disabled by Sync appearance.`;
		}
		if (relativePath === 'hotkeys.json') {
			return `Vault config file "${configPathLabel}" is disabled by Sync hotkeys.`;
		}
		if (relativePath === 'community-plugins.json') {
			return `Vault config file "${configPathLabel}" is disabled by Sync community plugin list.`;
		}
		if (relativePath && isCorePluginSettingsPath(relativePath)) {
			return `Vault config file "${configPathLabel}" is disabled by Sync core plugin settings.`;
		}
		if (relativePath && isCommunityPluginAssetPath(relativePath)) {
			return `Vault config file "${configPathLabel}" is disabled by Sync community plugin files.`;
		}
		if (relativePath?.startsWith('themes/') || relativePath?.startsWith('snippets/')) {
			return `Vault config path "${configPathLabel}" is disabled by Sync appearance.`;
		}
		return `Vault config path "${configPathLabel}" is disabled by vault configuration sync settings.`;
	}
	return null;
}

export function addUserAdjustableSkipCount(counts: UserAdjustableSkipCounts, reason: ExclusionReason): void {
	const mapped = toUserAdjustableSkipReason(reason);
	if (!mapped) {
		return;
	}
	if (mapped === 'selective-sync-disabled') {
		counts.selectiveSyncDisabled += 1;
		return;
	}
	if (mapped === 'max-file-size') {
		counts.maxFileSize += 1;
		return;
	}
	counts.excludedFolders += 1;
}

export function isExcluded(
	path: string,
	userExclusions: string[],
	settings: SelectiveSettings,
	configDir: string,
	fileSizeBytes?: number
): boolean {
	return getExclusionReason(path, userExclusions, settings, configDir, fileSizeBytes) !== null;
}
