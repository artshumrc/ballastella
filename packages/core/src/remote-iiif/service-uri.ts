// The one spelling of a remote image service's address.
//
// Seven places used to normalise this themselves, in two variants — some stripping a trailing
// `/info.json` and a trailing slash, some only the slash — and the two can disagree. That matters
// more than tidiness, because this string is not only a URL: `generateId(uri)` hashes it into the
// Historical Map's identity and into the key `annotations.allmaps.org` is queried on (ADR-0015). A
// service reached as `…/sheet/`, as `…/sheet/info.json`, and as `…/sheet` must be *one* Historical
// Map with *one* community lookup, or the same map added twice is two Layers that cannot be told
// apart and an existing Alignment is silently not found.
//
// So it is one function, used by every site that has an address in hand: the pasted URL, the `id`
// a document declares, the URI crossing the ADR-0018 parser boundary, the `remote.json` record, and
// the `resource.id` an Allmaps annotation names.
//
// **A leaf module with no imports, on purpose.** `remote-resource.ts` would be the obvious home
// beside `remoteIiifUrl`, but it names `@allmaps/iiif-parser` at the top level and this function is
// wanted from the render path, which `apps/viewer` compiles (ADR-0019). A three-line string
// normaliser must not be the reason a published site carries a Manifest parser.

/**
 * The canonical form of an image service URI: no trailing `/info.json`, no trailing slash.
 *
 * `/info.json` is trimmed because it is what a user copies out of a browser address bar and what a
 * document sometimes declares as its own `id`, and refusing it would read as pedantry. The IIIF
 * Image API's own rule is that a service's base is where its `info.json` lives, so this is that rule
 * applied rather than a convenience.
 *
 * Does **not** validate: whether an address may be fetched at all is `remoteIiifUrl`, which refuses
 * a relative URL, a non-HTTP scheme, and credentials. This only settles the spelling.
 */
export const canonicalServiceUri = (uri: string): string =>
	uri
		.trim()
		.replace(/\/info\.json$/, '')
		.replace(/\/$/, '');
