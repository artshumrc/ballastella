// A one-canvas IIIF Presentation Manifest wrapping one remote image service, so that a Historical
// Map with no Manifest of its own can still be read as a document (SPEC story 48).
//
// **Only needed for a bare image service.** When the user browsed to the map through a Manifest,
// that Manifest's URL is what triiiceratops is given — it fetches and parses the library's own
// document with `manifesto.js`, which is ADR-0018's boundary working as intended: a URI crossed and
// nothing else. Many institutions expose image services without Manifests, though (ADR-0015 names
// that as the reason bare `info.json` is supported at all), and triiiceratops navigates Manifests.
// So this is the smallest legal document that turns one into the other.
//
// It is **not** written to the Project and it is not portable data. It exists for the duration of a
// view, which is why it carries the remote service's own URI throughout and mints no identifier of
// its own — every `id` here either belongs to the library or is derived from a URL the library
// serves. Nothing about it is ours to be canonical about.

import type { ReferencedImage } from '@ballastella/core';

/** The shape triiiceratops' `manifestJson` prop takes: a Presentation 3 Manifest. */
export function unwarpedManifest(image: ReferencedImage): unknown {
	const canvasId = `${image.service}/canvas/1`;
	return {
		'@context': 'http://iiif.io/api/presentation/3/context.json',
		id: `${image.service}/manifest.json`,
		type: 'Manifest',
		// `none` rather than a language tag: the label came out of a library's document and claiming a
		// language for it would be a guess. An empty label is left absent rather than blank, so
		// triiiceratops falls back to its own numbering instead of showing an empty heading.
		...(image.label === '' ? {} : { label: { none: [image.label] } }),
		...(image.rights === '' ? {} : { rights: image.rights }),
		...(image.attribution === ''
			? {}
			: {
					requiredStatement: {
						label: { en: ['Attribution'] },
						value: { none: [image.attribution] }
					}
				}),
		items: [
			{
				id: canvasId,
				type: 'Canvas',
				width: image.width,
				height: image.height,
				items: [
					{
						id: `${canvasId}/annotation-page/1`,
						type: 'AnnotationPage',
						items: [
							{
								id: `${canvasId}/annotation/1`,
								type: 'Annotation',
								motivation: 'painting',
								target: canvasId,
								body: {
									// A level 2 service can serve this; a level 0 one cannot, and triiiceratops draws
									// from the `service` entry below rather than from this `id` whenever it is
									// present. It is here because a Presentation body needs one.
									id: `${image.service}/full/max/0/default.jpg`,
									type: 'Image',
									format: 'image/jpeg',
									width: image.width,
									height: image.height,
									service: [
										{
											id: image.service,
											type: 'ImageService3',
											profile: 'level2'
										}
									]
								}
							}
						]
					}
				]
			}
		]
	};
}
