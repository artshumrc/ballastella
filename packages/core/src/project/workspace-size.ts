import type { ProjectStore } from '../store/project-store.js';

export const STATIC_HOSTING_LIMIT_BYTES = 1_000_000_000;

export type WorkspaceSize = {
	readonly bytes: number;
	readonly files: number;
};

export async function workspaceSize(store: ProjectStore, prefix = ''): Promise<WorkspaceSize> {
	const paths = await store.list(prefix);
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	return { bytes: sizes.reduce((sum, size) => sum + size, 0), files: paths.length };
}

export const crossesHostingLimit = (current: number, adding: number): boolean =>
	current + adding > STATIC_HOSTING_LIMIT_BYTES;

export function describeBytes(bytes: number): string {
	const rounded = Math.max(0, Math.round(bytes));
	if (rounded < 1000) return `${rounded} ${rounded === 1 ? 'byte' : 'bytes'}`;
	const [scale, unit] = rounded >= 1e9 ? [1e9, 'GB'] : rounded >= 1e6 ? [1e6, 'MB'] : [1e3, 'kB'];
	const value = rounded / scale;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

export function hostingLimitWarning(current: number, adding: number): string {
	if (!crossesHostingLimit(current, adding)) return '';
	const limit = describeBytes(STATIC_HOSTING_LIMIT_BYTES);
	const already = current > STATIC_HOSTING_LIMIT_BYTES;

	return (
		`This Workspace holds ${describeBytes(current)} and this copy adds about ` +
		`${describeBytes(adding)}, ` +
		(already
			? `so it is already past the ${limit} a free static host such as GitHub Pages will serve. `
			: `which takes it past the ${limit} a free static host such as GitHub Pages will serve. `) +
		`You can still make the copy — this is worth knowing rather than a reason to stop — but ` +
		`sending the whole Workspace to one of those hosts will fail, and the way out is to share ` +
		`one Project at a time or to host it somewhere without that limit.`
	);
}
