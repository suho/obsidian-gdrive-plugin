/**
 * Generate a stable UUID v4 for identifying this device in the sync system.
 * Uses the Web Crypto API which is available in all Obsidian environments.
 */
export function generateDeviceId(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);

	// Set version (4) and variant bits per RFC 4122
	array[6] = (array[6]! & 0x0f) | 0x40;
	array[8] = (array[8]! & 0x3f) | 0x80;

	const hex = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
