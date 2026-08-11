# Find a place

## Problem Statement

A scholar can only reach a location on the Base Map by dragging to it, and can only place an Annotation by clicking where they already believe it goes. Neither app has ever been able to answer "where is this address?"

Three consequences, in the order a user meets them.

**Getting anywhere is manual.** Opening a Project on Amsterdam and wanting to work on Boston means dragging across an ocean at the wrong zoom until the labels look right. The same is true while aligning, where the task is explicitly *find the modern location of this feature* — a scholar places Control Points against a Base Map they navigated to by hand.

**Placing an Annotation at a known address requires already knowing where it falls on screen.** A historian working from a list of addresses — a city directory, a tax roll, a footnote — has no route from the address to the map except their own memory of the city.

**And coordinates are nowhere in the interface.** A scholar cannot read back where a Pin they placed actually sits.

The thread is that the modern world's own index of itself — the thing every consumer map application has had for twenty years — is missing, from a tool whose entire premise is relating a Historical Map *to that world*.

### The workflow this is designed against

Described by a stakeholder, and it determines the shape of everything below.

> They look up an address as a starting point. They notice the result is in the middle of a river. So they adjust it by hand against the Base Map, or against a Historical Map layered over it, until it sits where the place really is.

**The lookup is step one and the cheap one. Correcting it is the scholarship.** A modern address resolved against modern data lands where the modern address is; a scholar working on 1625 wants the wharf, the parish boundary, the house that is now a car park. The answering service is not expected to be right, and a design treating its answer as authoritative would be designing against the actual use.

## Solution

A scholar types a place name and presses Enter. They see the candidate Places, and pick one.

On the Base Map pane, that frames the map on it — a city fills the pane, a house address frames tight. Because that pane is shared, the feature appears while annotating **and** while aligning.

On an Annotation Layer, choosing a candidate frames the map on it **and** drops a Pin there, titled with what the scholar typed, selected, and immediately draggable through the vertex editing that already exists. They drag it out of the river and onto the quay, reading against a Historical Map if they have one.

Nothing about the lookup survives in their files. The Pin is an ordinary Annotation — the same bytes a hand-drawn one would have produced.

The answering service is deployment configuration carrying its own attribution, so an instance can point at its own. It is borrowed, and every deploy says so without failing.

## User Stories

