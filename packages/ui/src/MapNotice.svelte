<script lang="ts">
	// A notice beside the map: the Base Map's archive did not answer, a Map Image's tiles stopped
	// arriving, this Layer could not be reached.
	//
	// Both apps say the same things about a map that is not drawing, and both already take the
	// *sentence* from `@ballastella/core` so that two deployments cannot describe one outage two ways.
	// What was still written twice was the presentation — the alert box, and the choice between
	// `role="alert"` and `aria-live`. This is that presentation, once, so a notice cannot be an alert
	// in one app and a live region in the other.
	//
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// THE ONE RULE, AND WHY IT IS HERE RATHER THAN AT EACH CALL SITE
	//
	//   | Appears and disappears with its text | `role="alert"`                                |
	//   | Always present, text changes         | `aria-live="polite"` with `aria-atomic="true"` |
	//
	// **An `aria-live` region is announced when its text changes, not when the element carrying it is
	// inserted.** So a live region inside an `{#if}` is a notice a screen-reader user never hears, and
	// an element inserted with its text already in it has to be an `alert` to be heard at all. This is
	// a recorded amendment to ADR-0016's `aria-live="polite"` mandate for status.
	//
	// It is the component's decision because it had already been got wrong: the viewer's own comment
	// flagged `base-map-notice` and `base-map-not-published` as `aria-live` regions inside `{#if}`
	// blocks — correct-looking at each call site, and inaudible. `shape` names what the notice *is*,
	// and the mapping to a mechanism is made here; a caller can no longer spell it a third way.
	//
	// ⚠ **`always-present` is a promise the caller has to keep, and this component cannot check it.**
	// It keeps the element rendered with an empty string; it cannot know whether the markup *around*
	// the call site is itself inserted after the text is decided. Both viewer notices were still
	// silent under this shape while they sat in a column built client-side once the Project file
	// resolved. Render an `always-present` notice where it exists from the first frame — see
	// ADR-0016's amendment, which carries the measurement.
	//
	// **`role="status"` is not available.** The save indicator owns that role for the whole editor, and
	// a second one makes `getByRole('status')` ambiguous — which is a hint that a screen-reader user
	// would have to disambiguate too.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// ⚠ THIS COMPONENT COMPOSES NO PROSE
	//
	// Every sentence arrives from the consumer, and the four that matter are core's:
	// `baseMapFallbackNotice`, `baseMapUnavailableNotice`, `baseMapNotPublishedNotice` and
	// `mapImageTilesUnavailableNotice`. A sentence written in here would be published by both
	// apps to two different users, which is precisely how a Reader ends up being told to press a
	// button their app does not have.

	import type { Snippet } from 'svelte';

	let {
		shape,
		text,
		heading,
		variant = 'warning',
		testid,
		class: noticeClass,
		children
	}: {
		/**
		 * What this notice does over time, from which its mechanism follows.
		 *
		 * `comes-and-goes` renders nothing at all until there is something to say, and is then
		 * inserted as an `alert`. `always-present` keeps the element on the page with an empty string
		 * in it, so that its text arriving is a *change* and therefore announced.
		 */
		shape: 'comes-and-goes' | 'always-present';
		/** The sentence, from core. Empty or `null` means this notice has nothing to say. */
		text?: string | null;
		/** The notice's own heading, when it is a landmark a reader can be sent to. */
		heading?: string;
		/**
		 * `plain` is a line of explanatory text; the other two are daisyUI alert boxes.
		 *
		 * `info` says nothing is broken — no connection yet, and everything in the Workspace still
		 * works — where `warning` is something the user is being asked to do or expect less of.
		 */
		variant?: 'warning' | 'info' | 'plain';
		/** A handle for the notice as a whole, for the consumer whose tests address it. */
		testid?: string;
		/** Where the notice sits on its own page, in the consumer's terms — its margins and colour. */
		class?: string;
		/**
		 * The body, when it is not one sentence: a list of failures, or a sentence naming hosts.
		 *
		 * Handed over rather than composed here for the reason in the header — and a consumer that
		 * hands over none gets {@link text} as the body rather than an empty box.
		 */
		children?: Snippet;
	} = $props();

	/** Whether there is anything to show. A `comes-and-goes` notice with nothing to say is not there. */
	const something = $derived(children !== undefined || (text ?? '') !== '');
</script>

{#if shape === 'always-present' || something}
	<div
		role={shape === 'comes-and-goes' ? 'alert' : undefined}
		aria-live={shape === 'always-present' ? 'polite' : undefined}
		aria-atomic={shape === 'always-present' ? 'true' : undefined}
		class={[
			variant === 'warning' && 'alert flex-col items-start alert-warning',
			variant === 'info' && 'alert flex-col items-start alert-info',
			noticeClass
		]}
		data-testid={testid}
	>
		{#if heading}<h2 class="font-semibold">{heading}</h2>{/if}
		{#if children}{@render children()}{:else}<p>{text ?? ''}</p>{/if}
	</div>
{/if}
