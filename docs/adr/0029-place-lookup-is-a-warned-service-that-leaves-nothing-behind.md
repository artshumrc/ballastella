# Place lookup is a warned, replaceable service, and it leaves nothing behind

A scholar can type a place name and either move the map to it or drop a Pin at it. The service that answers is deployment configuration, it **warns** rather than fails `pnpm check:deployment`, and **nothing it returns is recorded in a Project's files**.

## What a Place is, and what it is not

`CONTEXT.md` defines **Place**: one candidate answer to a place name a scholar typed. The definition carries two facts that this ADR exists to protect.

**A Place is transient.** Choosing one either moves the camera or drops an ordinary Annotation. A Pin placed from a lookup is **byte-identical** to a Pin drawn by hand — same geometry, same properties, nothing marking its origin. Search is an authoring convenience, not a provenance system.

**A Place is a starting point, usually wrong.** The workflow this feature exists for is: look up an address, see that it landed in the middle of a river, and drag it to where the wharf actually was — reading against the Base Map or a Map Image layered over it. **The correction is the scholarship.** The lookup is step one and the cheap one.

That gesture needs no new code. `overlay-points.ts` already draws `annotation-vertex` as a focusable, draggable, arrow-key-movable DOM `<button>` on a MapLibre `Marker`, which sits above the WebGL canvas where a warped Map Image is drawn. Dragging a Pin against a map image is the same vertex editing an Annotation's own vertices get.

## Nothing is written about where a coordinate came from

Two candidates were considered and both declined.

**A provenance stamp** — some `"ballastella:source": {…}` in `unknownProperties`, which the model tolerates and `simpleStyleViolations` explicitly declines to flag — **starts lying within seconds.** It records a claim by the *service*, and the scholar's very next act invalidates it. Keeping it honest means detecting the edit that falsifies it, which is per-feature edit history; ADR-0014 fenced history off at single-level undo. So it is not one property. It is a small subsystem, or a stale claim in a scholar's published file.

**An "unsettled" flag** survived that objection and was still declined. It would record a claim by the *scholar* — "I have not checked this yet" — cleared by exactly the action that falsifies it, so it cannot go stale. It answers a real question: forty Pins across three sessions, which ones did I verify? And it had a natural home, since the Sync dialog already warns about anything that would make the work disappoint a reader.

It was declined as disproportionate (human decision, 2026-08-11). It needs a second affordance — dragging cannot be the only settle gesture, or a Pin the service got *right* stays flagged for ever — and a feature this small should not arrive with a status model and a confirm button. **Recorded because it is the most likely thing to be re-proposed, and because the argument for it is genuinely good.** If it returns, it returns as its own decision.

What a placed Pin *does* carry is a `title` pre-filled with **the scholar's own query string**. Not the service's `display_name`: for Boston Common, Nominatim answers `Boston Common, Boston, Suffolk County, Massachusetts, 02108, United States`, and a pre-fill people delete every time is worse than an empty field, because now they must notice it. The query is theirs, always short, and never surprising.

## Attribution travels with the service, not with the Base Map

The Base Map catalog already displays `© OpenStreetMap`, and it is tempting to let that discharge the obligation for lookup results too.

**It does not, and the gap is one `docs/hosting.md` actively steers people into.** ADR-0020 exists so a fork can repoint the catalog at their own archive. A fork serving a national mapping agency's tiles while still using the default lookup service would display that agency's attribution and none for OSM — and the candidate list would be unattributed OSM data.

So attribution sits beside the service URL in the same configuration module. Repointing the service repoints its attribution. It displays **on the candidate list**: visible exactly while that data is on screen, costing no permanent chrome on a two-pane authoring screen, and gone when the list is — which is correct, because once the Pin is placed nothing on screen is OSM's. It is the scholar's coordinate now.

## The service warns; it does not fail the deployment check

This is the decision most likely to read as an inconsistency, so it is the one most worth recording.

`pnpm check:deployment` **fails** while the Base Map catalog names a borrowed archive. For the lookup service it **warns and stays green**. Two reasons, the second decisive.

**The relationship is different.** Source Cooperative say in as many words that they do not recommend cross-origin hotlinking — we do it anyway. Nominatim publishes a policy that *permits* our use and names its conditions. A scholar doing twenty human-paced searches an hour, with attribution shown and no autocomplete, is a compliant consumer rather than a freeloader. Meeting a published condition is not the posture of ignoring a published discouragement.

