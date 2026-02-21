export async function runWithConcurrencyLimit<T>(
	items: readonly T[],
	limit: number,
	handler: (item: T, index: number) => Promise<void>
): Promise<void> {
	const concurrency = Math.max(1, Math.floor(limit));
	if (items.length === 0) {
		return;
	}

	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		for (;;) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}
			await handler(items[currentIndex] as T, currentIndex);
		}
	});

	await Promise.all(workers);
}
