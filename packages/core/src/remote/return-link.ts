// The two links a Published Site carries back to the editor that made it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE MODULE FOR BOTH ENDS, BECAUSE THEY ARE THE SAME SENTENCE READ TWICE
//
// The viewer writes these URLs and the editor reads them, and the two apps share no code but this
// package. A parameter renamed on one side and not the other is a link that lands on a working
// editor and does nothing at all — no error, no offer, and nothing on screen to say why. So the
// names live here once, with the builder and the reader beside each other.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A LINK IS SOMETHING ANYONE CAN SEND
//
// Both halves of a repository reference are interpolated straight into a GitHub API path by the
// inbound and Review engines, so `readReturnLink` goes through `parseRemoteReference` — the checked
// reader `parseRemoteBinding`'s note is written about — rather than splitting on a slash. An owner
// of `ada/../../orgs` retargets every request the engine makes, and `encodeURIComponent` at the
// interpolation is not the fix.
//
// The offer these produce is also why nothing here acts: a URL that silently created a Workspace
// and switched to it would be a link that rearranges a stranger's editor. See the editor's route.

import { parseRemoteReference } from './remote-binding.js';

/** Which of the two invitations a link carries, and what it names. */
export type ReturnLink =
	| { readonly kind: 'clone'; readonly owner: string; readonly repository: string }
	| {
			readonly kind: 'review';
			readonly owner: string;
			readonly repository: string;
			/**
			 * The Project's directory on the Remote, which is a Project's identity (ADR-0008).
			 *
			 * Untrusted, and left that way: `reviewFromRemote` looks it up among the directories the
			 * Remote's own tree holds a `project.json` in, so a name with a slash in it is a refusal
			 * rather than a path.
			 */
			readonly project: string;
	  };

/**
 * The address to put in the Front Page's `href`, or `null` when there is no link to make.
 *
 * `instance` is the site record's `editorUrl`, which `parsePublishedSite` has already refused
 * unless it is an absolute `http(s)` address ending in `/`. `null` means *render nothing* — never a
 * guess at a canonical deployment, which would offer a Reader's work to a stranger's editor.
 */
export function returnLinkUrl(instance: string, link: ReturnLink): string | null {
	if (instance === '') return null;
	// Built by hand rather than through `URLSearchParams`, which would percent-encode the slash in
	// `owner/repo` — legal, and read back the same, but not the shipped address, nor the one a scholar
	// reads off their own status bar before following it.
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

/**
 * The invitation this editor has been landed on, or `null` — which is every other URL it has.
 *
 * ⚠ **Whatever reads this must do it under the prerender guard.** `url.searchParams` throws while
 * prerendering, and the editor's one route is prerendered; see `apps/editor/src/routes/+page.svelte`.
 */
export function readReturnLink(parameters: URLSearchParams): ReturnLink | null {
	const clone = parameters.get('clone');
	if (clone !== null) {
		const reference = parseRemoteReference(clone);
		return reference === null ? null : { kind: 'clone', ...reference };
	}
	const review = parameters.get('review');
	if (review === null) return null;
	const reference = parseRemoteReference(review);
	// `?p=` is what names the Project, here as everywhere else in this project (ADR-0008). Without
	// one there is no Review to offer, and widening it to the whole repository would hand a Reader
	// who asked to look at one piece of work all of it.
	const project = parameters.get('p') ?? '';
	return reference === null || project === '' ? null : { kind: 'review', ...reference, project };
}

/**
 * The same query string with the invitation taken out of it — `''` when nothing is left.
 *
 * ⚠ **The parameter has to be stripped once the offer is on screen.** One left in the address bar is
 * replayed by a reload, kept by a bookmark, and re-offered to somebody who already said no.
 *
 * Everything else is kept rather than the address being rebuilt from `?p=` alone, because `?p=` is
 * the review link's own Project and must survive — and because a future parameter that quietly did
 * not would be lost with nothing to say so.
 */
export function withoutReturnLink(parameters: URLSearchParams): string {
	const remaining = new URLSearchParams(parameters);
	remaining.delete('clone');
	remaining.delete('review');
	const query = remaining.toString();
	return query === '' ? '' : `?${query}`;
}
