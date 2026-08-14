// What the drawing toolbar announces and offers, asserted against the component (SPEC stories 57,
// 58, 59, 112).
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
	choosing?: boolean;
	status?: string;
	drawing?: boolean;
	canFinish?: boolean;
}): ReturnType<typeof handlers> => {
	const spies = handlers();
	mounted = mount(AnnotationTools, {
		target: document.body,
		props: {
			tool: options.tool ?? 'select',
			choosing: options.choosing ?? false,
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

describe('the tool in hand is announced, not only drawn (SPEC story 112)', () => {
	test('the sentence names the tool and then says what to do with it', () => {
		toolbar({ tool: 'polygon', choosing: true, status: 'Click the map to start a shape.' });

		// **The name is in the sentence, because the criterion is that the tool is *announced* and a
		// highlight is not an announcement.** `data-tool` is a test attribute and reaches nobody.
		expect(one('annotation-status')).toHaveTextContent(
			'Shape tool. Click the map to start a shape.'
		);
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
			['polygon', 'Shape tool.']
		] as const) {
			toolbar({ tool, choosing: true, status: 'Click the map.' });
			expect(one('annotation-status')).toHaveTextContent(name);

			unmount(mounted!);
			mounted = undefined;
			document.body.innerHTML = '';
		}
	});
});

describe('the toolbar reaches assistive technology and the keyboard', () => {
	test('the shapes are one named set of alternatives, each a pressed-state button', () => {
		toolbar({ tool: 'line', choosing: true });

		const tools = one('annotation-tools')!;
		expect(tools).toHaveAttribute('role', 'toolbar');
		expect(tools).toHaveAccessibleName('Annotation tools');

		// Three shapes and no fourth: selecting is what the Layer does when nobody is drawing, not a
		// tool a scholar is asked to pick.
		const buttons = [...tools.querySelectorAll('button')];
		expect(buttons).toHaveLength(3);
		expect(buttons.map((button) => button.getAttribute('aria-pressed'))) //
			.toEqual(['false', 'true', 'false']);
		// The glyph goes beside each name, never instead of it (SPEC story 111).
		expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Pin', 'Line', 'Shape']);
	});

	test('resting, there is one button and the shapes are behind it', () => {
		toolbar({ choosing: false });

		expect(one('annotation-new')).toHaveTextContent('New Annotation');
		expect(all('annotation-tools')).toHaveLength(0);
	});

	test('choosing a shape reports it rather than deciding it here', async () => {
		const spies = toolbar({ choosing: true });

		await press(one('annotation-tool-point')!);

		// Which tool is in hand is the page's, because it is also what a click on the map does — a copy
		// held here would be a second thing that could disagree.
		expect(spies.onchoose).toHaveBeenCalledWith('point');
	});
});

describe('a gesture in progress gets the controls a gesture needs, and only then', () => {
	test('Finish, Undo and Cancel are absent while nothing is being drawn', () => {
		toolbar({ tool: 'polygon', choosing: true, drawing: false });

		// So "Finish" is never a button that does nothing.
		expect(all('annotation-finish')).toHaveLength(0);
		expect(all('annotation-undo-vertex')).toHaveLength(0);
		expect(all('annotation-cancel')).toHaveLength(0);
	});

	test('Finish is offered but refused until the shape is one', () => {
		toolbar({ tool: 'polygon', choosing: true, drawing: true, canFinish: false });

		// Present and `disabled`, which is information a screen reader gets free from the markup —
		// rather than absent, which would move under the pointer as the third vertex lands.
		expect(one('annotation-finish')).toBeDisabled();
		expect(one('annotation-undo-vertex')).toBeInTheDocument();
		// Escape does the same from anywhere on the page; this is the pointer-reachable half of it,
		// which ADR-0016 asks for whenever a keystroke is the only route.
		expect(one('annotation-cancel')).toBeInTheDocument();
	});

	test('Done abandons a gesture in progress as well as putting the tools away', async () => {
		const spies = toolbar({ tool: 'polygon', choosing: true, drawing: true, canFinish: true });

		await press(one('annotation-tool-cancel')!);

		// Both, in that order: leaving the tools with two vertices still in flight would keep drawing
		// them on a map whose toolbar has gone.
		expect(spies.oncancel).toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});

	test('Done with nothing in flight cancels nothing', async () => {
		const spies = toolbar({ tool: 'polygon', choosing: true, drawing: false });

		await press(one('annotation-tool-cancel')!);

		expect(spies.oncancel).not.toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});
});
