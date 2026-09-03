// Rendering an Annotation's `description` (ADR-0009).
//
// **This is the one place in this codebase where a bug is a security vulnerability rather than a
// defect**, and everything about the shape of this module is chosen for that. A user can open a
// Project authored by somebody else — a zip import, a remote source — and the Published Site runs
// on the user's own domain, so an unsanitised `description` is stored XSS on
// `maps.digitalhumanities.harvard.edu` or on a student's GitHub Pages origin.
//
// **One function owns both stages, and that is the point.** ADR-0009: the pipeline is `marked` →
// DOMPurify → insert, and the order is not negotiable, because sanitising before parsing is a known
// bypass shape — a parser downstream of the sanitiser can reconstruct markup out of text the
// sanitiser already cleared as inert. Two exported calls that a caller sequences could be sequenced
// the other way by an edit years from now, in a file whose author had never read this comment. There
// is therefore no exported "parse" and no exported "sanitise": there is one function, and the order
// inside it is not reachable from outside.
//
// Exported from `core` and imported by **both** apps rather than reimplemented in the viewer, which
// is what makes the guarantee — the same payload is inert in the Published Site — mean anything at
// all.

import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension } from 'marked';

/**
 * The Markdown renderer needs a DOM and there is not one here.
 *
 * Raised rather than degraded, and this is deliberate. DOMPurify decides at construction whether the
 * host has a DOM it can parse into, and where it decides no it does not merely refuse — the instance
 * has no `sanitize` method at all, so the naive failure is `TypeError: DOMPurify.sanitize is not a
 * function` from inside a library the reader has no reason to suspect.
 *
 * The failure that matters is the *other* one. Both apps prerender, so this module is
 * reachable from Node during a build, and a version of it that quietly returned the unsanitised HTML
 * when DOMPurify was unavailable would write an XSS payload into a static page — the exact
 * vulnerability this module exists to prevent, arrived at by a fallback that looked like robustness.
 * **Refusing is the safe direction**, so it is what happens, with a message that says which of the
 * two situations the reader is in.
 */
export class DescriptionRendererUnavailableError extends Error {
	constructor() {
		super(
			'An Annotation description cannot be rendered here: DOMPurify found no DOM to sanitise ' +
				'into. Render descriptions in the browser. Nothing is rendered unsanitised.'
		);
		this.name = 'DescriptionRendererUnavailableError';
	}
}

/**
 * Whether {@link renderDescription} can run here.
 *
 * For callers that legitimately run in both places — a Svelte component that prerenders and then
 * hydrates — so that the answer is a question they can ask rather than an exception they catch.
 */
export function isDescriptionRendererSupported(): boolean {
	return DOMPurify.isSupported && typeof DOMPurify.sanitize === 'function';
}

/** `&<>"'` as entities, for text that must appear as itself and never as markup. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * A footnote *definition* line, claimed so that CommonMark cannot read it as a link definition.
 *
 * ADR-0009 defers footnotes past v1 and asks that the syntax degrade to literal text — "as
 * behaviour, not accident". Left to `marked`, it is neither. Measured against `marked` 18.0.9:
 *
 * ```
 * A claim[^1] worth noting.        →  <p>A claim<a href="https://example.com/note">^1</a> worth noting.</p>
 *
 * [^1]: https://example.com/note       and the definition line renders as nothing at all
 * ```
 *
 * That is CommonMark behaving correctly, not a bug: `^1` is a perfectly legal link label, so
 * `[^1]: <url>` **is** a link reference definition, which produces no output of its own and turns
 * every `[^1]` in the document into an anchor. So the one shape a scholar would actually type
 * produces an anchor whose text is `^1`, pointing at the note's URL, and silently deletes the note's
 * prose. Anchors are precisely what the acceptance criterion forbids, and losing the line is worse
 * than the markup.
 *
 * Block extensions are tried before `marked`'s own block tokenizers, so claiming the line here is
 * what stops the definition from ever being registered.
 */
const footnoteDefinitionAsText: TokenizerAndRendererExtension = {
	name: 'footnoteDefinitionAsText',
	level: 'block',
	start: (src) => src.match(/^\[\^/m)?.index,
	tokenizer(src) {
		// The label, the colon, and the rest of that line. A destination CommonMark would have allowed
		// on the following line is left where it is: it becomes ordinary paragraph text, which is the
		// outcome this extension is for.
		const match = /^\[\^[^\]\n]*\]:[^\n]*(?:\n|$)/.exec(src);
		if (!match) return undefined;
		return { type: 'footnoteDefinitionAsText', raw: match[0], text: match[0].trimEnd() };
	},
	renderer: (token) => `<p>${escapeHtml(token.text)}</p>\n`
};

/**
 * A footnote *reference*, claimed so that it is text whatever else is in the document.
 *
 * Belt and braces beside {@link footnoteDefinitionAsText}, and worth the few lines: that one has to
 * recognise a definition to stop it, and a definition it failed to recognise would turn every
 * reference into an anchor. This one makes `[^1]` literal text unconditionally, so "no anchors and
 * no ids" holds without depending on a regex having been exhaustive.
 */
