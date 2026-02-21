export interface DebouncedFn<TArgs extends unknown[]> {
	(...args: TArgs): void;
	cancel: () => void;
	flush: () => void;
}

type DelayProvider = number | (() => number);

function readDelayMs(delay: DelayProvider): number {
	const resolved = typeof delay === 'function' ? delay() : delay;
	return Number.isFinite(resolved) && resolved >= 0 ? resolved : 0;
}

export function debounceTrailing<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
	delayMs: DelayProvider
): DebouncedFn<TArgs> {
	let timeoutId: number | null = null;
	let lastArgs: TArgs | null = null;

	const clearTimer = (): void => {
		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const invoke = (): void => {
		if (!lastArgs) {
			return;
		}
		const args = lastArgs;
		lastArgs = null;
		callback(...args);
	};

	const debounced = ((...args: TArgs): void => {
		lastArgs = args;
		clearTimer();
		timeoutId = window.setTimeout(() => {
			timeoutId = null;
			invoke();
		}, readDelayMs(delayMs));
	}) as DebouncedFn<TArgs>;

	debounced.cancel = (): void => {
		lastArgs = null;
		clearTimer();
	};

	debounced.flush = (): void => {
		clearTimer();
		invoke();
	};

	return debounced;
}
