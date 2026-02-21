const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUCKET_CAPACITY = 10;
const DEFAULT_TOKENS_PER_SECOND = 10;
const DEFAULT_ESTIMATED_DAILY_QUOTA = 100_000;
const DEFAULT_WARNING_RATIO = 1;
const DEFAULT_MIN_BACKOFF_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const MIN_REQUESTS_FOR_WARNING = 50;

export interface RateLimiterSnapshot {
	requestsToday: number;
	projectedRequestsToday: number;
	estimatedDailyQuota: number;
	shouldWarn: boolean;
	backoffUntilMs: number;
	resetAtUtcMs: number;
}

interface RateLimiterOptions {
	bucketCapacity?: number;
	tokensPerSecond?: number;
	estimatedDailyQuota?: number;
	warningRatio?: number;
	minBackoffMs?: number;
	maxBackoffMs?: number;
}

function startOfUtcDayMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function nextUtcMidnightMs(nowMs: number): number {
	return startOfUtcDayMs(nowMs) + DAY_MS;
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		window.setTimeout(resolve, ms);
	});
}

export class RateLimiter {
	private readonly bucketCapacity: number;
	private readonly tokensPerSecond: number;
	private readonly estimatedDailyQuota: number;
	private readonly warningRatio: number;
	private readonly minBackoffMs: number;
	private readonly maxBackoffMs: number;

	private availableTokens: number;
	private lastRefillAtMs = Date.now();

	private dayStartedAtMs = startOfUtcDayMs(Date.now());
	private dayResetAtMs = nextUtcMidnightMs(Date.now());
	private requestsToday = 0;
	private warnedForResetAtMs = 0;

	private backoffUntilMs = 0;

	constructor(options?: RateLimiterOptions) {
		this.bucketCapacity = Math.max(1, Math.round(options?.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY));
		this.tokensPerSecond = Math.max(0.1, options?.tokensPerSecond ?? DEFAULT_TOKENS_PER_SECOND);
		this.estimatedDailyQuota = Math.max(1, Math.round(options?.estimatedDailyQuota ?? DEFAULT_ESTIMATED_DAILY_QUOTA));
		this.warningRatio = Math.max(0.1, options?.warningRatio ?? DEFAULT_WARNING_RATIO);
		this.minBackoffMs = Math.max(1000, options?.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS);
		this.maxBackoffMs = Math.max(this.minBackoffMs, options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
		this.availableTokens = this.bucketCapacity;
	}

	async waitForTurn(): Promise<void> {
		for (;;) {
			const now = Date.now();
			this.resetDailyWindowIfNeeded(now);
			this.refillTokens(now);

			const backoffDelayMs = Math.max(0, this.backoffUntilMs - now);
			if (backoffDelayMs > 0) {
				await sleep(backoffDelayMs);
				continue;
			}

			if (this.availableTokens >= 1) {
				this.availableTokens -= 1;
				return;
			}

			const waitForTokenMs = Math.ceil(1000 / this.tokensPerSecond);
			await sleep(waitForTokenMs);
		}
	}

	recordRequest(): void {
		this.resetDailyWindowIfNeeded(Date.now());
		this.requestsToday += 1;
	}

	clearBackoff(): void {
		this.backoffUntilMs = 0;
	}

	registerBackoff(attempt: number): number {
		const exponential = this.minBackoffMs * Math.pow(2, Math.max(0, attempt));
		const delayMs = Math.min(this.maxBackoffMs, Math.max(this.minBackoffMs, Math.round(exponential)));
		const candidateUntilMs = Date.now() + delayMs;
		this.backoffUntilMs = Math.max(this.backoffUntilMs, candidateUntilMs);
		return delayMs;
	}

	getSnapshot(): RateLimiterSnapshot {
		const now = Date.now();
		this.resetDailyWindowIfNeeded(now);
		const elapsedMs = Math.max(1, now - this.dayStartedAtMs);
		const projectedRequestsToday = Math.round((this.requestsToday / elapsedMs) * DAY_MS);
		const shouldWarn =
			this.requestsToday >= MIN_REQUESTS_FOR_WARNING &&
			projectedRequestsToday >= Math.round(this.estimatedDailyQuota * this.warningRatio);

		return {
			requestsToday: this.requestsToday,
			projectedRequestsToday,
			estimatedDailyQuota: this.estimatedDailyQuota,
			shouldWarn,
			backoffUntilMs: this.backoffUntilMs,
			resetAtUtcMs: this.dayResetAtMs,
		};
	}

	consumeProjectedQuotaWarning(): boolean {
		const snapshot = this.getSnapshot();
		if (!snapshot.shouldWarn) {
			return false;
		}
		if (this.warnedForResetAtMs === snapshot.resetAtUtcMs) {
			return false;
		}
		this.warnedForResetAtMs = snapshot.resetAtUtcMs;
		return true;
	}

	private resetDailyWindowIfNeeded(nowMs: number): void {
		if (nowMs < this.dayResetAtMs) {
			return;
		}
		this.dayStartedAtMs = startOfUtcDayMs(nowMs);
		this.dayResetAtMs = nextUtcMidnightMs(nowMs);
		this.requestsToday = 0;
		this.warnedForResetAtMs = 0;
	}

	private refillTokens(nowMs: number): void {
		const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillAtMs) / 1000);
		if (elapsedSeconds <= 0) {
			return;
		}
		const refill = elapsedSeconds * this.tokensPerSecond;
		this.availableTokens = Math.min(this.bucketCapacity, this.availableTokens + refill);
		this.lastRefillAtMs = nowMs;
	}
}
