<script lang="ts">
	// One Annotation's title, description, and style (SPEC stories 62–65 and 67).
	//
	// **A plain textarea with a live preview**, which ADR-0009 and the ticket both make the deliverable
	// rather than a starting point: the preview is what makes Markdown acceptable to a scholar who has
	// never written it, and without it the format is a tax on exactly the audience this tool is for. A
	// block editor was considered and deferred — the stored value has to stay a portable Markdown
	// string, which constrains an editor emitting a document tree more than it first appears.
	//
	// Every control is a native element, which is ADR-0016's mandate and not a preference: `<select>`
	// for the three-way choices, `<input type="color">` for the colours, `<input type="range">` for the
	// opacities. There is nothing custom here and therefore nothing to make keyboard-accessible
	// afterwards.

	import {
		LINE_STYLES,
		MARKER_SIZES,
		isDescriptionRendererSupported,
		lineStyleOf,
		renderDescription,
		resolveStyle,
		type Annotation,
		type LineStyle,
		type SimpleStyle
	} from '@ballastella/core';
	import { onMount } from 'svelte';

	let {
		annotation,
		layerDefault,
		ontext,
		oncommit,
		onstyle,
		onlinestyle,
		ondelete
	}: {
		annotation: Annotation;
		/** The Layer's default style, so a control can show what an unset property currently resolves to. */
		layerDefault: SimpleStyle;
		/** Typing. Coalesced into one write per file (ADR-0017 rule 2). */
		ontext: (text: { title?: string; description?: string }) => void;
		/** The edit is over — the field blurred, or Enter was pressed (ADR-0017 rule 1). */
		oncommit: () => void;
		/** A style property set, by its exact simplestyle name, or `undefined` to clear it. */
		onstyle: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		onlinestyle: (line: LineStyle) => void;
		ondelete: () => void;
	} = $props();

	const properties = $derived(annotation.properties);

	/** What this Annotation currently draws with, so a control that is unset still shows a value. */
	const resolved = $derived(resolveStyle(properties, layerDefault));

	const geometryKind = $derived(annotation.geometry?.type ?? null);
	const isPoint = $derived(geometryKind === 'Point');
	const hasArea = $derived(geometryKind === 'Polygon');
	const hasLine = $derived(geometryKind === 'LineString' || geometryKind === 'Polygon');

	/**
	 * Whether this component has mounted in a browser.
	 *
	 * Both apps prerender (ADR-0006) and DOMPurify needs a DOM, so the renderer refuses in Node rather
	 * than degrading to returning its input unsanitised — the safe direction, since a fallback would
	 * write an XSS payload into a static file.
	 *
	 * It also sidesteps a Svelte hydration rule worth knowing: **`{@html}` is not re-rendered during
	 * hydration.** Svelte adopts the nodes the server produced and never compares them against the
	 * client's value, so a `{@html}` that was `''` on the server and complete HTML on the client renders
	 * nothing at all, permanently, with no warning. This component is only ever reached on a
	 * client-rendered branch of the Layers pane, so it is not currently exposed to that — but the same
	 * expression moved anywhere prerendered would be, silently, and **a blank preview passes every "is
	 * the payload inert?" assertion.** `e2e/editor-annotations.e2e.ts` therefore asserts the description's
	 * text *is* rendered as well as that its markup is not.
	 */
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	/** The description as sanitised HTML, or `''` where there is none or it cannot be rendered. */
	const preview = $derived(
		mounted && properties.description && isDescriptionRendererSupported()
			? renderDescription(properties.description)
			: ''
	);

	const lineStyle = $derived<LineStyle>(lineStyleOf(resolved['stroke-dasharray']));

	/** How a line style reads in the control. The stored value is the tuple (ADR-0009). */
	const LINE_LABELS: Record<LineStyle, string> = {
		solid: 'Solid — certain',
		dashed: 'Dashed — conjectural',
		dotted: 'Dotted — very uncertain'
	};

	/** Whether this Annotation sets a property itself, rather than inheriting the Layer's. */
	const own = (key: string): boolean => key in properties;
</script>

