/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO COLOURS THE LAYER KINDS ARE DRAWN IN — ONE TABLE, ONE EDIT
 *
 * Every colour a Layer card wears comes from this table, and every entry in it is a daisyUI theme
 * token rather than a value: change the pair here (or redefine the tokens in the theme generator)
 * and the tint, the kind line, the visibility toggle, the opacity slider *and the buttons inside the
 * card* all follow. Nothing that draws inside a Layer card names a colour any other way.
 *
 * **A module rather than a `const` in `LayerList.svelte`, because the card is not all in one file.**
 * What a card *contains* is supplied as snippets by `ProjectScreen.svelte` — the Align link for a
 * Map Image, `AnnotationTools` and the Inspector's faces for an Annotation Layer — so those files
 * draw controls that have to be the same colour as the header above them. They used to say
 * `btn-secondary` and cite this table in a comment, which is a mapping kept in two places and only
 * one of them checked by anything.
 *
 * **Why `accent` and `info`.** The pair is a decision of the project's rather than of this file's:
 * `accent` goes to Map Images and `info` to Annotations — a teal and a blue in the stock themes,
 * though the theme is free to make them anything, and neither reads as a demotion of the other, which
 * is the one property a pair for two peer kinds must have.
 *
 * **A kind's colour is the colour of everything in its card**, which is the part worth being careful
 * about, because it is where a colour can start making a second claim. `primary` stays the action
 * colour *outside* the cards — "Add a Map Image" below the stack, the dialogs — so a button in a
 * card is the card's colour and a button on the screen around it is the app's.
 *
 * Two overlaps come with `info`, both deliberately accepted:
 *
 *   • **The tiles badge is a status colour two lines below a map's kind line** — `badge-success` for
 *     a local copy, `badge-warning` for one that needs the network. Those are in the *map* card,
 *     whose colour is `accent`, so no Layer's kind colour is ever a status colour in the card it sits
 *     in. `info` itself is used nowhere as a status in this column.
 *   • **`layout.css` draws Resource Mask handles in `accent`** and `AlignmentWorkspace` marks a
 *     selected Control Point with `secondary`. Both are on the alignment route, on map-pane overlays,
 *     and neither is ever on screen beside a Layer card.
 *
 * Written as whole class strings rather than composed from a token name, because Tailwind finds the
 * classes it generates by reading the source: `bg-${token}/10` built at runtime produces a class that
 * exists in the DOM and in no stylesheet. For the same reason a consumer must use these strings
 * whole — `${style.btn}` in a class attribute is fine, `btn-${kind}` is not.
 *
 * The `ink` entries are the kind's hue **mixed half-and-half with the theme's own text colour**, and
 * that is not a decoration: `accent` is a 77%-lightness teal in the stock light theme, 1.9:1 against a
 * white card — a colour that cannot carry a 0.65rem label (4.5:1) and cannot carry an icon either
 * (3:1) — and `info` is a 74%-lightness blue at 2.2:1, no better. Mixed, they carry 5.6:1 and 6.0:1 in
 * light, 9.2:1 and 8.8:1 in dark. The mix is defined in `layout.css` from the same theme variables, so
 * it still follows the theme; that file has the measured sweep, including why the ratio is a half and
 * not the 60% it started at (ADR-0016, ADR-0020).
 */
export const KIND_STYLE = {
	map: {
		tint: 'bg-accent/10',
		ink: 'text-[var(--layer-kind-ink-map)]',
		toggle: 'toggle-accent',
		range: 'range-accent',
		btn: 'btn-accent',
		/** For a `<label>`-wrapped radio that becomes the pressed one: `has-[:checked]:btn-accent`. */
		btnWhenChecked: 'has-[:checked]:btn-accent'
	},
	annotation: {
		tint: 'bg-info/10',
		ink: 'text-[var(--layer-kind-ink-annotation)]',
		toggle: 'toggle-info',
		range: 'range-info',
		btn: 'btn-info',
		btnWhenChecked: 'has-[:checked]:btn-info'
	},
	/**
	 * A kind this build has never heard of wears the drained pair (ADR-0014). It is not drawn on the
	 * map, so a colour saying "this is one of the two kinds of thing on your map" would be a lie — and
	 * it has no contents, so it has no buttons to colour.
	 */
	foreign: {
		tint: 'bg-base-content/5',
		ink: 'text-base-content/70',
		toggle: '',
		range: '',
		btn: '',
		btnWhenChecked: ''
	}
} as const;
