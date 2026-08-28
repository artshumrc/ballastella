// What the drawing toolbar announces and offers, asserted against the component.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE, AND WHERE THE LINE IS
//
// "The active tool is announced" is a claim about this toolbar's own markup: it composes the
// sentence out of the tool's name and the status it is handed, and puts it in a region that is
// already on the page so that a change of text is announced rather than an arrival. Reaching that in
// `e2e/` cost a Project, a built application, a real MapLibre and a click on the canvas.
//
// ⚠ **The status sentences themselves are not this component's and are not asserted here.** "1 point
// placed, 2 more to finish" is `AnnotationDrawing`'s, which is a class with no DOM and its own Node
// tests; this file hands the toolbar a status and asserts what it does *with* one. And the gesture
// that produces each status — clicking the map — stays in `e2e/`, where there is a canvas, which is
// also what proves this component is really mounted and really fed by the drawing state.

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationTools from './AnnotationTools.svelte';
import type { AnnotationTool } from './drawing.svelte';

const handlers = () => ({
	onnew: vi.fn(),
	onchoose: vi.fn(),
	onfinish: vi.fn(),
	oncancel: vi.fn(),
	onundovertex: vi.fn()
});

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const toolbar = (options: {
	tool?: AnnotationTool;
	picking?: boolean;
	status?: string;
	drawing?: boolean;
	canFinish?: boolean;
}): ReturnType<typeof handlers> => {
	const spies = handlers();
	mounted = mount(AnnotationTools, {
		target: document.body,
		props: {
			tool: options.tool ?? 'select',
			picking: options.picking ?? false,
			status: options.status ?? '',
			drawing: options.drawing ?? false,
			canFinish: options.canFinish ?? false,
			...spies
		}
	});
	flushSync();
	return spies;
};

const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('the tool in hand is announced, not only drawn', () => {
	test('the sentence names the tool and then says what to do with it', () => {
		toolbar({ tool: 'polygon', picking: true, status: 'Click the map to start.' });

		// **The name is in the sentence, because the criterion is that the tool is *announced* and a
		// highlight is not an announcement.** `data-tool` is a test attribute and reaches nobody.
		expect(one('annotation-status')).toHaveTextContent('Shape tool. Click the map to start.');
	});

	test('the region is there before there is anything to say', () => {
		// `aria-live` announces a change of text in a region that is *already present*, so an element
		// that came and went with the status would announce nothing at all. It is `sr-only` while empty
		// rather than removed — which also takes the reserved line out of the layout.
		toolbar({ status: '' });

		const status = one('annotation-status')!;
		expect(status).toBeInTheDocument();
		expect(status).toHaveTextContent('');
		expect(status).toHaveClass('sr-only');
		// `aria-live` rather than `role="status"`, because the save indicator already owns that role on
		// this page; `aria-atomic`, so the whole sentence is read rather than the words that changed.
		expect(status).toHaveAttribute('aria-live', 'polite');
		expect(status).toHaveAttribute('aria-atomic', 'true');
	});

	test('each tool is announced by its own name', () => {
		for (const [tool, name] of [
			['point', 'Pin tool.'],
			['line', 'Line tool.'],
			['polygon', 'Shape tool.'],
			['text', 'Label tool.']
		] as const) {
			toolbar({ tool, picking: true, status: 'Click the map.' });
			expect(one('annotation-status')).toHaveTextContent(name);

			unmount(mounted!);
			mounted = undefined;
			document.body.innerHTML = '';
		}
	});
});

describe('the toolbar reaches assistive technology and the keyboard', () => {
	test('the shapes are one named set of alternatives, each a pressed-state button', () => {
		toolbar({ tool: 'line', picking: true });

		const tools = one('annotation-tools')!;
		expect(tools).toHaveAttribute('role', 'toolbar');
		expect(tools).toHaveAccessibleName('Annotation tools');

		// Four shapes and no fifth: selecting is what the Layer does when nobody is drawing, not a tool a
		// scholar is asked to pick. The fourth is the Label, reached the same way as the other three — one
		// press of *New Annotation*, then choose.
		const buttons = [...tools.querySelectorAll('button')];
		expect(buttons).toHaveLength(4);
		expect(buttons.map((button) => button.getAttribute('aria-pressed'))) //
			.toEqual(['false', 'true', 'false', 'false']);
		// The glyph goes beside each name, never instead of it — and the word beside the Label's glyph is
		// "Label", never the `'text'` the union spells it.
		expect(buttons.map((button) => button.textContent?.trim())) //
			.toEqual(['Pin', 'Line', 'Shape', 'Label']);
	});

	test('resting, there is one button and the shapes are behind it', () => {
		toolbar({ picking: false });

		expect(one('annotation-new')).toHaveTextContent('New Annotation');
		expect(all('annotation-tools')).toHaveLength(0);
	});

	test('choosing a shape reports it rather than deciding it here', async () => {
		const spies = toolbar({ picking: true });

		await press(one('annotation-tool-point')!);

		// Which tool is in hand is the page's, because it is also what a click on the map does — a copy
		// held here would be a second thing that could disagree.
		expect(spies.onchoose).toHaveBeenCalledWith('point');
	});

	test('the Label button reports the tool the union spells, not the word on it', async () => {
		const spies = toolbar({ picking: true });

		await press(one('annotation-tool-text')!);

		expect(spies.onchoose).toHaveBeenCalledWith('text');
	});
});

describe('a gesture in progress gets the controls a gesture needs, and only then', () => {
	test('Cancel is offered while choosing, while Done and Undo wait for a point', () => {
		toolbar({ tool: 'polygon', picking: true, drawing: false });

		expect(all('annotation-done')).toHaveLength(0);
		expect(all('annotation-undo-vertex')).toHaveLength(0);
		expect(one('annotation-cancel')).toBeInTheDocument();
	});

	test('Done is refused until the shape is one', () => {
		toolbar({ tool: 'polygon', picking: true, drawing: true, canFinish: false });

		expect(one('annotation-done')).toBeDisabled();
		expect(one('annotation-undo-vertex')).toBeInTheDocument();
		expect(one('annotation-cancel')).toBeInTheDocument();
	});

	test('Done finishes a valid gesture', async () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: true, canFinish: true });

		await press(one('annotation-done')!);

		expect(spies.onfinish).toHaveBeenCalled();
	});

	test('Cancel abandons a gesture in progress and puts the tools away', async () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: true, canFinish: true });

		await press(one('annotation-cancel')!);

		expect(spies.oncancel).toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});

	test('Cancel with nothing in flight cancels nothing', async () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: false });

		await press(one('annotation-cancel')!);

		expect(spies.oncancel).not.toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});
});
