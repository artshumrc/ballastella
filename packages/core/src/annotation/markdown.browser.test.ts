// The `description` rendering pipeline (ADR-0009), asserted on what it produces.
//
// **A browser project rather than the Node one, and not by preference.** DOMPurify sanitises by
// parsing into a real DOM and walking it, so in Node it reports `isSupported: false` and has no
// `sanitize` method at all — there is nothing here that a Node stub could assert without asserting
// against the stub. It runs in Chromium *and* Firefox, which is the same reasoning
// `vitest.config.ts` records for the storage adapters: this is the one surface in the epic where a
// bug is a vulnerability, and a claim about browsers asserted in one engine is not asserted.
//
// Every assertion here is on the **rendered output**, never on the pipeline's shape. "DOMPurify is in
// the call chain" is not a security property; "no `on*` attribute survives" is.

import { describe, expect, test } from 'vitest';

import {
	isDescriptionRendererSupported,
	renderAnnotationPopup,
	renderDescription
} from './markdown.js';

/** The rendered HTML as a live DOM, which is the only honest place to ask what survived. */
function render(markdown: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = renderDescription(markdown);
	return host;
}

/** Every attribute name anywhere in a rendered fragment. */
function attributeNames(host: HTMLElement): string[] {
	const names = new Set<string>();
	for (const element of host.querySelectorAll('*')) {
		for (const attribute of element.attributes) names.add(attribute.name.toLowerCase());
	}
	return [...names].sort();
}

/** Every URL-bearing attribute value anywhere in a rendered fragment. */
function urls(host: HTMLElement): string[] {
	const found: string[] = [];
	for (const element of host.querySelectorAll('*')) {
		for (const name of ['href', 'src', 'xlink:href', 'action', 'formaction']) {
			const value = element.getAttribute(name);
			if (value !== null) found.push(value);
		}
	}
	return found;
}

/**
 * `text` without any character at or below the space.
 *
 * Browsers skip those when parsing a URL's scheme, so `java\tscript:` and a leading newline are both
 * `javascript:` to a navigation and are the classic way past a naive string check. Written as a
 * codepoint filter rather than a regex because a character class naming them would embed control
 * characters, which `no-control-regex` forbids — rightly, since they are invisible in a diff.
 */
const stripBlanks = (text: string): string =>
	[...text].filter((character) => (character.codePointAt(0) ?? 0) > 0x20).join('');

/**
 * The URLs in a rendered fragment that carry a scheme capable of executing.
 *
 * Returned as a list and asserted empty, rather than looped over and asserted inside the loop: a
 * payload that produced no URLs at all would run no assertion, and `vitest.config.ts` sets
 * `requireAssertions` precisely because a test that asserts nothing is the vacuous-pass shape this
 * epic has been caught by on every ticket so far.
 */
function executableUrls(host: HTMLElement): string[] {
	return urls(host).filter((url) => /^(javascript|data|vbscript):/i.test(stripBlanks(url)));
}

test('the renderer is available in a browser', () => {
	// The counterpart of the Node refusal, and the reason this whole file is a browser project.
	expect(isDescriptionRendererSupported()).toBe(true);
});

describe('what a scholar writes (SPEC story 62)', () => {
	test('emphasis renders', () => {
		const host = render('A *conjectural* route, and a **certain** one.');

		expect(host.querySelector('em')?.textContent).toBe('conjectural');
		expect(host.querySelector('strong')?.textContent).toBe('certain');
	});

	test('a link renders, with its href intact', () => {
		const host = render('See [the survey](https://example.org/survey#plate-4).');

		const link = host.querySelector('a');
		expect(link?.textContent).toBe('the survey');
		expect(link?.getAttribute('href')).toBe('https://example.org/survey#plate-4');
	});

	test('ordinary block structure survives', () => {
		const host = render('# Warehouses\n\n- one\n- two\n\n> quoted\n');

		expect(host.querySelector('h1')?.textContent).toBe('Warehouses');
		expect(host.querySelectorAll('li')).toHaveLength(2);
		expect(host.querySelector('blockquote')?.textContent).toContain('quoted');
	});
});

