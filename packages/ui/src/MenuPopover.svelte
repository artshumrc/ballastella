<script lang="ts">
	import type { Snippet } from 'svelte';

	/** - **Saying whether it is open, to the page and to a screen reader.** `aria-expanded` on the button comes off the same signal the page reads, so the two cannot disagree. */
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
		label: string;
		ariaLabel?: string;
		open?: boolean;
		buttonClass?: string;
		menuClass?: string;
		flush?: boolean;
		theme?: string;
		align?: 'start' | 'end';
		testid?: string;
		buttonSuffix?: Snippet;
		children: Snippet;
	} = $props();

	const id = $props.id();
	let button_ = $state<HTMLButtonElement | undefined>();
	let popover = $state<HTMLElement | undefined>();

	export function dismiss(): void {
		popover?.hidePopover();
		button_?.focus();
	}

	export function isOpen(): boolean {
		return popover?.matches(':popover-open') ?? false;
	}

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
	<ul class={menuClass}>
		{@render children()}
	</ul>
</div>

<style>
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
