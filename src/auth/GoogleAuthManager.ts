import { Notice, Platform, requestUrl, type RequestUrlResponse } from 'obsidian';
import type GDriveSyncPlugin from '../main';

// Google OAuth endpoints
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Required scope: access only files created by this plugin
const SCOPE = [
	'https://www.googleapis.com/auth/drive.file',
	'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// Mobile URI scheme for OAuth callback
const MOBILE_REDIRECT_URI = 'obsidian://gdrive-callback';

// Refresh access token this many ms before expiry (5 minutes)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MOBILE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_RETRY_COUNT = 2;
const REFRESH_RETRY_BASE_MS = 1000;
const SESSION_OAUTH_STATE_KEY = 'gdrive_oauth_state';

export class GoogleAuthManager {
	// In-memory access token (not persisted — reconstructed from refresh token on load)
	private accessToken = '';
	// Refresh timer handle
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private reauthNotice: Notice | null = null;
	private mobileAuthWaiter: {
		resolve: () => void;
		reject: (error: Error) => void;
		timeoutId: ReturnType<typeof setTimeout>;
	} | null = null;

	constructor(
		private readonly plugin: GDriveSyncPlugin
	) {
		if (this.plugin.settings.needsReauthentication) {
			this.showReauthenticateNotice();
		}
	}

	/** True if we have a refresh token (i.e., the user has authenticated). */
	get isAuthenticated(): boolean {
		return !!this.plugin.settings.refreshToken;
	}

	get hasOAuthClientConfigured(): boolean {
		return !!this.getClientId();
	}

	async saveOAuthClientCredentials(clientId: string, clientSecret: string): Promise<void> {
		this.plugin.settings.oauthClientId = clientId.trim();
		this.plugin.settings.oauthClientSecret = clientSecret.trim();
		await this.plugin.saveSettings();
	}

	/** Returns a valid access token, refreshing if necessary. */
	async getAccessToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.plugin.settings.tokenExpiry - REFRESH_BUFFER_MS) {
			return this.accessToken;
		}
		await this.refreshAccessToken();
		return this.accessToken;
	}

	/**
	 * Start the full OAuth flow appropriate for the current platform.
	 * Desktop: opens browser → localhost callback server
	 * Mobile:  opens system browser → obsidian:// URI scheme
	 */
	async authenticate(): Promise<void> {
		if (!this.getClientId()) {
			throw new Error(
				'Google OAuth client ID is not configured. ' +
				'Open setup and enter OAuth client credentials first.'
			);
		}

		const state = this.generateState();

		if (Platform.isMobile) {
			await this.authenticateMobile(state);
		} else {
			await this.authenticateDesktop(state);
		}
	}

	/** Revoke the current refresh token and clear stored credentials. */
	async signOut(): Promise<void> {
		if (this.plugin.settings.refreshToken) {
			try {
				await requestUrl({
					url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(this.plugin.settings.refreshToken)}`,
					method: 'POST',
				});
			} catch {
				// Ignore revocation errors — clear credentials regardless
			}
		}
		this.accessToken = '';
		this.clearRefreshTimer();
		this.plugin.settings.refreshToken = '';
		this.plugin.settings.tokenExpiry = 0;
		this.plugin.settings.connectedEmail = '';
		this.plugin.settings.needsReauthentication = false;
		this.plugin.settings.gDriveFolderId = '';
		this.plugin.settings.gDriveFolderName = '';
		this.plugin.settings.lastSyncPageToken = '';
		this.plugin.settings.setupComplete = false;
		this.plugin.settings.pendingOAuthState = '';
		this.clearSessionMobileAuthData();
		this.rejectMobileAuthWaiter(new Error('Authentication was cancelled.'));
		this.clearReauthenticateNotice();
		await this.plugin.saveSettings();
		this.plugin.refreshSettingTab();
	}

	/** Import a refresh token from another device and initialize session state. */
	async importRefreshToken(refreshToken: string): Promise<void> {
		if (!this.getClientId()) {
			throw new Error(
				'Google OAuth client ID is not configured. ' +
				'Enter OAuth client credentials in plugin settings first.'
			);
		}

		const normalizedToken = refreshToken.trim();
		if (!normalizedToken) {
			throw new Error('Enter a refresh token first.');
		}

		const response = await this.requestRefreshGrant(normalizedToken);
		const oauthError = this.getOAuthErrorResponse(response);

		if (response.status === 400 || response.status === 401) {
			if (oauthError.error === 'invalid_grant') {
				throw new AuthError('Invalid refresh token. Paste the full token and try again.');
			}
		}

		if (response.status !== 200) {
			throw new AuthError(this.describeTokenEndpointError('Token refresh', response, oauthError));
		}

		this.plugin.settings.refreshToken = normalizedToken;
		this.plugin.settings.needsReauthentication = false;
		const data = response.json as TokenResponse;
		await this.storeTokens(data);
		await this.fetchAndStoreEmail();
		this.plugin.refreshSettingTab();
	}

	// ── Desktop flow ──────────────────────────────────────────────────

	private async authenticateDesktop(
		state: string
	): Promise<void> {
		// Load desktop-only callback server lazily so mobile can run without Node built-ins.
		const { OAuthCallbackServer } = await import('./OAuthCallbackServer');
		const callbackServer = new OAuthCallbackServer();
		const redirectUri = await callbackServer.start();

		const authUrl = this.buildAuthUrl(state, redirectUri);

		// Open the browser
		window.open(authUrl);

		new Notice('Complete authentication in your browser, then return to Obsidian.');

		const { code, state: returnedState } = await callbackServer.waitForCallback();

		if (returnedState !== state) {
			throw new Error('OAuth state mismatch — possible CSRF attack');
		}

		await this.exchangeCode(code, redirectUri);
	}

	// ── Mobile flow ───────────────────────────────────────────────────

	private async authenticateMobile(state: string): Promise<void> {
		const authUrl = this.buildAuthUrl(state, MOBILE_REDIRECT_URI, {
			forceAccountChooser: true,
		});
		await this.savePendingMobileAuthData(state);
		const waitForCallback = this.waitForMobileCallback();

		window.open(authUrl);

		new Notice('Complete authentication in your browser, then return to Obsidian.');
		await waitForCallback;
	}

	/**
	 * Handle the mobile callback from the obsidian:// URI scheme.
	 * Called by main.ts when Obsidian receives obsidian://gdrive-callback
	 */
	async handleMobileCallback(params: URLSearchParams): Promise<void> {
		const code = params.get('code');
		const returnedState = params.get('state');
		const error = params.get('error');

		if (error) {
			await this.clearPendingMobileAuthData();
			const authError = new Error(`Google OAuth error: ${error}`);
			this.rejectMobileAuthWaiter(authError);
			throw authError;
		}

		if (!code || !returnedState) {
			await this.clearPendingMobileAuthData();
			const callbackError = new Error('Missing code or state in OAuth callback');
			this.rejectMobileAuthWaiter(callbackError);
			throw callbackError;
		}

		const expectedState = this.getPendingMobileAuthState();
		await this.clearPendingMobileAuthData();

		if (returnedState !== expectedState) {
			const stateError = new Error('OAuth state mismatch — possible CSRF attack');
			this.rejectMobileAuthWaiter(stateError);
			throw stateError;
		}

		try {
			await this.exchangeCode(code, MOBILE_REDIRECT_URI);
		} catch (err) {
			const authError = err instanceof Error ? err : new Error(String(err));
			this.rejectMobileAuthWaiter(authError);
			throw authError;
		}

		this.resolveMobileAuthWaiter();
	}

	// ── Token exchange ────────────────────────────────────────────────

	private async exchangeCode(code: string, redirectUri: string): Promise<void> {
		const clientId = this.getClientId();
		const body = new URLSearchParams({
			code,
			client_id: clientId,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
		});
		this.appendClientSecret(body);

		const response = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			throw: false,
			body: body.toString(),
		});

		if (response.status !== 200) {
			throw new AuthError(this.describeTokenEndpointError('Token exchange', response));
		}

		const data = response.json as TokenResponse;
		await this.storeTokens(data);
		await this.fetchAndStoreEmail();
	}

	private async refreshAccessToken(): Promise<void> {
		if (!this.plugin.settings.refreshToken) {
			throw new AuthError('No refresh token — user must re-authenticate');
		}

		let response;
		try {
			response = await this.requestRefreshGrantWithRetry(this.plugin.settings.refreshToken);
		} catch (err) {
			if (err instanceof AuthError) {
				throw err;
			}
			throw new AuthError('Network error during token refresh. Please retry.');
		}
		const oauthError = this.getOAuthErrorResponse(response);

		if (response.status === 400 || response.status === 401) {
			if (oauthError.error === 'invalid_grant') {
				// Refresh token has been revoked or expired
				this.accessToken = '';
				this.plugin.settings.refreshToken = '';
				this.plugin.settings.tokenExpiry = 0;
				this.plugin.settings.connectedEmail = '';
				this.plugin.settings.needsReauthentication = true;
				await this.plugin.saveSettings();
				this.plugin.refreshSettingTab();
				this.showReauthenticateNotice();
				throw new AuthError(
					'Google account connection lost. Please re-authenticate in plugin settings.'
				);
			}
		}

		if (response.status !== 200) {
			throw new AuthError(this.describeTokenEndpointError('Token refresh', response, oauthError));
		}

		const data = response.json as TokenResponse;
		await this.storeTokens(data);
	}

	private async requestRefreshGrantWithRetry(refreshToken: string): Promise<Awaited<ReturnType<typeof requestUrl>>> {
		let lastError: unknown = null;

		for (let attempt = 0; attempt <= REFRESH_RETRY_COUNT; attempt += 1) {
			try {
				const response = await this.requestRefreshGrant(refreshToken);
				if (response.status >= 500 && attempt < REFRESH_RETRY_COUNT) {
					await this.sleep(Math.pow(2, attempt) * REFRESH_RETRY_BASE_MS);
					continue;
				}
				return response;
			} catch (err) {
				lastError = err;
				if (attempt >= REFRESH_RETRY_COUNT) {
					break;
				}
				await this.sleep(Math.pow(2, attempt) * REFRESH_RETRY_BASE_MS);
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new AuthError('Token refresh failed');
	}

	private async sleep(ms: number): Promise<void> {
		await new Promise<void>(resolve => {
			window.setTimeout(resolve, ms);
		});
	}

	private async requestRefreshGrant(refreshToken: string): Promise<Awaited<ReturnType<typeof requestUrl>>> {
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: this.getClientId(),
		});
		this.appendClientSecret(body);

		return requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			throw: false,
			body: body.toString(),
		});
	}

	private getOAuthErrorResponse(response: RequestUrlResponse): OAuthErrorResponse {
		if (isObjectRecord(response.json)) {
			return response.json as OAuthErrorResponse;
		}

		try {
			const parsed = JSON.parse(response.text) as unknown;
			return isObjectRecord(parsed) ? parsed as OAuthErrorResponse : {};
		} catch {
			return {};
		}
	}

	private describeTokenEndpointError(
		action: string,
		response: RequestUrlResponse,
		oauthError: OAuthErrorResponse = this.getOAuthErrorResponse(response)
	): string {
		const details: string[] = [];
		if (oauthError.error) {
			details.push(`OAuth error: ${oauthError.error}.`);
		}
		if (oauthError.error_description) {
			details.push(`Details: ${oauthError.error_description}.`);
		}

		const guidance = this.getOAuthGuidance(oauthError);
		if (guidance) {
			details.push(guidance);
		}

		if (details.length === 0) {
			details.push(`Request failed with status ${response.status}.`);
		}

		return `${action} failed (${response.status}). ${details.join(' ')}`;
	}

	private getOAuthGuidance(oauthError: OAuthErrorResponse): string {
		switch (oauthError.error) {
			case 'invalid_client':
			case 'unauthorized_client':
				return (
					'Verify the OAuth client ID and client secret in plugin settings. ' +
					'Google rejected the client credentials for this request.'
				);
			case 'invalid_grant':
				return (
					'The authorization code or refresh token is invalid or expired. ' +
					'Retry sign-in and confirm your system clock is correct.'
				);
			case 'redirect_uri_mismatch':
				return 'The redirect URI does not match this OAuth client configuration.';
			case 'invalid_request':
				if (oauthError.error_description?.toLowerCase().includes('client_secret')) {
					return (
						'Google reported that a client secret is required. ' +
						'Add OAuth client secret in setup or plugin settings and retry.'
					);
				}
				return '';
			default:
				return '';
		}
	}

	private getClientId(): string {
		return this.plugin.settings.oauthClientId.trim();
	}

	private getClientSecret(): string {
		return this.plugin.settings.oauthClientSecret.trim();
	}

	private appendClientSecret(body: URLSearchParams): void {
		const clientSecret = this.getClientSecret();
		if (clientSecret) {
			body.set('client_secret', clientSecret);
		}
	}

	private async storeTokens(data: TokenResponse): Promise<void> {
		this.accessToken = data.access_token;
		const expiresInMs = (data.expires_in ?? 3600) * 1000;
		this.plugin.settings.tokenExpiry = Date.now() + expiresInMs;
		this.plugin.settings.needsReauthentication = false;

		// Only persist the refresh token (long-lived) — never store the access token
		if (data.refresh_token) {
			this.plugin.settings.refreshToken = data.refresh_token;
		}

		this.clearReauthenticateNotice();
		await this.plugin.saveSettings();
		this.scheduleProactiveRefresh(expiresInMs);
	}

	/** Schedule a proactive refresh REFRESH_BUFFER_MS before the token expires. */
	private scheduleProactiveRefresh(expiresInMs: number): void {
		this.clearRefreshTimer();
		const delay = Math.max(0, expiresInMs - REFRESH_BUFFER_MS);
		this.refreshTimer = setTimeout(() => {
			void (async () => {
				try {
					await this.refreshAccessToken();
				} catch (err) {
					if (err instanceof AuthError) {
						new Notice(`Google Drive Sync: ${err.message}`, 10000);
					}
				}
			})();
		}, delay);
	}

	private clearRefreshTimer(): void {
		if (this.refreshTimer !== null) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** Attempt to restore an access token from a saved refresh token on plugin load. */
	async restoreSession(): Promise<void> {
		if (!this.plugin.settings.refreshToken) return;
		try {
			await this.refreshAccessToken();
		} catch (err) {
			if (err instanceof AuthError) {
				new Notice(`Google Drive Sync: ${err.message}`, 10000);
			}
		}
	}

	/** Cleanup — call from plugin onunload. */
	destroy(): void {
		this.clearRefreshTimer();
		this.clearReauthenticateNotice();
		this.clearSessionMobileAuthData();
		this.rejectMobileAuthWaiter(new Error('Authentication was interrupted.'));
	}

	/** Refresh token after a 401 response and return the new access token. */
	async refreshAfterUnauthorized(): Promise<string> {
		await this.refreshAccessToken();
		return this.accessToken;
	}

	private showReauthenticateNotice(): void {
		this.clearReauthenticateNotice();
		this.reauthNotice = new Notice(
			'Google account access expired. Open settings and select re-authenticate.',
			0
		);
	}

	private clearReauthenticateNotice(): void {
		this.reauthNotice?.hide();
		this.reauthNotice = null;
	}

	private async savePendingMobileAuthData(state: string): Promise<void> {
		this.plugin.settings.pendingOAuthState = state;
		await this.plugin.saveSettings();
		sessionStorage.setItem(SESSION_OAUTH_STATE_KEY, state);
	}

	private getPendingMobileAuthState(): string {
		return this.plugin.settings.pendingOAuthState || sessionStorage.getItem(SESSION_OAUTH_STATE_KEY) || '';
	}

	private async clearPendingMobileAuthData(): Promise<void> {
		const hadPendingData = !!this.plugin.settings.pendingOAuthState;
		this.plugin.settings.pendingOAuthState = '';
		this.clearSessionMobileAuthData();
		if (hadPendingData) {
			await this.plugin.saveSettings();
		}
	}

	private clearSessionMobileAuthData(): void {
		sessionStorage.removeItem(SESSION_OAUTH_STATE_KEY);
	}

	private waitForMobileCallback(): Promise<void> {
		this.rejectMobileAuthWaiter(new Error('Authentication was restarted.'));
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.mobileAuthWaiter = null;
				void this.clearPendingMobileAuthData();
				reject(new Error('OAuth callback timed out after 5 minutes'));
			}, MOBILE_AUTH_TIMEOUT_MS);
			this.mobileAuthWaiter = { resolve, reject, timeoutId };
		});
	}

	private resolveMobileAuthWaiter(): void {
		if (!this.mobileAuthWaiter) return;
		const waiter = this.mobileAuthWaiter;
		this.mobileAuthWaiter = null;
		clearTimeout(waiter.timeoutId);
		waiter.resolve();
	}

	private rejectMobileAuthWaiter(error: Error): void {
		if (!this.mobileAuthWaiter) return;
		const waiter = this.mobileAuthWaiter;
		this.mobileAuthWaiter = null;
		clearTimeout(waiter.timeoutId);
		waiter.reject(error);
	}

	// ── User info ─────────────────────────────────────────────────────

	private async fetchAndStoreEmail(): Promise<void> {
		try {
			const token = await this.getAccessToken();
			const response = await requestUrl({
				url: USERINFO_ENDPOINT,
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = response.json as { email?: string };
			if (data.email) {
				this.plugin.settings.connectedEmail = data.email;
				await this.plugin.saveSettings();
				this.plugin.refreshSettingTab();
			}
		} catch {
			// Non-fatal — email display is cosmetic
		}
	}

	private generateState(): string {
		const array = new Uint8Array(16);
		crypto.getRandomValues(array);
		return base64UrlEncode(array);
	}

	private buildAuthUrl(
		state: string,
		redirectUri: string,
		options?: { forceAccountChooser?: boolean }
	): string {
		const promptValues = ['consent'];
		if (options?.forceAccountChooser) {
			promptValues.unshift('select_account');
		}

		const params = new URLSearchParams({
			client_id: this.getClientId(),
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
			state,
			access_type: 'offline',
			prompt: promptValues.join(' '), // Keep refresh token behavior and optionally force account selection
		});
		return `${AUTH_ENDPOINT}?${params.toString()}`;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64UrlEncode(buffer: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...buffer));
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type: string;
}

interface OAuthErrorResponse {
	error?: string;
	error_description?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthError';
	}
}
