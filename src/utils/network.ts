interface ConnectionLike {
	type?: string;
	effectiveType?: string;
}

interface NavigatorWithConnection extends Navigator {
	connection?: ConnectionLike;
	mozConnection?: ConnectionLike;
	webkitConnection?: ConnectionLike;
}

export interface OnlineCheckOptions {
	wifiOnly?: boolean;
	ping?: () => Promise<void>;
}

function getConnection(): ConnectionLike | undefined {
	const withConnection = navigator as NavigatorWithConnection;
	return withConnection.connection ?? withConnection.mozConnection ?? withConnection.webkitConnection;
}

export function isWifiConnection(): boolean | null {
	const connection = getConnection();
	if (!connection) {
		return null;
	}

	const normalizedType = connection.type?.toLowerCase();
	if (normalizedType === 'wifi' || normalizedType === 'ethernet') {
		return true;
	}
	if (normalizedType === 'cellular') {
		return false;
	}

	const effectiveType = connection.effectiveType?.toLowerCase();
	if (effectiveType && /(?:^|-)g$/u.test(effectiveType)) {
		return false;
	}

	return null;
}

export function shouldSyncOnCurrentNetwork(wifiOnly: boolean): boolean {
	if (!wifiOnly) {
		return true;
	}
	const wifiState = isWifiConnection();
	return wifiState !== false;
}

export async function isOnline(options?: OnlineCheckOptions): Promise<boolean> {
	if (!navigator.onLine) {
		return false;
	}

	if (!shouldSyncOnCurrentNetwork(options?.wifiOnly ?? false)) {
		return false;
	}

	if (!options?.ping) {
		return true;
	}

	try {
		await options.ping();
		return true;
	} catch {
		return false;
	}
}