**The remedies are not comparable.** Repointing the Base Map means putting a file in a bucket you control — bounded, and an instructor can do it in an afternoon. Repointing the lookup service means running and maintaining a Nominatim installation: a planet import is days of compute, hundreds of gigabytes, and permanent diff replication. Almost nobody forking this repository can do that. **A check that fails with a remedy nobody can take is a check people learn to route around** — and it would take the Base Map check standing next to it down with it, which *is* satisfiable and is the one that must stay sharp.

What fails instead is **our own compliance**, which is the part that is actually ours to get wrong. See below.

## Submit-only is contingent on the default service, not a law

Nominatim's policy states: "Auto-complete search — this is not yet supported by Nominatim and you must not implement such a service on the client side using the API." Also: an absolute maximum of one request per second, a valid HTTP `Referer` or `User-Agent` identifying the application, displayed attribution, and no systematic or bulk querying.

The prohibition is both a load argument and a technical one. Autocomplete multiplies one search into five or ten requests against hardware donated to serve the whole world; and Nominatim's index parses complete, structured queries into address components against Postgres full-text, so a partial token is an expensive, badly-ranked query. **It is forbidden partly because it does not work.**

**That constraint is Nominatim's, not geocoding's**, and the distinction is recorded deliberately. Photon exists precisely for search-as-you-type over the same OSM data with an index built for it; Pelias and commercial services likewise. A fork pointing at one would be doing something entirely legitimate.

So: **this application is submit-only because its default service cannot be otherwise, and because one UI is better than two** — not because as-you-type is wrong. A `supportsAutocomplete` capability flag would be speculative generality for a fork that does not exist. A future maintainer who swaps in Photon should be able to see that this fence was contingent and re-open it deliberately, rather than inheriting a rule whose reason no longer applies.

Two mechanisms hold the line, and neither is a lint fence on who may import the module — that would police reuse rather than the rule, since two surfaces import it legitimately and an autocomplete implementation would import it just as legally:

- **A rate limiter inside the lookup module**, refusing a second request within a second. Autocomplete then visibly does not work, on the implementer's own machine, the first time they try it. It needs no new user-facing behaviour, because a client-side refusal produces the same sentence a server's `429` produces — one code path, one message.
- **A test asserting that typing without submitting issues zero requests.**

The limiter is per-tab, so two tabs can exceed one request per second and nothing here catches it. Accepted: a scholar with two tabs open is not the abuse case the policy is written against.

## Four outcomes, told apart

**A failure is distinguished from a refusal**, so that a user is not told their connection is at fault when it is their storage, or the reverse. A lookup says one of four things, composed by a pure function in the domain package beside `baseMapUnavailableNotice`:

1. **Places found** — the candidate list.
2. **Nothing matched** — a real answer, not an error. The service replied; it has no such place.
3. **The service did not answer** — unreachable, `5xx`, blocked, or a response we could not read. A fork pointed at something that is not a geocoder folds in here: it is the instance operator's problem, and a sentence about response schemas reaches the wrong person.
4. **Too many searches, too fast** — a `429`, or our own limiter. The one failure with a remedy the scholar can act on.

**2 versus 3 is the distinction that matters**, and the one an implementer collapses first because both end in an empty list. "No results for Boston Common" when the request never left the building is exactly the inversion that rule forbids.

Per `online.svelte.ts`, `navigator.onLine` "is fine for suppressing a claim and would not be fine for making one." So outcome 3 drops its it-is-probably-them clause when offline rather than asserting "you are offline" — and the search field is **never disabled** when offline, because disabling a control *is* making the claim.

## Candidates are shown, and framing uses the bounding box

Silently taking the top-ranked answer for "Springfield" is precisely the silent failure this feature is most able to manufacture: a Pin in the wrong state is indistinguishable from a Pin in the right one. `CONTEXT.md` says a Place is a candidate; taking one silently would contradict the glossary.

Nominatim returns a `boundingbox` per result. `opening-view.ts` already owns `GeoBounds`, `openingViewFit`, and `applyOpeningFit` over a `FittableMap`, with identity-guarded re-framing so a fit does not fight the user's own panning. So navigation **frames** a Place rather than centring on its point at a zoom level we invented — a house address frames tight, a country frames wide, and no zoom heuristic exists anywhere in the feature. The padding and maximum-zoom constants are that module's (`OPENING_VIEW_PADDING`, `OPENING_VIEW_MAX_ZOOM`) and are not to be re-derived; if those names read wrongly for a Place, the remedy is a sibling that calls the same helper, never a second copy of the numbers.

**The bounding box reaches the camera and never the file.** Placing a Place writes a `Point`. Two related shapes are refused:

