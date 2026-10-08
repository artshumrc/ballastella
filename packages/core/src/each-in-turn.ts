export async function eachInTurn<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let failure: unknown = null;
	const worker = async (): Promise<void> => {
		while (failure === null) {
			const index = next++;
			if (index >= items.length) return;
			try {
				await work(items[index] as T);
			} catch (cause) {
				failure ??= cause;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure !== null) throw failure;
}
