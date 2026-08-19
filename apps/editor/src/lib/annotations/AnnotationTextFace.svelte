<script lang="ts">
	// The Annotation Inspector's Text face in the editor: the words, and the controls that change them
	// (the-annotation-inspector stories 30, 31, 35).
	//
	// **Text until somebody asks to change it**, which is the same rule the Layer card's name follows
	// and for the same reason: a column of bordered fields reads as a form to fill in, and this is
	// mostly a thing to *read*. At rest the description is the rendered Markdown a Reader sees, from
	// `@ballastella/ui`'s `AnnotationDescription`; *Edit text* turns the title and the description into
	// fields.
	//
	// **The title is not drawn here at all.** `AnnotationInspector`'s identity header, directly above
	// this face, already names the Annotation from the rule its row draws from (ADR-0035) — so a title
	// in the resting text would be the same words twice a few pixels apart in the same weight, which
	// reads as two fields rather than one (the-annotation-inspector story 4). The title is on screen as
	// a *field*, where it is labelled, or not at all.
	//
	// **And no preview beside the textarea**, for the same reason: the resting state is already the
	// rendered description, so a preview would be that rendering twice. The rendering itself is
	// `AnnotationDescription`'s — one `{@html}`, in `packages/ui`, fed nothing but DOMPurify's own
	// output.
	//
	// **Delete is here rather than on the row or in the Layer card's footer.** It acts on the Annotation
	// as a thing with content, which is this panel's half of the split; the card's footer would put two
	// deletes of different scope in one card. It stays undoable and has no confirmation dialog
	// (ADR-0014).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// **A LABEL IS THE ONE KIND WHOSE WORDS ARE A FIELD ON ARRIVAL** (write-on-the-map stories 11, 12,
	// 15, 17).
	//
	// For a Pin, a Line or a Shape the words are prose to *read* and *Edit text* turns them into a
	// form. For a Label the single field **is** the Annotation's content and the thing drawn on the
	// map, so a gate in front of it would make placing one and typing into "click, press Edit, type"
	// where story 4 asks for one gesture. It is therefore a field always, and there is no description
	// control beside it: a surface offering two kinds of prose would make an author choose which one
	// draws.
	//
	// **A description a stranger's file already carries is still rendered**, read-only, below the
	// field — nothing in a file is hidden because this app offers no control for it — and `setText`
	// writes it back untouched.

	import { isLabel, type Annotation } from '@ballastella/core';
	import { AnnotationDescription } from '@ballastella/ui';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { tick } from 'svelte';

	let {
		annotation,
		titling = false,
		ontext,
		ontitled,
		oncommit,
		ondelete
	}: {
		annotation: Annotation;
		/**
		 * Whether this Annotation has just been drawn, and so arrives with the keyboard in its title.
		 *
		 * Titling a shape straight after drawing it is one gesture (the-annotation-inspector story 40).
		 * `false` for every other way the Inspector opens: selecting an Annotation to *read* it must not
		 * put a form in front of the reader.
		 */
		titling?: boolean;
		/** Typing. Coalesced into one write per file (ADR-0017 rule 2). */
		ontext: (text: { title?: string; description?: string }) => void;
		/**
		 * The title field has the keyboard, so {@link titling} is **spent** and the consumer should stop
		 * saying it.
		 *
		 * ⚠ **Without this, one drawn shape opens its title field more than once.** This face is unmounted
		 * whenever the Inspector shows the Style face and mounted again on the way back, which resets
		 * `editingText` and re-runs the effect below — so a `titling` that was still true dragged the
		 * keyboard back into a title field a scholar had left minutes ago, on a press of *Text* they made
		 * to read the words. Titling a shape straight after drawing it is *one* gesture, and this is what
		 * makes it one: the offer is taken up once and then withdrawn.
		 */
		ontitled?: () => void;
		/** The edit is over — the field blurred, or Enter was pressed (ADR-0017 rule 1). */
		oncommit: () => void;
		ondelete: () => void;
	} = $props();

	const properties = $derived(annotation.properties);

	const geometryKind = $derived(annotation.geometry?.type ?? null);

	/** Whether this Annotation's words are the thing drawn on the map, rather than a title beside it. */
	const label = $derived(isLabel(annotation));

	/**
	 * Whether this Label's words would draw anything.
	 *
	 * **Whitespace, not `!== ''`.** MapLibre's shaping trims each line before it measures anything, so a
	 * title of one space draws nothing at all — `stack-layers.ts`'s `TITLE_WITHOUT_WHITESPACE` is the
	 * renderer saying so per feature — and a face that called a lone space "words" would withdraw the
	 * sentence at exactly the moment it became true.
	 *
	 * `trim` is deliberately the *broader* test rather than that expression's four characters: it also
	 * takes out a non-breaking space, which MapLibre does shape. Warning about a Label made of one
	 * invisible character is the harmless direction to be wrong in; staying silent about one that draws
	 * nothing is not.
	 */
	const drawsNothing = $derived((properties.title ?? '').trim() === '');

	/** Names the empty-Label sentence so the field can point at it (`aria-describedby`). */
	const emptyLabelId = $props.id();

	/**
	 * Whether the title and description are fields rather than text.
	 *
	 * Reset by the `$effect` below whenever a different Annotation arrives, because this face is reused
	 * rather than remounted: without it, selecting one Annotation while editing another's text would
	 * open the second one straight into a form nobody asked to edit. A freshly drawn Annotation is the
	 * one exception, and {@link titling} is how it says so.
	 */
	let editingText = $state(false);

	/** The field *Edit text* has just revealed, so it can be handed the keyboard. */
	let titleField = $state<HTMLInputElement | undefined>(undefined);

	/**
	 * The Annotation this face last reacted to.
	 *
	 * **The guard is the point, not bookkeeping.** `annotation` is a fresh object every time the
	 * collection is re-read — which is after every save, which is while somebody is typing — so an
	 * effect that merely reads `annotation.id` re-runs on each keystroke's write and would slam the
	 * fields shut mid-sentence. The suite caught exactly that: `fill()` landed, the save came back, and
	 * the field the next line tried to blur no longer existed. Comparing the id makes "a different
	 * Annotation arrived" the trigger, which is what this was always about — and it is the same guard
	 * `AnnotationInspector` uses to decide when the strip goes back to Text.
	 */
	let shown = $state('');

	$effect(() => {
		const id = annotation.id;
		if (id === shown) return;
		shown = id;
		// A shape just drawn opens straight into its title; anything else opens as text to read.
		if (titling) void takeUpTitling();
		else editingText = false;
	});

	/** Turn the text into fields, and put the keyboard in the first of them. */
	const editText = async (): Promise<void> => {
		// A Label's field is never gated, so there is nothing to reveal — only a keyboard to place.
		if (!label) editingText = true;
		await tick();
		titleField?.focus();
		titleField?.select();
	};

	/** Open the title field for a shape just drawn, and tell the consumer the offer has been taken up. */
	const takeUpTitling = async (): Promise<void> => {
		await editText();
		ontitled?.();
	};

	/**
	 * Leave the fields, committing whatever was typed.
	 *
	 * `oncommit` is a no-op unless something is pending, because tabbing through a field nobody typed
	 * in must not rewrite the file with a fresh `updatedAt` (ADR-0010, ADR-0017).
	 */
	const finishText = (): void => {
		oncommit();
		editingText = false;
	};
