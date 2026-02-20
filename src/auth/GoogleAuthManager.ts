import { Notice, Platform, requestUrl } from 'obsidian';
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
const SESSION_CODE_VERIFIER_KEY = 'gdrive_code_verifier';
const SESSION_OAUTH_STATE_KEY = 'gdrive_oauth_state';

export class GoogleAuthManager {
	// Populated by the user via plugin settings — see PLANS.md section 5.1
	// The plugin must have a Google OAuth 2.0 client ID (registered in GCP Console)
	// with redirect URIs: http://127.0.0.1 (any port) and obsidian://gdrive-callback
	private readonly clientId: string;
	private readonly clientSecret: string;

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
		// Client credentials are injected at build time via esbuild define.
		// Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in your build environment.
		/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
		this.clientId = ((globalThis as any).__GDRIVE_CLIENT_ID__ as string | undefined) ?? '';
		this.clientSecret = ((globalThis as any).__GDRIVE_CLIENT_SECRET__ as string | undefined) ?? '';
		/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
		if (this.plugin.settings.needsReauthentication) {
			this.showReauthenticateNotice();
		}
	}

	/** True if we have a refresh token (i.e., the user has authenticated). */
	get isAuthenticated(): boolean {
		return !!this.plugin.settings.refreshToken;
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
		if (!this.clientId || !this.clientSecret) {
			throw new Error(
				'Google OAuth client credentials are not configured. ' +
				'Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET at build time.'
			);
		}

		const codeVerifier = this.generateCodeVerifier();
		const codeChallenge = await this.generateCodeChallenge(codeVerifier);
		const state = this.generateState();

		if (Platform.isMobile) {
			await this.authenticateMobile(codeVerifier, codeChallenge, state);
		} else {
			await this.authenticateDesktop(codeVerifier, codeChallenge, state);
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
		this.plugin.settings.pendingCodeVerifier = '';
		this.clearSessionMobileAuthData();
		this.rejectMobileAuthWaiter(new Error('Authentication was cancelled.'));
		this.clearReauthenticateNotice();
		await this.plugin.saveSettings();
		this.plugin.refreshSettingTab();
	}

	/** Import a refresh token from another device and initialize session state. */
	async importRefreshToken(refreshToken: string): Promise<void> {
		if (!this.clientId || !this.clientSecret) {
			throw new Error(
				'Google OAuth client credentials are not configured. ' +
				'Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET at build time.'
			);
		}

		const normalizedToken = refreshToken.trim();
		if (!normalizedToken) {
			throw new Error('Enter a refresh token first.');
		}

		const response = await this.requestRefreshGrant(normalizedToken);

		if (response.status === 400 || response.status === 401) {
			const data = response.json as { error?: string };
			if (data.error === 'invalid_grant') {
				throw new AuthError('Invalid refresh token. Paste the full token and try again.');
			}
		}

		if (response.status !== 200) {
			throw new AuthError(`Token refresh failed (${response.status}): ${response.text}`);
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
		codeVerifier: string,
		codeChallenge: string,
		state: string
	): Promise<void> {
		// Load desktop-only callback server lazily so mobile can run without Node built-ins.
		const { OAuthCallbackServer } = await import('./OAuthCallbackServer');
		const callbackServer = new OAuthCallbackServer();
		const redirectUri = await callbackServer.start();

		const authUrl = this.buildAuthUrl(codeChallenge, state, redirectUri);

		// Open the browser
		window.open(authUrl);

		new Notice('Complete authentication in your browser, then return to Obsidian.');

		const { code, state: returnedState } = await callbackServer.waitForCallback();

		if (returnedState !== state) {
			throw new Error('OAuth state mismatch — possible CSRF attack');
		}

		await this.exchangeCode(code, codeVerifier, redirectUri);
	}

	// ── Mobile flow ───────────────────────────────────────────────────

	private async authenticateMobile(
		codeVerifier: string,
		codeChallenge: string,
		state: string
	): Promise<void> {
		const authUrl = this.buildAuthUrl(codeChallenge, state, MOBILE_REDIRECT_URI, {
			forceAccountChooser: true,
		});
		await this.savePendingMobileAuthData(state, codeVerifier);
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

		const { state: expectedState, codeVerifier } = this.getPendingMobileAuthData();
		await this.clearPendingMobileAuthData();

		if (returnedState !== expectedState) {
			const stateError = new Error('OAuth state mismatch — possible CSRF attack');
			this.rejectMobileAuthWaiter(stateError);
			throw stateError;
		}

		if (!codeVerifier) {
			const verifierError = new Error('Missing PKCE code verifier — please retry authentication');
			this.rejectMobileAuthWaiter(verifierError);
			throw verifierError;
		}

		try {
			await this.exchangeCode(code, codeVerifier, MOBILE_REDIRECT_URI);
		} catch (err) {
			const authError = err instanceof Error ? err : new Error(String(err));
			this.rejectMobileAuthWaiter(authError);
			throw authError;
		}

		this.resolveMobileAuthWaiter();
	}

	// ── Token exchange ────────────────────────────────────────────────

	private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<void> {
		const response = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: this.clientId,
				client_secret: this.clientSecret,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
				code_verifier: codeVerifier,
			}).toString(),
		});

		if (response.status !== 200) {
			throw new Error(`Token exchange failed: ${response.text}`);
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
			response = await this.requestRefreshGrant(this.plugin.settings.refreshToken);
		} catch {
			throw new AuthError('Network error during token refresh');
		}

		if (response.status === 400 || response.status === 401) {
			const data = response.json as { error?: string };
			if (data.error === 'invalid_grant') {
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
			throw new AuthError(`Token refresh failed (${response.status}): ${response.text}`);
		}

		const data = response.json as TokenResponse;
		await this.storeTokens(data);
	}

	private async requestRefreshGrant(refreshToken: string): Promise<Awaited<ReturnType<typeof requestUrl>>> {
		return requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: this.clientId,
				client_secret: this.clientSecret,
			}).toString(),
		});
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

	private async savePendingMobileAuthData(state: string, codeVerifier: string): Promise<void> {
		this.plugin.settings.pendingOAuthState = state;
		this.plugin.settings.pendingCodeVerifier = codeVerifier;
		await this.plugin.saveSettings();
		sessionStorage.setItem(SESSION_OAUTH_STATE_KEY, state);
		sessionStorage.setItem(SESSION_CODE_VERIFIER_KEY, codeVerifier);
	}

	private getPendingMobileAuthData(): { state: string; codeVerifier: string } {
		const state = this.plugin.settings.pendingOAuthState || sessionStorage.getItem(SESSION_OAUTH_STATE_KEY) || '';
		const codeVerifier = this.plugin.settings.pendingCodeVerifier || sessionStorage.getItem(SESSION_CODE_VERIFIER_KEY) || '';
		return { state, codeVerifier };
	}

	private async clearPendingMobileAuthData(): Promise<void> {
		const hadPendingData = !!this.plugin.settings.pendingOAuthState || !!this.plugin.settings.pendingCodeVerifier;
		this.plugin.settings.pendingOAuthState = '';
		this.plugin.settings.pendingCodeVerifier = '';
		this.clearSessionMobileAuthData();
		if (hadPendingData) {
			await this.plugin.saveSettings();
		}
	}

	private clearSessionMobileAuthData(): void {
		sessionStorage.removeItem(SESSION_OAUTH_STATE_KEY);
		sessionStorage.removeItem(SESSION_CODE_VERIFIER_KEY);
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

	// ── PKCE helpers ──────────────────────────────────────────────────

	private generateCodeVerifier(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return base64UrlEncode(array);
	}

	private async generateCodeChallenge(verifier: string): Promise<string> {
		const encoded = new TextEncoder().encode(verifier);
		const digest = await crypto.subtle.digest('SHA-256', encoded);
		return base64UrlEncode(new Uint8Array(digest));
	}

	private generateState(): string {
		const array = new Uint8Array(16);
		crypto.getRandomValues(array);
		return base64UrlEncode(array);
	}

	private buildAuthUrl(
		codeChallenge: string,
		state: string,
		redirectUri: string,
		options?: { forceAccountChooser?: boolean }
	): string {
		const promptValues = ['consent'];
		if (options?.forceAccountChooser) {
			promptValues.unshift('select_account');
		}

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
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

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthError';
	}
}