const footnoteReferenceAsText: TokenizerAndRendererExtension = {
	name: 'footnoteReferenceAsText',
	level: 'inline',
	start: (src) => {
		const at = src.indexOf('[^');
		return at === -1 ? undefined : at;
	},
	tokenizer(src) {
		const match = /^\[\^[^\]\n]*\]/.exec(src);
		if (!match) return undefined;
		return { type: 'footnoteReferenceAsText', raw: match[0], text: match[0] };
	},
	renderer: (token) => escapeHtml(token.text)
};

/**
 * The Markdown parser. **Not the security boundary** — DOMPurify is (ADR-0009).
 *
 * A private instance rather than the `marked` singleton, so that configuring it cannot be undone,
 * or added to, by any other importer of `marked` in the process.
 */
const parser = new Marked({ async: false, gfm: true }).use({
	extensions: [footnoteDefinitionAsText, footnoteReferenceAsText]
});

/**
 * What survives sanitisation: emphasis, links, and the ordinary block structure Markdown produces.
 *
 * An allowlist, so a tag nobody thought about is absent rather than present. ADR-0009 scopes v1 to
 * emphasis and links; the block elements are here because a scholar writing a paragraph list gets a
 * list, and stripping structure Markdown legitimately produced would be a worse tool for no safety.
 *
 * **`img` is deliberately absent**, which is what makes `<img src=x onerror=…>` disappear rather
 * than merely lose an attribute — and it also takes this surface out of DOMPurify's `DATA_URI_TAGS`
 * set, the one place a `data:` URI is permitted by default.
 */
const ALLOWED_TAGS: readonly string[] = [
	'p',
	'br',
	'hr',
	'em',
	'strong',
	'i',
	'b',
	'u',
	'del',
	's',
	'sup',
	'sub',
	'a',
	'code',
	'pre',
	'blockquote',
	'ul',
	'ol',
	'li',
	'dl',
	'dt',
	'dd',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'span'
];

/**
 * The only attributes that survive.
 *
 * **`id` is absent on purpose.** ADR-0009 names id collisions between several popups on one page as
 * part of the cost of footnotes; since v1 ships no footnotes, nothing here needs an id, and an
 * attribute nothing needs is an attribute that should not be permitted. `style` is absent for the
 * same reason, and `on*` handlers are not an allowlist question at all — none of them is named here,
 * so all of them go.
 */
const ALLOWED_ATTR: readonly string[] = ['href', 'title', 'lang', 'dir', 'colspan', 'rowspan'];

/** The one call to DOMPurify. Everything this module returns has been through it. */
function sanitise(html: string): string {
	if (!isDescriptionRendererSupported()) throw new DescriptionRendererUnavailableError();
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [...ALLOWED_TAGS],
		ALLOWED_ATTR: [...ALLOWED_ATTR],
		// `data-*` and `aria-*` are wildcards rather than names, so they are the two ways an allowlist
		// stops being one. Neither is needed here.
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		// Keep the text of a tag that is removed. A user who typed something that turned out not to be
		// allowed should see their words, not a gap.
		KEEP_CONTENT: true
	});
}

/**
 * An Annotation's `description` as HTML safe to insert.
 *
 * Markdown in, sanitised HTML out. Emphasis and links render; footnote syntax is literal text;
 * scripts, event handlers, `javascript:` and `data:` URLs, and `<img onerror>` do not survive.
 *
 * @throws {DescriptionRendererUnavailableError} where there is no DOM to sanitise into — see there
 *   for why this refuses rather than degrading.
 */
export function renderDescription(markdown: string): string {
	// `parse` before `sanitise`, and the two are not separately reachable. See the module comment.
	return sanitise(parser.parse(markdown) as string);
}

/** An Annotation as a popup renders it: its title, and its `description` as Markdown. */
export interface AnnotationText {
	readonly title?: string | undefined;
	readonly description?: string | undefined;
}

/**
 * One Annotation's popup, as sanitised HTML.
 *
 * Here rather than in either app because **the title is untrusted text too**, and a popup assembled
 * in an app would be a second place where that has to be remembered. It is the surface most likely
 * to be missed: a `description` obviously holds prose a stranger wrote, whereas a `title` looks like
 * a label, and a sanitiser applied to one of a feature's two text fields is a vulnerability with a
 * passing test.
 *
 * The assembled document goes through {@link sanitise} again, so that **what this returns is
 * always DOMPurify's output** rather than a string some of which happens to have been sanitised.
 * The extra pass is idempotent and costs nothing at popup scale; what it buys is that no future edit
 * to the assembly can introduce an unsanitised path through this function.
 *
 * @returns sanitised HTML, or `''` when the Annotation has neither a title nor a description
 */
export function renderAnnotationPopup(annotation: AnnotationText): string {
	const parts: string[] = [];
	const title = annotation.title ?? '';
	const description = annotation.description ?? '';
	// A title is a plain string, never Markdown: it is one line in a list and in a popup heading, and
	// a title that could carry a link or a heading of its own would be a second Markdown surface for
	// no gain. Escaped, therefore, not parsed.
	if (title !== '') parts.push(`<p class="ballastella-annotation-title">${escapeHtml(title)}</p>`);
	if (description !== '') parts.push(renderDescription(description));
	if (parts.length === 0) return '';
	return sanitise(parts.join(''));
}
