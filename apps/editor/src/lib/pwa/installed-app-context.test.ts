// The one online signal, and what happens when a component asks for it from outside the layout.
//
// `HistoricalMapPane` reads `.online` in its load effect since ticket 07 — on the component that
// ticket deliberately made reusable — so a pane mounted outside the root layout used to throw
// `Cannot read properties of undefined (reading 'online')` from inside an effect, naming nothing.

import { describe, expect, it } from 'vitest';

import { installedAppOr } from './installed-app-context.js';

describe('asking for the app’s one online signal', () => {
	it('hands back the provided one', () => {
		// A stand-in rather than a real `InstalledApp`: constructing one would import
		// `installed-app.svelte.ts`, and that is the `$lib`/`$app` chain this module exists to be on the
		// other side of. What is under test is the guard, and the guard looks at nothing but presence.
		const app = { online: true } as unknown as Parameters<typeof installedAppOr>[0];
		expect(installedAppOr(app)).toBe(app);
	});

	it('refuses in words when there is none, naming the cause and the wrong fix', () => {
		expect(() => installedAppOr(undefined)).toThrow(/no InstalledApp in context/);
		// **And says why the obvious fix is wrong.** The tempting repair is to fall back to a fresh
		// `InstalledApp`, which is a second pair of `online`/`offline` listeners — banned outright by
		// ticket 07's out-of-scope list, because two answers to "is there a connection" is how a pane
		// and a Layer card come to disagree.
		expect(() => installedAppOr(undefined)).toThrow(/second pair of online\/offline listeners/);
	});
});
