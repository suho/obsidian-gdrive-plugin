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
				const html = (message: string, success: boolean) => {
					const statusTone = success ? 'is-success' : 'is-error';
					const statusSymbol = success ? '✓' : '✗';
					const title = success ? 'Connected to Google Drive' : 'Google Drive connection failed';
					const safeMessage = escapeHtml(message);
					return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive sync for Obsidian</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font:15px/1.35 "Avenir Next","Segoe UI",Arial,sans-serif;color:#f3f2ff;background:radial-gradient(55rem 50rem at -5% -15%,#6d5bd044,transparent 55%),linear-gradient(145deg,#1a1630,#0f0f13)}main{width:min(520px,100%);border-radius:18px;padding:22px;background:linear-gradient(180deg,#221d36f2,#171325f2);border:1px solid #7c6ad340;box-shadow:0 18px 42px #05040990}.r{display:flex;align-items:center;justify-content:center;gap:10px}.b{width:40px;height:40px;display:grid;place-items:center;border-radius:11px;background:#ffffff10;border:1px solid #ffffff20}.p{color:#b6ade6;font-weight:700}h1{margin:12px 0 4px;text-align:center;font-size:24px;letter-spacing:-.02em}.m{margin:0 0 14px;text-align:center;color:#c8c3e8}.k{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:13px;border-radius:12px}.i{width:28px;height:28px;display:grid;place-items:center;border-radius:999px;font-weight:700}.t{margin:0;font-size:17px}.d{margin:6px 0 0;font-size:14px;word-break:break-word}.is-success{background:#13342d}.is-success .i{background:#00c8972b;color:#8ef2d3}.is-error{background:#3a1522}.is-error .i{background:#ff5d8f2b;color:#ffb4ca}.f{margin:14px 0 0;text-align:center;color:#c8c3e8;font-size:13px}</style></head><body><main><div class="r"><div class="b"><svg viewBox="0 0 24 24" width="24" height="24"><polygon points="7.4,2 12,2 17.6,11.4 13,11.4" fill="#0F9D58"/><polygon points="7.4,2 2.4,10.7 7,19 12,10.7" fill="#F4B400"/><polygon points="12,10.7 17.6,11.4 21.6,19 7,19" fill="#4285F4"/></svg></div><span class="p">+</span><div class="b"><svg viewBox="0 0 64 64" width="24" height="24"><polygon points="32,4 52,14 44,56 20,56 12,14" fill="#6f63df"/><polygon points="32,4 26,24 14,14" fill="#9f95ff"/><polygon points="26,24 20,56 12,14" fill="#5b4ec8"/><polygon points="26,24 44,56 20,56" fill="#3b2f90"/></svg></div></div><h1>Google Drive sync for Obsidian</h1><p class="m">Authentication callback status</p><section class="k ${statusTone}"><div class="i">${statusSymbol}</div><div><h2 class="t">${title}</h2><p class="d">${safeMessage}</p></div></section><p class="f">You can now close this tab and return to Obsidian.</p></main></body></html>`;
				};

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