1. As a scholar, I want to type a city name and have the map go there, so that I do not drag across an ocean by hand.
2. As a scholar, I want the map framed on the place rather than centred at a guessed zoom, so that a city fills the pane and a house address does not.
3. As a scholar, I want to see the candidate Places and pick one, so that a search for "Springfield" does not silently choose a state I did not mean.
4. As a scholar, I want each candidate labelled well enough to tell them apart, so that choosing between twelve Springfields is possible rather than a guess.
5. As a scholar aligning a Historical Map, I want the same lookup on the alignment screen, so that finding the modern half of a Control Point is not the slow part of placing one.
6. As a scholar, I want to place a Pin at an address I looked up, so that I do not have to know where it falls on screen.
7. As a scholar, I want that Pin's title pre-filled with what I typed, so that I am not deleting a service's punctuation before I can write my own label.
8. As a scholar, I want the Pin selected as soon as it is placed, so that retitling it does not begin with hunting for it.
9. As a scholar, I want a Pin placed from a lookup to be draggable immediately, so that correcting a result that landed in a river is one gesture rather than a delete and a redraw.
10. As a scholar, I want to correct it against a Historical Map layered over the Base Map, so that I can put it where the place *was* rather than where the modern address is.
11. As a scholar, I want to move that Pin by keyboard, so that a precise correction does not require a steady hand on a trackpad.
12. As a scholar, I want the map to move to a Pin I just placed, so that a result on another continent is not dropped somewhere I can neither see nor fix.
13. As a scholar, I want a placed Pin to be an ordinary Annotation, so that nothing in my published work records that I used a search box.
14. As a scholar, I want a placed Pin to take the styling my last Annotation had, so that lookup and drawing do not produce visibly different objects.
15. As a scholar, I want to be told the difference between "no such place" and "the service did not answer", so that I do not hunt for a spelling mistake when the network is down.
16. As a scholar searching too quickly, I want to be told to wait rather than told the service is broken, so that I know the remedy is a moment's pause.
17. As a scholar working offline, I do not want to be told a remote server is at fault, so that the app does not diagnose something it cannot know.
18. As a scholar working offline, I want the search field to stay enabled, so that the app is not making a claim about my connection by greying out a control.
19. As a scholar, I want every failure to reach the screen in visible text, so that nothing about it is only in a console I am not watching.
20. As a scholar, I want the candidate list operable by keyboard and announced, so that choosing a Place is not the one mouse-only step in the application.
21. As a scholar using a screen reader, I want the outcome of a lookup announced, so that I learn what happened without seeing the list appear.
22. As a scholar, I want to see who the place data belongs to, so that I can attribute it in work I publish.
23. As a scholar, I do not want the search surface holding layout open when I am not searching, so that a two-pane screen keeps its room for the work.
24. As a scholar, I want a lookup never to alter an Annotation I already have, so that searching is always safe to do mid-edit.
25. As a Reader of a Published Site, I want the site to carry no dependency on a lookup service, so that the scholar's work does not quietly rot when a service someone else chose goes away.
26. As someone hosting an instance, I want to point the lookup at my own service by editing one module, so that I am not searching the codebase for a URL.
27. As someone hosting an instance, I want the service's attribution to move when I repoint it, so that changing the service cannot leave the wrong credit on screen.
28. As someone hosting an instance, I want a way to check that the service I configured actually answers, so that I find out before my students do.
29. As someone hosting an instance, I want the deploy to tell me the default service is borrowed, so that I know it is a dependency I did not provision.
30. As someone hosting an instance, I do not want that warning to fail my deploy, so that I am not blocked by a remedy I cannot realistically carry out.
31. As a maintainer, I want no test to reach the network, so that this feature cannot turn the suite red for reasons that are not ours.
32. As a maintainer, I want search-as-you-type to fail loudly if someone builds it, so that a policy violation is caught by a test rather than by the service operator.
33. As a maintainer, I want a way to find out that the service changed shape, so that a committed fixture cannot go on passing after reality has moved.
34. As a maintainer, I want the two empty-handed outcomes to be impossible to confuse, so that the most likely wrong implementation cannot pass the suite.

## Implementation Decisions

Every decision below is recorded, with its argument and its rejected alternatives, in [ADR-0029](../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md). This section states them; the ADR says why.

### The domain model

**A Place is transient.** `CONTEXT.md` defines it as one candidate answer to a place name a scholar typed. Choosing one either moves the camera or drops an ordinary Annotation. **Nothing in a Project's files records that a Place was ever involved.**

**A placed Pin is byte-identical to a hand-drawn Pin with the same title.** No provenance property, no status flag, no distinct overlay point kind. Two candidates were considered and declined — a provenance stamp, which goes stale on the scholar's very next gesture, and a scholar-owned "not checked yet" flag, which survives that objection and was declined as disproportionate by human decision.

**A Place placed into a Layer is a `Point`.** A bounding box reaches the camera and never the file. Neither the rectangle nor a real administrative boundary becomes geometry.

### The lookup

A new module in the domain package owns the whole of "a query goes out, Places or a sentence comes back". It exposes:

- **A lookup** taking a submitted query and a connection signal, returning one of four outcomes as a **value, never an exception**.
- **The four outcomes**: Places found; nothing matched; the service did not answer; too many searches, too fast. A malformed response folds into *did not answer* — it is the instance operator's problem, and a sentence about response schemas reaches the wrong person.
- **A notice function** composing each outcome's sentence, following the existing Base-Map-unavailable precedent: rows in the order the questions arrive, with a test asserting no row overclaims.
- **A rate limiter**, refusing a second request inside one second and returning the *too fast* outcome — the same value a server's `429` produces, so there is one code path and one sentence.

A Place carries at minimum a display name, a point, and a bounding box.

**The connection signal is a parameter.** The domain package does not read `navigator`. When the signal says the connection is down, the *did not answer* sentence drops its it-is-probably-the-service clause and gains no "you are offline" claim — the standing rule in this codebase is that `navigator.onLine` may suppress a claim and may never make one.

### Deployment configuration

**One editable module holds the service URL and its attribution together**, modelled on the Base Map catalog, whose stated property it reproduces: *change this file, and nothing else*. A lint containment scan fails if any module outside it names the service host.

