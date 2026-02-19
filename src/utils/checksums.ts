function bytesToHex(bytes: Uint8Array): string {
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

/**
 * Returns a stable content hash for sync bookkeeping.
 * SHA-256 is used for broad Web Crypto compatibility.
 */
export async function computeContentHash(content: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', content);
	return bytesToHex(new Uint8Array(digest));
}