describe('footnote syntax degrades to literal text (ADR-0009)', () => {
	// ADR-0009 defers footnotes and asks that the syntax degrade "as behaviour, not accident". These
	// are the assertions that make it behaviour: measured against `marked` 18.0.9, the second case
	// below renders `A claim<a href="…">^1</a> worth noting.` with the definition line deleted, because
	// `^1` is a legal CommonMark link label and so `[^1]: <url>` really is a link reference
	// definition. An anchor is exactly what the criterion forbids, and the silent loss of the note's
	// prose is worse than the markup.

	test('a reference with no definition is text', () => {
		const host = render('A claim[^1] worth noting.');

		expect(host.textContent?.trim()).toBe('A claim[^1] worth noting.');
		expect(host.querySelectorAll('a')).toHaveLength(0);
	});

	test('a reference whose definition is a bare URL is still text, and the definition is kept', () => {
		const host = render('A claim[^1] worth noting.\n\n[^1]: https://example.org/note');

		expect(host.querySelectorAll('a')).toHaveLength(0);
		expect(host.textContent).toContain('A claim[^1] worth noting.');
		// The definition line is not swallowed: the user's words are on the page.
		expect(host.textContent).toContain('[^1]: https://example.org/note');
	});

	test('a definition with a title produces no anchor and no title attribute', () => {
		const host = render('Text[^a]\n\n[^a]: https://example.org/n "A note"');

		expect(host.querySelectorAll('a')).toHaveLength(0);
		expect(attributeNames(host)).not.toContain('title');
	});

	test('no ids anywhere, which is what several popups on one page would collide over', () => {
		const host = render('One[^1] and two[^2].\n\n[^1]: first\n[^2]: second\n');

		expect(attributeNames(host)).not.toContain('id');
		expect(host.querySelectorAll('[id]')).toHaveLength(0);
	});

	test('a footnote definition cannot smuggle a javascript: anchor', () => {
		const host = render('Text[^1]\n\n[^1]: javascript:window.__xss=1');

		expect(host.querySelectorAll('a')).toHaveLength(0);
		expect(executableUrls(host)).toEqual([]);
	});
});

