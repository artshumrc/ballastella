# v1 scope fences

Recorded because unnamed adjacent scope is where a plan quietly triples, and because the plan will be executed by people who were not part of the conversation that set it.

## Out of v1

1. **Collaboration and multi-user editing.** Allmaps Editor achieves it with `sharedb` and a websocket server — an entire backend. Local-first is the premise; this contradicts it.
2. **Accounts and authentication.** There is no server to authenticate against.
3. **In-app git.** Publishing produces files; committing them is the user's business, documented in prose.
4. **Server-side tiling.** Settled by ADR-0003 — a CLI described in the docs, not code we ship.
5. **IIIF time-based media.** triiiceratops does not support it either.
6. **Aligning a IIIF `Choice`.** triiiceratops can *view* Choice; alignment operates on one selected image.
7. **Cross-project search.**

## Authoring is desktop-only; viewing is fully responsive

Stated rather than assumed, because leaving it implicit costs weeks in either direction — an implementer either builds responsive authoring nobody can use, or ships a published site that fails on a phone.

File System Access exists on no mobile browser, and a two-pane control-point interface on a phone is bad at any level of effort. But published sites must read well on a phone, because that is where readers are.

## Undo is single-level, not a history stack

`terra-draw` provides no undo, so this is ours. A scoped undo is not optional: dragging a control point is a destructive, easy-to-mis-aim gesture, and a scholar who nudges the wrong point and cannot get back will not trust the tool.

But full multi-step session history is a different order of work — every mutation becomes a command object, which shapes the entire state layer. v1 ships **a single-level undo of the last destructive action**: point moved, point deleted, annotation deleted, layer deleted. Cheap, covers the actual fear, and does not dictate the architecture.

## Annotating the unwarped image is the most likely v2 feature

Scholars want to label a cartouche, a compass rose, a decorative panel — things belonging to the *sheet* rather than to a place on earth. triiiceratops already renders annotations read-only, and an Alignment already establishes image-pixel space, so it is not far off.

It is deferred because it is a **second annotation model**: targets are image coordinates rather than geography, so they are W3C Web Annotations rather than GeoJSON, with their own storage, editing surface, and layer kind.

**Recorded here so that annotation storage is not designed in a way that blocks it.** Specifically: the layer kind discriminator from ADR-0002 must tolerate a third kind, and nothing may assume that all annotations are geographic.
