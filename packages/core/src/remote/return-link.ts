import { parseRemoteReference } from './remote-binding.js';

export type ReturnLink =
	| { readonly kind: 'clone'; readonly owner: string; readonly repository: string }
	| {
			readonly kind: 'review';
			readonly owner: string;
			readonly repository: string;
			readonly project: string;
	  };

export function returnLinkUrl(instance: string, link: ReturnLink): string | null {
	if (instance === '') return null;
	const reference = `${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}`;
	const query =
		link.kind === 'clone'
			? `?clone=${reference}`
			: `?review=${reference}&p=${encodeURIComponent(link.project)}`;
	try {
		return new URL(query, instance).href;
	} catch {
		return null;
	}
}

// Call under the prerender guard: `url.searchParams` throws while prerendering.
export function readReturnLink(parameters: URLSearchParams): ReturnLink | null {
	const clone = parameters.get('clone');
	if (clone !== null) {
		const reference = parseRemoteReference(clone);
		return reference === null ? null : { kind: 'clone', ...reference };
	}
	const review = parameters.get('review');
	if (review === null) return null;
	const reference = parseRemoteReference(review);
	const project = parameters.get('p') ?? '';
	return reference === null || project === '' ? null : { kind: 'review', ...reference, project };
}

export function withoutReturnLink(parameters: URLSearchParams): string {
	const remaining = new URLSearchParams(parameters);
	remaining.delete('clone');
	remaining.delete('review');
	const query = remaining.toString();
	return query === '' ? '' : `?${query}`;
}