describe('a description is untrusted (ADR-0009)', () => {
	/**
	 * The payloads. Each one **survives `marked` and must not survive DOMPurify**, which is what makes
	 * this suite prove the *order* rather than merely the presence of a sanitiser: verified against
	 * `marked` 18.0.9, raw `<script>`, `onerror`, `onclick`, and a `javascript:` href all pass through
	 * the parser untouched, so a sanitise-then-parse implementation reconstructs every one of them and
	 * fails here — while still passing a naive "is the input escaped" test.
	 */
	const payloads: readonly [string, string][] = [
		['a script element', '<script>window.__xss=1</script>'],
		['an image error handler', '<img src=x onerror="window.__xss=1">'],
		['a click handler', '<p onclick="window.__xss=1">hi</p>'],
		['a javascript: link written as Markdown', '[click](javascript:window.__xss=1)'],
		['a javascript: link written as HTML', '<a href="javascript:window.__xss=1">click</a>'],
		['a data: link', '[click](data:text/html,<script>window.__xss=1</script>)'],
		[
			'a data: link written as HTML',
			'<a href="data:text/html,&lt;script&gt;1&lt;/script&gt;">x</a>'
		],
		['an svg onload', '<svg onload="window.__xss=1"></svg>'],
		['an iframe', '<iframe src="javascript:window.__xss=1"></iframe>'],
		['a form action', '<form action="javascript:window.__xss=1"><button>go</button></form>'],
		['a style element', '<style>body{background:url("javascript:1")}</style>'],
		['a mixed-case handler', '<IMG SRC=x OnErRoR="window.__xss=1">'],
		['an entity-encoded scheme', '<a href="java&#115;cript:window.__xss=1">x</a>'],
		['a body onload', '<body onload="window.__xss=1">'],
		['an object element', '<object data="javascript:window.__xss=1"></object>']
	];

	test.each(payloads)('%s leaves no script element', (_name, payload) => {
		const host = render(payload);

		expect(host.querySelectorAll('script')).toHaveLength(0);
		expect(host.innerHTML.toLowerCase()).not.toContain('<script');
	});

	test.each(payloads)('%s leaves no on* attribute', (_name, payload) => {
		const host = render(payload);

		expect(attributeNames(host).filter((name) => name.startsWith('on'))).toEqual([]);
	});

	test.each(payloads)('%s leaves no javascript: or data: URL', (_name, payload) => {
		const host = render(payload);

		expect(executableUrls(host)).toEqual([]);
	});

	test.each(payloads)('%s leaves no img element to carry a handler', (_name, payload) => {
		const host = render(payload);

		expect(host.querySelectorAll('img')).toHaveLength(0);
	});

	test('the payload ticket 13 stored is inert, and its text is still readable', () => {
		// Byte-for-byte the payload `e2e/editor-transfer.e2e.ts` proved reaches storage unchanged. That
		// test could only assert that import never inserted it; closing it is this, plus the same
		// payload rendered in the running app in `e2e/editor-annotations.e2e.ts`.
		const host = render('<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>');

		expect(host.querySelectorAll('img, script')).toHaveLength(0);
		expect(attributeNames(host)).toEqual([]);
	});

	test('a payload written in Markdown syntax is inert, which is what proves the order', () => {
		// **The order assertion, and the one test in this file whose failure mode is specifically a
		// reversed pipeline.** Measured by reversing `renderDescription` to sanitise-then-parse: 148 of
		// these 152 tests still passed, and these payloads were the ones that broke.
		//
		// The reason is the whole of ADR-0009's warning. `[click](javascript:…)` contains **no HTML at
		// all** — to a sanitiser it is inert text, and DOMPurify correctly passes it through untouched. A
		// parser downstream of the sanitiser then reconstructs `<a href="javascript:…">` out of text
		// that had already been cleared. So a sanitise-then-parse implementation passes a naive "is the
		// input escaped" test — the input genuinely is — and ships a live XSS vector.
		//
		// An HTML payload such as `<img onerror>` cannot make this distinction: DOMPurify removes it in
		// either order, so a test built on one would report the order as correct when it was not.
		for (const markdown of [
			'[click](javascript:window.__xss=1)',
			'[click](data:text/html,<script>window.__xss=1</script>)'
		]) {
			const host = render(markdown);

			expect(executableUrls(host)).toEqual([]);
		}
	});

	test('an HTML payload is removed after the parse, not before it', () => {
		// The complement: this input is *already HTML* and contains no Markdown, so `marked` returns it
		// verbatim and everything that removes it happens strictly after the parse.
		const host = render('<img src=x onerror="window.__xss=1">');

		expect(host.innerHTML).not.toContain('onerror');
		expect(host.innerHTML).not.toContain('<img');
	});

	test('nothing executes while rendering', () => {
		const before = 'ballastellaXssProbe' in globalThis;
		render(
			'<img src=x onerror="globalThis.ballastellaXssProbe=1"><script>globalThis.ballastellaXssProbe=1</script>'
		);

		expect(before).toBe(false);
		expect('ballastellaXssProbe' in globalThis).toBe(false);
	});
});