- **A bounding box must never become a polygon Annotation.** It is the axis-aligned rectangle around a place, not its shape: a rectangle labelled *Paris* takes in Boulogne and Saint-Denis. A Pin says "here, approximately"; a polygon says "this area" — so the rectangle is confidently wrong, in a document where Annotations *are* the scholarly claim.
- **Real administrative boundaries** (`polygon_geojson=1` returns the true OSM polygon) are **not** a deferred feature of this work and are not recorded as wanted. Noted only so the next reader knows it was considered: a single coordinate pair is arguably de minimis, while a boundary polygon of thousands of vertices is substantially the database — an ODbL Derivative Database rather than a Produced Work, and therefore on the share-alike branch. That would put a licence on a scholar's own `annotations.geojson`, which collides with the premise that the work is theirs. ADR-0021 exists because silently relicensing *this project* was a live risk; silently relicensing a scholar's scholarship is the same mistake with a worse victim.

**Placing always frames.** A scholar looking at Amsterdam who picks a Boston address would otherwise get a Pin off-screen — invisible, unverifiable, and uncorrectable, when correcting it is the whole point. So both surfaces move the camera, and only one of them also drops a Pin. One code path, and no "which one framed?" ambiguity.

## Where it appears, and where it must not

**`BaseMapPane.svelte` carries navigation**, which gives both editor screens the feature from one component: `ProjectScreen` and `AlignmentWorkspace` both render it. A scholar hunting the modern half of a Control Point wants "zoom to Boston" at least as much as an annotator does, and declining it would mean actively excluding a screen that renders the same pane.

**Placing a Pin lives on the Annotation Layer surface**, beside the drawing tools, and that placement is structural rather than aesthetic. `AnnotationTools.svelte` has exactly one render path — `LayerList` invokes its `annotationContents` snippet only for a Layer that is both `kind === 'annotation'` and open — and the component's own comment records that it deleted its "no Layer to draw into" announcement because that state became *unreachable*. A control living there inherits "there is always a Layer to draw into" for free. Anywhere else it would have to answer "which Layer does this Pin go into?", a question with no good answer when a Project has zero annotation layers, or three.

**The published viewer never gets place lookup.** Stated as a fence because an implementer will notice `ReaderMapPane` is "the same picture with authoring attached" and reasonably wonder why it is missing. A Reader is following an argument, not authoring. And it would bake a service URL chosen by an instance operator into **every published site** — sites that outlive the instance, still issuing requests to a service nobody remembers choosing. The Base Map has that shape and survives it because a broken base map degrades to a blank pane; a broken search box is a control that lies.

## Testing: fixtures in CI, a probe outside it

No test may reach the network. Every test drives a committed fixture — one captured real response for a query with several candidates, so the disambiguation list is exercised by real data rather than two hand-written entries that are always unambiguous.

**A fixture is a snapshot of an assumption**, and this repository has already been bitten by that class: `demo-bucket.protomaps.com` did not change shape, it vanished, and nothing in the suite could have said so. So a hand-run `pnpm check:places` sits beside `check:deployment` — deliberately outside `pnpm lint` and outside CI, for the same reason `check:deployment` is: it asks a question about the world rather than about the code. It issues one query against the configured service and asserts the fields we depend on are still there. It also gives a forker something they would otherwise lack — a way to find out they configured the service wrongly before their students do.

## Consequences

- **A placed Pin is not distinguishable from a drawn one, by design.** Any future feature that needs to know the difference is proposing the tracking this ADR declined, and should say so.
- **Two independently-repointable services now exist**, each carrying its own attribution. A fork that changes one and not the other stays correct.
- **`pnpm check:deployment` acquires a warning that never fails.** It should not be tightened into a failure without revisiting the remedy argument above — the reason is that forks cannot comply, not that the dependency is acceptable.
- **The feature is offline-hostile and does not pretend otherwise.** The editor is a PWA that works offline; this is the one control in it that cannot. It stays enabled and explains itself rather than disabling and implying a diagnosis.

## Out of scope, and declined rather than deferred

Reverse lookup (click a point, get an address) — a second feature with its own outcomes and its own UI, and nothing in the originating workflow asks for it. Recent-search history — local state that immediately raises "does this persist, and where", which is a Workspace question. Bulk address import — declined at the outset; it would make this a data-import feature rather than a viewport one. A new `OverlayPointKind` for a Place — `overlay-points.ts` records that an `annotation-edge` kind was declared and styled and never emitted, and that "a kind nothing produces is an affordance the code promises and the app does not have"; nothing is tracked here, so a placed Pin is an ordinary `annotation-vertex`.