> The scan is on **the URL**, not on **who may import the module**. An import fence was considered and declined: two surfaces import it legitimately, and an autocomplete implementation would import it just as legally.

**Attribution travels with the service, not with the Base Map.** A fork repointing the Base Map at its own tiles while keeping the default lookup would otherwise display the wrong credit and leave the lookup's data uncredited.

**The deployment check warns and stays green** for the lookup service, while it continues to *fail* for a borrowed Base Map archive. The asymmetry is deliberate: repointing an archive is putting a file in a bucket, while repointing the lookup means running a planet-scale geocoder, and a check that fails with a remedy nobody can take corrodes the one beside it that people can satisfy.

**A hand-run check** issues one query against the configured service and asserts the depended-on fields still exist. It sits outside lint and outside CI, for the same reason the deployment check does — it asks a question about the world rather than about the code.

**The hosting documentation gains the service**, beside its Base Map section and in its known-gaps list, saying plainly that this one warns where the Base Map fails, and why.

### The surfaces

**One search component, two consumers.** The field and the candidate list are built once. The Annotation Layer's use adds only what happens when a candidate is chosen.

**Navigation lives on the Base Map pane**, which is shared by the Project screen and the alignment screen — so both get the feature from one component, and excluding either would mean actively suppressing it on a screen that renders the same pane.

**Placing lives on the Annotation Layer surface**, beside the drawing tools. That is structural rather than aesthetic: the tools render only for a Layer that is both an Annotation Layer and open, so a control there inherits "there is always a Layer to draw into" for free. Anywhere else it would have to answer "which Layer does this Pin go into?", which has no good answer when a Project has zero annotation layers, or three.

**The published viewer never gets place lookup.** It would bake an instance operator's service choice into every Published Site — sites that outlive the instance and would go on issuing requests to a service nobody remembers choosing.

### Interaction

**Submit-only. Typing issues no request.** Not debounced, not throttled-with-a-short-delay. This is what the default service's policy requires — it prohibits client-side autocomplete outright, partly because its index cannot answer partial tokens well. **Recorded as contingent, not as a law**: other services exist precisely for search-as-you-type, and a future maintainer swapping one in must be able to see the fence was a consequence of this service rather than a judgement about the interaction.

**Candidates are shown; the top hit is never taken silently.** The glossary defines a Place as a candidate; choosing one on the scholar's behalf would contradict it, and a Pin in the wrong state is indistinguishable from a Pin in the right one.

**Framing goes through the existing opening-view fit**, reusing its padding and maximum-zoom constants. If those names read wrongly for a Place, the remedy is a sibling calling the same helper — never a second copy of the numbers. No zoom heuristic exists anywhere in the feature.

**Navigation drops no marker.** The framing is the answer; a marker at the found point would be indistinguishable at a glance from an Annotation the scholar made.

**Placing always frames**, so a Pin is never dropped off-screen where it can be neither seen nor corrected.

**Placing produces exactly one store write.** The obvious construction — create the Annotation, then set its title — is two commits and violates the write-count rule this repository asserts by counting. The title is present in the commit that creates the Annotation.

**Placing goes through the existing Annotation creation path**, so style inheritance, selection, and the write path are the ones already asserted rather than a second implementation of each.

**The search field is never disabled when offline.** Disabling a control is making a claim about the connection, and the standing rule forbids making one from that signal.

**Every outcome reaches the screen as visible text**, never a tooltip, and is announced.

## Testing Decisions

**A good test here asserts what a scholar or an instance operator can observe** — text on screen, bytes in a file, requests on the wire, an exit code. Not which function was called, and not a value the page reports about itself.

Three seams, all of them existing. No new seam is introduced.

### The browser suite — the primary seam

Everything a scholar does. Three of this epic's load-bearing claims are only honestly assertable here, because each is a claim about the application rather than about a function's return value:

- **Typing without submitting issues zero requests**, asserted by *counting requests during typing*. A test that merely checks the candidate list is empty passes against a debounced implementation, which is the violation.
- **Placing produces exactly one store write**, asserted by counting.
- **A Pin from a lookup is byte-identical to a drawn one** with the same title, asserted by producing both and comparing the written files. This is the epic's central claim and it is directly checkable.

