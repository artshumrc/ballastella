import { afterEach, describe, expect, test, vi } from 'vitest';

import { all, one, press, show, takeDown } from '$lib/test-support/dom';

import AnnotationTools from './AnnotationTools.svelte';
import type { AnnotationTool } from './drawing.svelte';

const handlers = () => ({
	onnew: vi.fn(),
	onchoose: vi.fn(),
	onfinish: vi.fn(),
	oncancel: vi.fn(),
	onundovertex: vi.fn()
});

afterEach(takeDown);

const toolbar = (options: {
	tool?: AnnotationTool;
	picking?: boolean;
	status?: string;
	drawing?: boolean;
	canFinish?: boolean;
}): ReturnType<typeof handlers> => {
	const spies = handlers();
	show(AnnotationTools, {
		tool: options.tool ?? 'select',
		picking: options.picking ?? false,
		status: options.status ?? '',
		drawing: options.drawing ?? false,
		canFinish: options.canFinish ?? false,
		...spies
	});
	return spies;
};

describe('the tool in hand is announced, not only drawn', () => {
	test('the sentence names the tool and then says what to do with it', () => {
		toolbar({ tool: 'polygon', picking: true, status: 'Click the map to start.' });
		expect(one('annotation-status')).toHaveTextContent('Shape tool. Click the map to start.');
	});

	test('the region is there before there is anything to say', () => {
		toolbar({ status: '' });
		const status = one('annotation-status')!;
		expect(status).toBeInTheDocument();
		expect(status).toHaveTextContent('');
		expect(status).toHaveClass('sr-only');
		expect(status).toHaveAttribute('aria-live', 'polite');
		expect(status).toHaveAttribute('aria-atomic', 'true');
	});

	test('each tool is announced by its own name', () => {
		for (const [tool, name] of [
			['point', 'Pin tool.'],
			['line', 'Line tool.'],
			['polygon', 'Shape tool.'],
			['circle', 'Circle tool.'],
			['text', 'Label tool.']
		] as const) {
			toolbar({ tool, picking: true, status: 'Click the map.' });
			expect(one('annotation-status')).toHaveTextContent(name);
			takeDown();
		}
	});
});

describe('the toolbar reaches assistive technology and the keyboard', () => {
	test('the shapes are one named set of alternatives, each a pressed-state button', () => {
		toolbar({ tool: 'line', picking: true });
		const tools = one('annotation-tools')!;
		expect(tools).toHaveAttribute('role', 'toolbar');
		expect(tools).toHaveAccessibleName('Annotation tools');
		const buttons = [...tools.querySelectorAll('button')];
		expect(buttons).toHaveLength(5);
		expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
			'false',
			'true',
			'false',
			'false',
			'false'
		]);
		expect(buttons.map((button) => button.textContent?.trim())).toEqual([
			'Pin',
			'Line',
			'Shape',
			'Circle',
			'Label'
		]);
	});

	test('resting, there is one button and the shapes are behind it', () => {
		toolbar({ picking: false });
		expect(one('annotation-new')).toHaveTextContent('New Annotation');
		expect(all('annotation-tools')).toHaveLength(0);
	});

	test('choosing a shape reports it rather than deciding it here', () => {
		const spies = toolbar({ picking: true });
		press('annotation-tool-point');
		expect(spies.onchoose).toHaveBeenCalledWith('point');
	});

	test('the Label button reports the tool the union spells, not the word on it', () => {
		const spies = toolbar({ picking: true });
		press('annotation-tool-text');
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

	test('Done finishes a valid gesture', () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: true, canFinish: true });
		press('annotation-done');
		expect(spies.onfinish).toHaveBeenCalled();
	});

	test('Cancel abandons a gesture in progress and puts the tools away', () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: true, canFinish: true });
		press('annotation-cancel');
		expect(spies.oncancel).toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});

	test('Cancel with nothing in flight cancels nothing', () => {
		const spies = toolbar({ tool: 'polygon', picking: true, drawing: false });
		press('annotation-cancel');
		expect(spies.oncancel).not.toHaveBeenCalled();
		expect(spies.onchoose).toHaveBeenCalledWith('select');
	});
});