</script>

<div
	class="flex flex-col gap-3"
	data-testid="annotation-text-face"
	data-annotation-id={annotation.id}
>
	{#if label}
		<!--
			**One field, captioned for what it does.** "Label text" rather than "Title" because what is
			being typed and what appears on the map are the same thing; the identity header a few pixels
			above still owns the *name*, which is why nothing here draws `annotationName` a second time.

			Clearing it leaves no `"title": ""` behind — `setText` removes the property on an empty string,
			so a Label somebody emptied is not an empty label in another tool (story 17).
		-->
		<label class="floating-label">
			<span>Label text</span>
			<input
				bind:this={titleField}
				class="input w-full input-sm"
				value={properties.title ?? ''}
				data-testid="annotation-title"
				aria-describedby={drawsNothing ? emptyLabelId : undefined}
				oninput={(event) => ontext({ title: event.currentTarget.value })}
				onkeydown={(event) => {
					if (event.key === 'Escape') event.currentTarget.blur();
				}}
				onchange={() => oncommit()}
				onblur={() => oncommit()}
			/>
		</label>

		{#if drawsNothing}
			<!--
				**Ordinary text in the face, associated with the field** — not a tooltip and not a toast,
				because a tooltip is not an information channel (CONTRIBUTING). An Annotation placed and not
				finished is otherwise invisible on the map and indistinguishable from one that was never
				placed (story 15).
			-->
			<p id={emptyLabelId} class="text-sm opacity-70" data-testid="annotation-label-empty">
				This Label draws nothing on the map until it has words.
			</p>
		{/if}

		{#if properties.description}
			<!--
				**Rendered, read-only, and only when there is one.** This app offers a Label no description
				control, but a Label that arrived from another tool carrying prose must still show it —
				opening a stranger's file never hides what is in it (story 13). Rendered when it exists
				rather than always, because `AnnotationDescription` says "No description." for the absent
				case, which here would be an answer to a question nobody can ask.
			-->
			<AnnotationDescription {annotation} />
		{/if}
	{:else if editingText}
		<label class="floating-label">
			<span>Title</span>
			<input
				bind:this={titleField}
				class="input w-full input-sm"
				value={properties.title ?? ''}
				data-testid="annotation-title"
				oninput={(event) => ontext({ title: event.currentTarget.value })}
				onkeydown={(event) => {
					if (event.key === 'Escape') event.currentTarget.blur();
				}}
				onchange={() => oncommit()}
				onblur={() => oncommit()}
			/>
		</label>

		<label class="floating-label">
			<span>Description — Markdown</span>
			<!--
				A plain `<textarea>`, per ADR-0009. Typing coalesces into one write and the edit is
				committed when it *ends*; `oncommit` is a no-op unless something is pending, because
				tabbing through this field must not rewrite the file (ADR-0010).
			-->
			<textarea
				class="textarea w-full font-mono textarea-sm"
				rows="4"
				value={properties.description ?? ''}
				placeholder="*emphasis*, **strong**, and [links](https://example.org/)"
				data-testid="annotation-description"
				oninput={(event) => ontext({ description: event.currentTarget.value })}
				onchange={() => oncommit()}
				onblur={() => oncommit()}></textarea>
		</label>
	{:else}
		<AnnotationDescription {annotation} />

		{#if geometryKind === null || geometryKind === 'foreign'}
			<!--
				**The sentence is here rather than behind a Style tab of its own.** An Annotation whose shape
				this build cannot draw is passed no `style` snippet at all, so it has no Style tab — a tab
				that opened on an explanation of its own emptiness would be a control offered in order to be
				refused (the-annotation-inspector story 28). What is worth saying is said where the scholar
				already is, beside the half of the Annotation that is still theirs to edit.
			-->
			<p class="text-sm text-warning" data-testid="annotation-not-drawable">
				This Annotation's shape is one this version cannot draw, so it has no style controls. Its
				title and description are still yours to edit, and the shape is written back untouched.
			</p>
		{/if}
	{/if}

	<!--
		**Delete is beside the words in both states, and *Edit text* becomes *Done* between them.** What
		the two controls act on is different — one on the fields, one on the Annotation — so the delete is
		not something the fields can take away: a shape drawn a moment ago opens with its title as a
		field, and that is exactly the Annotation somebody is most likely to have drawn by accident.

		A Label has neither of the pair — its field is not gated, so there is nothing to open and nothing
		to finish — and the delete is the whole row.
	-->
	<div class="flex items-center gap-2">
		{#if editingText}
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-text-done"
				onclick={() => finishText()}
			>
				Done
			</button>
		{:else if !label}
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-edit-text"
				onclick={() => void editText()}
			>
				<Pencil size={14} aria-hidden="true" />
				Edit text<span class="sr-only"> — title and description</span>
			</button>
		{/if}

		<button
			type="button"
			class="btn btn-outline btn-error btn-sm"
			data-testid="annotation-delete"
			onclick={() => ondelete()}
		>
			<Trash2 size={14} aria-hidden="true" />
			Delete<span class="sr-only"> this Annotation</span>
		</button>
	</div>
</div>