Also here: candidates appearing and being chosen; framing on both screens, asserted on the alignment screen rather than assumed from the shared component; all four outcomes as visible text; keyboard reach of every candidate without a pointer; attribution present while candidates are shown and absent when they are not; and a Pin draggable **with a Historical Map Layer visible above the Base Map**, which is the stakeholder's actual gesture.

Prior art: the existing Base Map specs for driving that pane against a routed fixture, and the annotation specs for driving a drawing gesture and asserting the bytes it wrote.

### The domain package's node project — narrow

Only the outcome-to-sentence table, with `fetch` stubbed. It is here for one reason the browser seam cannot serve: the existing Base-Map-unavailable precedent includes a test asserting that **no row overclaims**, and a rendered string cannot be asked whether it promises more than the code can keep. It also guarantees the wording is shared rather than duplicated — a wording change here must turn a browser test red.

Also here: the rate limiter refusing a second call within a second **without issuing a request**, asserted by counting calls to the stub.

Prior art: the existing Base-Map-unavailable notice tests, which drive every row plus the no-overclaim assertion.

### The script suite — pre-existing

The lint containment scan, the deployment warning, and the hand-run service check. Check scripts have no other home.

The deployment check needs **both halves asserted**: it warns and exits zero for the lookup service, *and* still fails for a borrowed Base Map archive. A composite that short-circuits would pass a test written for either half alone.

### Standing constraints

**No test may reach the network.** The default-deny fence already refuses the service host, and no existing spec begins reaching it by accident, because lookups are submit-only and nothing fires on mount. The hand-run service check is the only thing permitted out, and it is in no gate.

**The fixture is one captured real response for a query with several candidates**, so disambiguation is exercised against real data rather than two hand-written entries that are always unambiguous.

**A fixture is a snapshot of an assumption.** This repository has been bitten by that class before — a borrowed archive did not change shape, it vanished, and nothing in the suite could have said so. The hand-run check exists for that, and is why it is not in CI.

**Two assertions pass vacuously if written naively** and must be mutated specifically: the zero-requests-while-typing count, and the distinction between the two empty-handed outcomes. Both end in no candidates, and a test checking only for an empty list passes whichever one was produced.

**The mutation check is mandatory** per the standing constraint carried from previous epics: break the behaviour, confirm the test goes red, restore, and record what was broken.

## Out of Scope

Each of these is **declined rather than deferred**, and the reasons are in ADR-0029. Re-proposing one is a new decision, not the closing of a gap.

- **The published viewer.** It would bind every Published Site to a service the site's author never chose.
- **Reverse lookup** — click a point, get an address. A second feature with its own outcomes and its own surface, and nothing in the originating workflow asks for it.
- **Recent-search history.** Local state that immediately raises "does this persist, and where", which is a Workspace question.
- **Bulk address import.** It would make this a data-import feature rather than a viewport one.
- **Tracking which Pins came from a lookup**, in any form.
- **Bounding boxes as geometry**, in either the rectangle form or the real-administrative-boundary form.
- **Autocomplete**, and any capability flag anticipating a service that could support it.
- **Caching lookup results.** The service's policy recommends a proxy and caching for bulk use; there is no server here and no bulk use. A cache built to satisfy a sentence written about a different scale of use is a cache with no reason.
- **Coordinate read-out in the Annotation editor.** A real gap, named in the problem statement, genuinely adjacent, and on the path of no story here.
- **Widening undo.** Undo covers the last *destructive* action; placing is not destructive, and deleting a Pin is already undoable.

## Further Notes

**The rate limiter is per-tab.** Two tabs open can exceed one request per second and nothing here catches it. Accepted: a scholar with two tabs is not the abuse case the service's policy is written against.

**This is the one control in the editor that cannot work offline.** The editor is otherwise an installable app that works without a connection. The feature stays enabled and explains itself rather than disabling and implying a diagnosis it cannot make.

**The correction gesture needs no new code.** Annotation vertices are already focusable, draggable, arrow-key-movable DOM buttons rendered above the map canvas, so a Pin stays operable with a warped Historical Map drawn beneath it. The stakeholder's central gesture is machinery that already shipped.

**Two services are now independently repointable**, each carrying its own attribution, so a fork changing one and not the other stays correct.
