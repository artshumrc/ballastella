import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension } from 'marked';

class DescriptionRendererUnavailableError extends Error {
	override readonly name = 'DescriptionRendererUnavailableError';
	constructor() {
		super(
			'An Annotation description cannot be rendered here: DOMPurify found no DOM to sanitise ' +
				'into. Render descriptions in the browser. Nothing is rendered unsanitised.'
		);
	}
}

export function isDescriptionRendererSupported(): boolean {
	return DOMPurify.isSupported && typeof DOMPurify.sanitize === 'function';
}

const ENTITIES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (character) => ENTITIES[character] as string);

const footnoteDefinitionAsText: TokenizerAndRendererExtension = {
	name: 'footnoteDefinitionAsText',
	level: 'block',
	start: (src) => src.match(/^\[\^/m)?.index,
	tokenizer(src) {
		const match = /^\[\^[^\]\n]*\]:[^\n]*(?:\n|$)/.exec(src);
		if (!match) return undefined;
		return { type: 'footnoteDefinitionAsText', raw: match[0], text: match[0].trimEnd() };
	},
	renderer: (token) => `<p>${escapeHtml(token.text)}</p>\n`
};

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

const parser = new Marked({ async: false, gfm: true }).use({
	extensions: [footnoteDefinitionAsText, footnoteReferenceAsText]
});

const ALLOWED_TAGS = (
	'p br hr em strong i b u del s sup sub a code pre blockquote ul ol li dl dt dd ' +
	'h1 h2 h3 h4 h5 h6 table thead tbody tr th td span'
).split(' ');

export function renderDescription(markdown: string): string {
	if (!isDescriptionRendererSupported()) throw new DescriptionRendererUnavailableError();
	return DOMPurify.sanitize(parser.parse(markdown) as string, {
		ALLOWED_TAGS,
		ALLOWED_ATTR: ['href', 'title', 'lang', 'dir', 'colspan', 'rowspan'],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		KEEP_CONTENT: true
	});
}
