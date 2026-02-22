// eslint-disable-next-line import/no-nodejs-modules
import * as http from 'http';

interface CallbackResult {
	code: string;
	state: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Temporary localhost HTTP server that receives the OAuth redirect on desktop.
 * Opens on a random available port, waits for one request, then closes.
 */
export class OAuthCallbackServer {
	private server: http.Server | null = null;
	private port = 0;

	/** Start the server and return the redirect URI to register with Google. */
	async start(): Promise<string> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer();
			this.server.listen(0, '127.0.0.1', () => {
				const addr = this.server?.address();
				if (!addr || typeof addr === 'string') {
					reject(new Error('Failed to get server address'));
					return;
				}
				this.port = addr.port;
				resolve(`http://127.0.0.1:${this.port}/callback`);
			});
			this.server.on('error', reject);
		});
	}

	/** Wait for the OAuth callback and return the auth code + state. */
	waitForCallback(): Promise<CallbackResult> {
		return new Promise((resolve, reject) => {
			if (!this.server) {
				reject(new Error('Server not started'));
				return;
			}

			const timeout = setTimeout(() => {
				this.close();
				reject(new Error('OAuth callback timed out after 5 minutes'));
			}, 5 * 60 * 1000);

			const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
				if (req.method !== 'GET' || url.pathname !== '/callback') {
					res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Not found');
					return;
				}

				clearTimeout(timeout);
				this.server?.off('request', requestHandler);

				const code = url.searchParams.get('code');
				const state = url.searchParams.get('state');
				const error = url.searchParams.get('error');
				const html = (message: string, success: boolean) => `
					<!DOCTYPE html>
					<html>
					<head><title>GDrive Sync</title></head>
					<body style="font-family:sans-serif;text-align:center;padding:40px;">
						<h2>${success ? '✓' : '✗'} ${escapeHtml(message)}</h2>
						<p>You can close this window and return to Obsidian.</p>
					</body>
					</html>
				`;

				if (error || !code || !state) {
					res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end(html(`Authentication failed: ${error ?? 'missing parameters'}`, false));
					this.close();
					reject(new Error(error ?? 'OAuth callback missing code or state'));
					return;
				}

				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(html('Authentication successful', true));
				this.close();
				resolve({ code, state });
			};

			this.server.on('request', requestHandler);
		});
	}

	close(): void {
		this.server?.close();
		this.server = null;
	}

	get redirectUri(): string {
		return `http://127.0.0.1:${this.port}/callback`;
	}
}
