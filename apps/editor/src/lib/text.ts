const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatWhen(iso: string, invalid: string): string {
	const when = new Date(iso);
	return Number.isNaN(when.valueOf()) ? invalid : WHEN.format(when);
}

export function focusMain(): void {
	const main = document.querySelector('main');
	if (!(main instanceof HTMLElement)) return;
	main.tabIndex = -1;
	main.focus();
}
