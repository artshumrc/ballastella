<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The one menu, in both apps.
	 *
	 * The Popover API — `popover` plus `popovertarget` — is **mandated, not merely available**
	 * (ADR-0016), and for the same reason `<dialog>` is: daisyUI documents a `<details>` dropdown and
	 * a CSS-`:focus` dropdown as well, neither of which dismisses on Escape or on a click elsewhere,
	 * and an implementer copying whichever snippet they land on produces a different accessibility
	 * outcome each time. Both of those are named as *banned* in CONTRIBUTING. This component exists so
	 * the decision is made once and every later slice inherits it.
	 *
	 * ⚠ **`apps/editor/src/lib/components/MenuPopover.svelte` is the same file and has not gone yet.**
	 * Its remaining consumer is `ProjectScreen.svelte`; moving that one import here belongs with the
	 * rewrite of that screen. Change both or neither.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHAT IT OWNS THAT A HAND-ROLLED ONE FORGETS
	 *
	 * - **A hydration-stable id.** `popovertarget` is an *id reference*, so the button and the
	 *   popover have to agree on a string that is the same on the server and in the browser and
	 *   unique if two of these are ever on one screen. `$props.id()` is what gives that; a hardcoded
	 *   id is a collision waiting for the second instance.
	 * - **Positioning under its own button.** A popover is in the top layer and therefore has no
	 *   ancestor containing block, so an `absolute` offset resolves against the viewport. CSS anchor
	 *   positioning is what ties it to the button, and the plain declarations before it are the
	 *   fallback a browser without anchor positioning gets — a menu below the bar rather than one in
	 *   the middle of the screen.
	 * - **Saying whether it is open, to the page and to a screen reader.** `aria-expanded` on the
	 *   button comes off the same signal the page reads, so the two cannot disagree.
	 * - **Telling the page whether it is open, at the instant it asks.** Escape dismisses a popover
	 *   natively *and* keeps propagating, so a page with its own Escape handling — the Project screen
	 *   abandons a part-drawn shape on Escape — will act on the keypress that only closed this menu.
	 *   {@link isOpen} answers that question, and it reads `:popover-open` off the element rather than
	 *   reporting reactive state: the `toggle` event lands and Svelte flushes on its own schedule, so a
	 *   second Escape arriving in that window would find a flag that still said "open" and be declined
	 *   as well — measured, and it cost the *cancel* the user actually asked for. The DOM cannot lag
	 *   behind itself.
	 */
	let {
		label,
		ariaLabel = label,
		open = $bindable(false),
		buttonClass = 'btn btn-sm',
		menuClass = 'menu w-64 p-0',
		flush = false,
		theme,
		align = 'start',
		testid,
		buttonSuffix,
		children
	}: {
		/** The button's visible text. Visible words, never an icon with a tooltip. */
		label: string;
		/** The button and menu's accessible name when the visible words need more context. */
		ariaLabel?: string;
		/** Whether the menu is showing. Bindable, so a page can tell an Escape for it from its own. */
		open?: boolean;
		buttonClass?: string;
		menuClass?: string;
		flush?: boolean;
		/** The daisyUI theme for the popover's own surface, independent of themed menu items. */
		theme?: string;
		/**
		 * Which of the button's edges the menu hangs from.
		 *
		 * `end` for a button at the right-hand end of a bar: at 375 px a 16 rem menu opening rightward
		 * from there is a menu three quarters of the way off the screen. It is not a preference — it is
		 * the difference between a usable menu and an unreachable one on the width most Readers arrive
		 * at.
		 */
		align?: 'start' | 'end';
		/** Test id for the button; the popover gets `<testid>-menu`. */
		testid?: string;
		/** Optional content rendered after the button's visible label. */
		buttonSuffix?: Snippet;
		/** The menu's items, rendered inside its `<ul>`. Each should be a `<li>` with a control. */
		children: Snippet;
	} = $props();

	const id = $props.id();

	let button_ = $state<HTMLButtonElement | undefined>();
	let popover = $state<HTMLElement | undefined>();

	/**
	 * Close the menu and put focus back on the button that opens it.
	 *
	 * Exported so a menu item can hand focus back *before* it opens something else — see
	 * `ProjectScreen`'s settings item. A modal restores focus to whatever was focused when it called
	 * `showModal()`, and a menu item inside a popover that no longer exists by then is not a place to
	 * land.
	 */
	export function dismiss(): void {
		popover?.hidePopover();
		button_?.focus();
	}

	/**
	 * Whether the menu is showing **right now**, asked of the element.
	 *
	 * For a handler that has to decide inside one keypress. `:popover-open` is the top layer's own
	 * answer and is true for exactly as long as the popover is up — including during the `keydown`
	 * that is about to dismiss it, because light-dismiss is the event's default action and runs after
	 * dispatch. That is what makes "decline this Escape, it was for the menu" correct on the first
	 * press and, crucially, *incorrect* on the next one.
	 */
	export function isOpen(): boolean {
		return popover?.matches(':popover-open') ?? false;
	}

	/**
	 * The button that opens this menu, for a caller that has to put focus back on it later.
	 *
	 * {@link dismiss} covers the ordinary case — a menu item that closes the menu and stops. This is
	 * for an item that *opens something inline*, where focus has to return here when that thing is
	 * dismissed, which may be many interactions later. Handing back the element rather than a second
	 * `focus()` method keeps the caller's own "where did this come from" explicit.
	 */
	export function button(): HTMLButtonElement | undefined {
		return button_;
	}
</script>

<button
	type="button"
	class={buttonClass}
	popovertarget={id}
	bind:this={button_}
	data-testid={testid}
	aria-label={ariaLabel}
	aria-expanded={open}
	aria-controls={id}
	style="anchor-name: --{id}"
>
	{label}
	{#if buttonSuffix}{@render buttonSuffix()}{/if}
</button>

<div
	{id}
	popover="auto"
	bind:this={popover}
	data-testid={testid ? `${testid}-menu` : undefined}
	data-theme={theme}
	class="menu-popover rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
	class:menu-popover-flush={flush}
	class:menu-popover-end={align === 'end'}
	aria-label={ariaLabel}
	style="position-anchor: --{id}"
	ontoggle={(event) => (open = (event as ToggleEvent).newState === 'open')}
>
	<!-- Wide enough for an item's icon and its label on one line: at `w-56` "Choose Workspace
	     folder…" wrapped, and a wrapped item in a list of one-line items reads as two items. -->
	<ul class={menuClass}>
		{@render children()}
	</ul>
</div>

<style>
	/*
		Plain declarations first — the fallback for a browser with no anchor positioning — then the
		anchored ones, which put the menu under its own button. `position-anchor` itself is set inline,
		because the anchor name is per instance and a scoped stylesheet cannot know it.
	*/
	.menu-popover {
		position: fixed;
		top: 5rem;
		left: 1rem;
		margin: 0;
	}

	.menu-popover-end {
		left: auto;
		right: 1rem;
	}

	.menu-popover-flush {
		padding: 0;
	}

	/*
		⚠ **The fallback's insets have to be given back.** `position-area` does not replace `top`/`left`,
		it changes what they resolve against: the area box rather than the viewport. Left in place, they
		offset the menu a further 5rem down and 1rem right of the button it is supposed to sit under —
		which is not a near miss but the menu adrift in the middle of the screen.
	*/
	@supports (position-area: bottom span-right) {
		.menu-popover {
			inset: auto;
			position-area: bottom span-right;
			margin-top: 0.25rem;
		}

		.menu-popover-end {
			position-area: bottom span-left;
		}
	}
</style>
