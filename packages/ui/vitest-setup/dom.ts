import { flushSync, mount, unmount, type Component } from 'svelte';

const selector = (testid: string): string => `[data-testid="${testid}"]`;

export const one = (testid: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(selector(testid));

export const all = (testid: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(selector(testid))
];

export function at(testid: string): HTMLElement {
	const found = one(testid);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testid}"`);
	return found;
}

export const absent = (testid: string): boolean => one(testid) === null;

export const textOf = (element: Element | null | undefined): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

export const said = (): string => textOf(document.body);

export function press(testid: string): void {
	at(testid).click();
	flushSync();
}

export function fill(testid: string, value: string): void {
	const field = at(testid) as HTMLInputElement;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

export async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	flushSync();
}

let mounted: Record<string, unknown> | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function show<Props extends Record<string, any>>(
	component: Component<Props>,
	props: Props,
	target: HTMLElement = document.body
): void {
	mounted = mount(component, { target, props });
	flushSync();
}

export function inMain(): HTMLElement {
	const main = document.createElement('main');
	document.body.append(main);
	return main;
}

export function takeDown(): void {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
}
