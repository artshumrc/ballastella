# v1 scope fences

Recorded because unnamed adjacent scope is where a plan quietly triples, and because the plan will be executed by people who were not part of the conversation that set it.

> **These are v1's fences and they stay as the record of v1.** Three statements below have since been overtaken and must not be read as current:
>
> - **"`terra-draw` provides no undo, so this is ours"** — `terra-draw` is not used anywhere and never was. See [ADR-0005](./0005-maplibre-and-terra-draw.md)'s Resolution. Undo is still ours; only the stated reason was wrong.
> - **"Undo is single-level, not a history stack"** — reversed by [ADR-0039](./0039-an-edit-history-per-screen-holds-file-images-not-commands.md). The fence's reasoning is why it was reversed rather than why it stood: the command objects it declined are exactly what ADR-0039 also declines, and an Edit History of file images buys a dozen actions five deep without them.
> - **"Annotating the unwarped image is the most likely v2 feature"** — still plausible, but note that [ADR-0023](./0023-map-images-and-alignments-live-in-the-workspace.md) moves map images and alignments to the workspace, so a second annotation model would target a *workspace-level* image rather than a project-level one. The tolerance this section asks for — a third layer kind, and nothing assuming all annotations are geographic — is unaffected and still required, `"foreign"` still reserved.
>
> "Authoring is desktop-only; viewing is fully responsive" holds and is load-bearing for everything built on top of v1.
>
> **Fences 2 and 3 are reversed by [ADR-0031](./0031-the-broker-exchanges-a-code-never-data.md) and [ADR-0032](./0032-publish-means-the-remote.md).** Both were correct on their premises and both premises moved:
>
> - **"Accounts and authentication — there is no server to authenticate against."** There is now one, and it is smaller than the fence assumed: a stateless code-for-token exchange that never sees repository data, needed only because `github.com/login/oauth/access_token` sends no CORS headers while `api.github.com` sends `*`. Nothing authenticates *to Ballastella*; there are still no accounts and no user records. A fork with no infrastructure remains fully functional through a pasted token.
> - **"In-app git. Publishing produces files; committing them is the user's business, documented in prose."** The prose was written — `docs/hosting.md` Part 2 — and step 2 of it asks a humanities student on a Chromebook to `git init`, `git remote add`, and `git push`, which is a step they cannot take at all. Replacing that one paragraph with a button is the whole of the change. It is not in-app git: one branch, one commit per Publish, no merges, no branches, no pull requests, no history.
>
> **Fence 1 is untouched and is load-bearing.** Collaboration and multi-user editing remain out. A shared Remote is not collaboration — [ADR-0033](./0033-a-publish-mirrors-an-owned-namespace.md) refuses a Publish that would overwrite another machine's work rather than merging it, precisely because merging is what fence 1 refuses.

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

**`"foreign"` is a reserved `kind` literal, so the third kind must not be called that.** The tolerance above is implemented by parsing a `kind` this build has never heard of into a `ForeignLayer` — a layer that can be named, hidden, and reordered, and that serialises back with the kind the file carried and every field it arrived with. `kind: "foreign"` is the in-memory discriminator that makes narrowing work; the declared kind lives beside it. An author reading this section for the third kind would otherwise have no reason to know the name is taken.