describe('one value carrying prose and an attack together', () => {
	// The matrix `e2e/editor-annotations.e2e.ts` asserted through three rendered surfaces — the name in
	// the list, the description preview, and the popup on the map. All three read the same pure
	// pipeline, so all three failed and passed together, and the browser was paying to find that out
	// three times. One Seam 2 test remains, on the popup, because whether the application *calls* this
	// pipeline is a wiring question no test here can fail for.
	//
	// The payload is written out rather than imported from anywhere the application reads: a fixture
	// that shares a source with the thing it tests agrees with it however wrong both are (see the
	// header of `e2e/support/reader-project.ts`).

	/**
	 * Prose that **must survive**, carried in the same value as the attack.
	 *
	 * The anti-vacuous half. A surface that renders *nothing* passes every "no script, no handler, no
	 * dangerous URL" assertion perfectly, so legitimate content in the same string is what proves the
	 * output is live before its emptiness of markup means anything.
	 */
	const PROSE = 'The **west** quay, per the survey.';

	/**
	 * The payload ticket 13 proved reaches storage byte-identical, plus a `javascript:` link.
	 *
	 * The `javascript:` link is Markdown rather than HTML deliberately: it contains no markup, so a
	 * sanitise-then-parse implementation passes it through as inert text and then reconstructs an
	 * `<a href="javascript:…">` out of it. That is the bypass ADR-0009 names, and the one payload here
	 * that can tell the two possible orders apart — an `<img onerror>` is removed in either.
	 */
	const PAYLOAD =
		`${PROSE}` +
		'<img src=x onerror="window.__xss=1">' +
		'<script>window.__xss=1</script>' +
		'[click](javascript:window.__xss=1)' +
		'<a href="data:text/html,&lt;script&gt;1&lt;/script&gt;">d</a>' +
		'<svg onload="window.__xss=1"></svg>';

	/** Everything a rendered fragment must not contain, asked of a live DOM. */
	function inert(host: HTMLElement) {
		return {
			scripts: host.querySelectorAll('script').length,
			images: host.querySelectorAll('img').length,
			svgs: host.querySelectorAll('svg').length,
			iframes: host.querySelectorAll('iframe').length,
			ids: host.querySelectorAll('[id]').length,
			handlers: attributeNames(host).filter((name) => name.startsWith('on')),
			executableUrls: executableUrls(host)
		};
	}

	const nothing = {
		scripts: 0,
		images: 0,
		svgs: 0,
		iframes: 0,
		ids: 0,
		handlers: [],
		executableUrls: []
	};

	test('the description renders its prose and none of its markup', () => {
		const host = render(PAYLOAD);

		// The prose first: the surface has to be shown to be live before its emptiness means anything.
		expect(host.querySelector('strong')?.textContent).toBe('west');
		expect(host.textContent).toContain('The west quay, per the survey.');
		expect(inert(host)).toEqual(nothing);
		// DOMPurify **removes** a disallowed element rather than escaping it, so the payload's own
		// characters do not survive here as text either. There was never anything to show.
		expect(host.textContent).not.toContain('onerror');
	});

	test('the same payload in the popup, where it is the title as well as the description', () => {
		const host = document.createElement('div');
		host.innerHTML = renderAnnotationPopup({ title: PAYLOAD, description: PAYLOAD });

		expect(inert(host)).toEqual(nothing);
		// A title is text rather than Markdown, so its characters survive as characters — which is the
		// opposite outcome from the description above, and the reason both are asserted.
		expect(host.textContent).toContain('onerror');
		expect(host.textContent).toContain('The **west** quay');
		expect(host.querySelector('strong')?.textContent).toBe('west');
	});

	test('nothing ran, and nothing the payload asked for reached the document', () => {
		const host = render(PAYLOAD);
		document.body.append(host);

		try {
			expect('__xss' in window).toBe(false);
			expect(document.querySelector('img[src="x"]')).toBeNull();
			// The payload's *own* text inside a script, not any script element: the page legitimately has
			// its own, and a probe that cries wolf is a probe that gets loosened away.
			expect(
				[...document.querySelectorAll('script')].some((script) =>
					(script.textContent ?? '').includes('__xss')
				)
			).toBe(false);
		} finally {
			host.remove();
		}
	});
});

describe('the popup, where the title is untrusted too', () => {
	test('renders a title and a description', () => {
		const host = document.createElement('div');
		host.innerHTML = renderAnnotationPopup({
			title: 'Warehouses',
			description: 'The *west* quay.'
		});

		expect(host.textContent).toContain('Warehouses');
		expect(host.querySelector('em')?.textContent).toBe('west');
	});

	test('a payload in the title is inert', () => {
		// The surface most likely to be missed: a description obviously holds a stranger's prose,
		// whereas a title looks like a label. A sanitiser applied to one of a feature's two text fields
		// is a vulnerability with a passing test.
		const host = document.createElement('div');
		host.innerHTML = renderAnnotationPopup({
			title: '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>'
		});

		expect(host.querySelectorAll('img, script')).toHaveLength(0);
		expect(attributeNames(host).filter((name) => name.startsWith('on'))).toEqual([]);
		// And the title is shown as the text it is, rather than silently dropped.
		expect(host.textContent).toContain('<img src=x onerror=');
	});

	test('a payload in the title cannot break out of the attribute it is written into', () => {
		const host = document.createElement('div');
		host.innerHTML = renderAnnotationPopup({ title: '" onmouseover="window.__xss=1" x="' });

		expect(attributeNames(host).filter((name) => name.startsWith('on'))).toEqual([]);
		expect(host.textContent).toContain('onmouseover');
	});

	test('nothing at all renders as nothing', () => {
		expect(renderAnnotationPopup({})).toBe('');
		expect(renderAnnotationPopup({ title: '', description: '' })).toBe('');
	});
});
