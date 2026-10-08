import { describe, expect, test } from 'vitest';

import { isDescriptionRendererSupported, renderDescription } from './markdown.js';

function render(markdown: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = renderDescription(markdown);
	return host;
}

function attributeNames(host: HTMLElement): string[] {
	const names = new Set<string>();
	for (const element of host.querySelectorAll('*')) {
		for (const attribute of element.attributes) names.add(attribute.name.toLowerCase());
	}
	return [...names].sort();
}

const stripBlanks = (text: string): string =>
	[...text].filter((character) => (character.codePointAt(0) ?? 0) > 0x20).join('');

const executableUrls = (host: HTMLElement): string[] =>
	[...host.querySelectorAll('*')]
		.flatMap((element) =>
			['href', 'src', 'xlink:href', 'action', 'formaction'].map((name) =>
				element.getAttribute(name)
			)
		)
		.filter(
			(url): url is string => url !== null && /^(javascript|data|vbscript):/i.test(stripBlanks(url))
		);

test('the renderer is available in a browser', () => {
	expect(isDescriptionRendererSupported()).toBe(true);
});

describe('what a scholar writes', () => {
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
	test('a reference with no definition is text', () => {
		const host = render('A claim[^1] worth noting.');
		expect(host.textContent?.trim()).toBe('A claim[^1] worth noting.');
		expect(host.querySelectorAll('a')).toHaveLength(0);
	});

	test('a reference whose definition is a bare URL is still text, and the definition is kept', () => {
		const host = render('A claim[^1] worth noting.\n\n[^1]: https://example.org/note');
		expect(host.querySelectorAll('a')).toHaveLength(0);
		expect(host.textContent).toContain('A claim[^1] worth noting.');
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

	test.each(payloads)('%s leaves no script, handler, executable URL or img', (_name, payload) => {
		const host = render(payload);
		expect(host.querySelectorAll('script, img')).toHaveLength(0);
		expect(host.innerHTML.toLowerCase()).not.toContain('<script');
		expect(attributeNames(host).filter((name) => name.startsWith('on'))).toEqual([]);
		expect(executableUrls(host)).toEqual([]);
	});

	test('the payload an import stores is inert, and its text is still readable', () => {
		const host = render('<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>');
		expect(host.querySelectorAll('img, script')).toHaveLength(0);
		expect(attributeNames(host)).toEqual([]);
	});

	test('an HTML payload is removed after the parse, not before it', () => {
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
	const PROSE = 'The **west** quay, per the survey.';

	const PAYLOAD =
		`${PROSE}` +
		'<img src=x onerror="window.__xss=1">' +
		'<script>window.__xss=1</script>' +
		'[click](javascript:window.__xss=1)' +
		'<a href="data:text/html,&lt;script&gt;1&lt;/script&gt;">d</a>' +
		'<svg onload="window.__xss=1"></svg>';

	test('the description renders its prose and none of its markup', () => {
		const host = render(PAYLOAD);
		expect(host.querySelector('strong')?.textContent).toBe('west');
		expect(host.textContent).toContain('The west quay, per the survey.');
		expect(host.querySelectorAll('script, img, svg, iframe, [id]')).toHaveLength(0);
		expect(attributeNames(host).filter((name) => name.startsWith('on'))).toEqual([]);
		expect(executableUrls(host)).toEqual([]);
		expect(host.textContent).not.toContain('onerror');
	});

	test('nothing ran, and nothing the payload asked for reached the document', () => {
		const host = render(PAYLOAD);
		document.body.append(host);

		try {
			expect('__xss' in window).toBe(false);
			expect(document.querySelector('img[src="x"]')).toBeNull();
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