<div class="flex flex-col gap-3" data-testid="annotation-editor" data-annotation-id={annotation.id}>
	<label class="floating-label">
		<span>Title</span>
		<input
			class="input w-full input-sm"
			value={properties.title ?? ''}
			data-testid="annotation-title"
			oninput={(event) => ontext({ title: event.currentTarget.value })}
			onchange={() => oncommit()}
			onblur={() => oncommit()}
		/>
	</label>

	<div>
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

		<!--
			The live preview, sanitised. `{@html}` is correct here and only here, and only because
			`renderDescription` returns DOMPurify's own output — the string has been through the
			sanitiser, and there is no path into this expression that has not.

			Marked `aria-live="off"`: it updates on every keystroke, and a region that announced each one
			would talk over the user as they typed. It is `aria-label`led instead, so it is reachable and
			readable on demand.
		-->
		<div class="mt-1">
			<p class="text-xs opacity-70" id="annotation-preview-label">Preview</p>
			<div
				class="prose-sm prose max-w-none rounded border border-base-300 bg-base-200 p-2"
				aria-live="off"
				aria-labelledby="annotation-preview-label"
				data-testid="annotation-preview"
			>
				{#if preview === ''}
					<p class="opacity-60">Nothing to preview yet.</p>
				{:else}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html preview}
				{/if}
			</div>
		</div>
	</div>

	<fieldset class="rounded border border-base-300 p-3">
		<legend class="px-1 text-sm font-semibold">Style</legend>

		<div class="flex flex-col gap-3">
			{#if isPoint}
				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Pin colour</span>
					<input
						type="color"
						class="h-8 w-16"
						value={resolved['marker-color']}
						data-testid="annotation-marker-color"
						data-own={own('marker-color')}
						oninput={(event) =>
							onstyle({ 'marker-color': event.currentTarget.value }, { debounce: true })}
						onchange={() => oncommit()}
					/>
				</label>

				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Pin size</span>
					<select
						class="select select-sm"
						value={resolved['marker-size'] ?? ''}
						data-testid="annotation-marker-size"
						onchange={(event) => onstyle({ 'marker-size': event.currentTarget.value || undefined })}
					>
						<option value="">Layer's default</option>
						{#each MARKER_SIZES as size (size)}
							<option value={size}>{size}</option>
						{/each}
					</select>
				</label>
			{/if}

			{#if hasLine}
				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Line colour</span>
					<input
						type="color"
						class="h-8 w-16"
						value={resolved.stroke}
						data-testid="annotation-stroke"
						data-own={own('stroke')}
						oninput={(event) => onstyle({ stroke: event.currentTarget.value }, { debounce: true })}
						onchange={() => oncommit()}
					/>
				</label>

				<label class="flex items-center justify-between gap-2 text-sm">
					<!--
						Three options, mapping to absent, [8, 4], and [1, 3]. The three-way choice is
						presentation; the stored value is the tuple, and solid is the property being absent
						(ADR-0009) — which is why the handler goes through `onlinestyle` rather than writing a
						value of its own.
					-->
					<span>Line style</span>
					<select
						class="select select-sm"
						value={lineStyle}
						data-testid="annotation-line-style"
						onchange={(event) => onlinestyle(event.currentTarget.value as LineStyle)}
					>
						{#each LINE_STYLES as style (style)}
							<option value={style}>{LINE_LABELS[style]}</option>
						{/each}
					</select>
				</label>

				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Line width</span>
					<span class="flex items-center gap-2">
						<input
							type="range"
							class="range max-w-32 range-sm"
							min="0"
							max="10"
							step="0.5"
							value={resolved['stroke-width']}
							data-testid="annotation-stroke-width"
							oninput={(event) =>
								onstyle({ 'stroke-width': Number(event.currentTarget.value) }, { debounce: true })}
							onchange={() => oncommit()}
						/>
						<span class="tabular-nums" data-testid="annotation-stroke-width-value">
							{resolved['stroke-width']}
						</span>
					</span>
				</label>

				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Line opacity</span>
					<span class="flex items-center gap-2">
						<input
							type="range"
							class="range max-w-32 range-sm"
							min="0"
							max="1"
							step="0.05"
							value={resolved['stroke-opacity']}
							data-testid="annotation-stroke-opacity"
							oninput={(event) =>
								onstyle(
									{ 'stroke-opacity': Number(event.currentTarget.value) },
									{ debounce: true }
								)}
							onchange={() => oncommit()}
						/>
						<span class="tabular-nums" data-testid="annotation-stroke-opacity-value">
							{resolved['stroke-opacity']}
						</span>
					</span>
				</label>
			{/if}

			{#if hasArea}
				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Fill colour</span>
					<input
						type="color"
						class="h-8 w-16"
						value={resolved.fill}
						data-testid="annotation-fill"
						data-own={own('fill')}
						oninput={(event) => onstyle({ fill: event.currentTarget.value }, { debounce: true })}
						onchange={() => oncommit()}
					/>
				</label>

				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Fill opacity</span>
					<span class="flex items-center gap-2">
						<input
							type="range"
							class="range max-w-32 range-sm"
							min="0"
							max="1"
							step="0.05"
							value={resolved['fill-opacity']}
							data-testid="annotation-fill-opacity"
							oninput={(event) =>
								onstyle({ 'fill-opacity': Number(event.currentTarget.value) }, { debounce: true })}
							onchange={() => oncommit()}
						/>
						<span class="tabular-nums" data-testid="annotation-fill-opacity-value">
							{resolved['fill-opacity']}
						</span>
					</span>
				</label>
			{/if}

			{#if geometryKind === null || geometryKind === 'foreign'}
				<p class="text-sm text-warning" data-testid="annotation-not-drawable">
					This Annotation's shape is one this version cannot draw, so it has no style controls. Its
					title and description are still yours to edit, and the shape is written back untouched.
				</p>
			{/if}
		</div>
	</fieldset>

	<div>
		<button
			type="button"
			class="btn btn-outline btn-error btn-sm"
			data-testid="annotation-delete"
			onclick={() => ondelete()}
		>
			Delete this Annotation
		</button>
	</div>
</div>
