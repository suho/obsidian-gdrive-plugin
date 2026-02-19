import { Notice, Platform, requestUrl } from 'obsidian';
import type GDriveSyncPlugin from '../main';
import { OAuthCallbackServer } from './OAuthCallbackServer';

// Google OAuth endpoints
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Required scope: access only files created by this plugin
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Mobile URI scheme for OAuth callback
const MOBILE_REDIRECT_URI = 'obsidian://gdrive-callback';

// Refresh access token this many ms before expiry (5 minutes)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

	constructor(
		private readonly plugin: GDriveSyncPlugin
	) {
		// Client credentials are injected at build time via esbuild define.
		// Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in your build environment.
		/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
		this.clientId = ((globalThis as any).__GDRIVE_CLIENT_ID__ as string | undefined) ?? '';
		this.clientSecret = ((globalThis as any).__GDRIVE_CLIENT_SECRET__ as string | undefined) ?? '';
		/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
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
		this.plugin.settings.setupComplete = false;
		await this.plugin.saveSettings();
	}

	// ── Desktop flow ──────────────────────────────────────────────────

	private async authenticateDesktop(
		codeVerifier: string,
		codeChallenge: string,
		state: string
	): Promise<void> {
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
		const authUrl = this.buildAuthUrl(codeChallenge, state, MOBILE_REDIRECT_URI);

		// Store the verifier so we can use it when the URI scheme callback fires
		sessionStorage.setItem('gdrive_code_verifier', codeVerifier);
		sessionStorage.setItem('gdrive_oauth_state', state);

		window.open(authUrl);

		new Notice('Complete authentication in your browser, then return to Obsidian.');
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
			throw new Error(`Google OAuth error: ${error}`);
		}

		if (!code || !returnedState) {
			throw new Error('Missing code or state in OAuth callback');
		}

		const expectedState = sessionStorage.getItem('gdrive_oauth_state');
		const codeVerifier = sessionStorage.getItem('gdrive_code_verifier');

		sessionStorage.removeItem('gdrive_oauth_state');
		sessionStorage.removeItem('gdrive_code_verifier');

		if (returnedState !== expectedState) {
			throw new Error('OAuth state mismatch — possible CSRF attack');
		}

		if (!codeVerifier) {
			throw new Error('Missing PKCE code verifier — please retry authentication');
		}

		await this.exchangeCode(code, codeVerifier, MOBILE_REDIRECT_URI);
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
			response = await requestUrl({
				url: TOKEN_ENDPOINT,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: this.plugin.settings.refreshToken,
					client_id: this.clientId,
					client_secret: this.clientSecret,
				}).toString(),
			});
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
				await this.plugin.saveSettings();
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

	private async storeTokens(data: TokenResponse): Promise<void> {
		this.accessToken = data.access_token;
		const expiresInMs = (data.expires_in ?? 3600) * 1000;
		this.plugin.settings.tokenExpiry = Date.now() + expiresInMs;

		// Only persist the refresh token (long-lived) — never store the access token
		if (data.refresh_token) {
			this.plugin.settings.refreshToken = data.refresh_token;
		}

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

	private buildAuthUrl(codeChallenge: string, state: string, redirectUri: string): string {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			prompt: 'consent', // Force refresh token to be returned
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
