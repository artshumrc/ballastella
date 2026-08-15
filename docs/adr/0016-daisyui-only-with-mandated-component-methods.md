# daisyUI as the only UI dependency, with mandated component methods

Tracy builds the theme with the daisyUI theme generator, and daisyUI is the **only** UI dependency — no headless primitive library alongside it. A headless library (`bits-ui`, as Allmaps Editor uses, or Melt UI) was considered and rejected as unnecessary.

daisyUI is more accessibility-conscious than a first look suggests. For modals it recommends `<dialog>` with `showModal()`/`close()` explicitly on accessibility grounds — native Escape handling, native focus management — and marks the checkbox and anchor-link methods as legacy with no Escape support. For dropdowns it documents the Popover API. Native platform primitives cover essentially every interactive surface this app needs, so a second dependency would buy little.

**The real risk is not daisyUI; it is *unspecified* daisyUI.** For dropdowns it documents three methods (`<details>`/`<summary>`, Popover API, CSS focus) and **states no preference**, and two legacy modal methods still appear in its docs. An implementer copying whichever snippet they land on produces a different accessibility outcome each time. So methods are mandated, not just the library.

A Harvard-hosted teaching tool will be held to WCAG 2.1 AA, and interactive components are where that is won or lost.

## The binding contract

| Surface | Mandated method | Why |
|---|---|---|
| Modal / dialog | `<dialog>` + `showModal()` / `close()` | daisyUI's own recommendation — native focus trap, Escape, focus restoration |
| Dropdown / menu | **Popover API** (`popover` + `popovertarget`) | top layer: no z-index or overflow conflict with the map canvas; Escape and light-dismiss built in |
| Tabs | radio inputs, with `role="tablist"` added | native arrow-key navigation |
| Select (base map, transformation type) | native `<select>` | few options; nothing custom needed |
| Opacity control | native `<input type="range">` | |
| Toasts / status | `aria-live="polite"` region | daisyUI's toast is presentation only |

**Banned:** checkbox-hack modal, anchor/hash modal, `<details>` dropdown, CSS-focus dropdown.

### Amendment: `role="alert"` for a notice that is inserted rather than updated

`aria-live="polite"` announces a **change of text inside a region that is already there**. A notice rendered inside an `{#if}` arrives with its text already in it, and assistive technology has nothing to compare it against — so the mandated method, applied to that shape, produces a status nobody hears. This was found in ticket 20 and it is not a daisyUI question at all.

So a notice that is *conditionally inserted* uses `role="alert"`, which announces on insertion. The deviations **recorded so far** are `base-map-unavailable`, in both `apps/editor/src/lib/project/ProjectScreen.svelte` and `apps/viewer/src/routes/+page.svelte`, and `referenced-offline`; `editor-base-map.e2e.ts` and `viewer-reader.e2e.ts` assert the attribute on the first two, so those cannot quietly revert. This is not a census: both apps render further conditionally-inserted `role="alert"` blocks — the site-record, Project, Layer-stack, and unwarped-view problems among them — which are the same shape, correct for the same reason, and neither listed here nor attribute-asserted. A pass that inventories them belongs in its own change.

The mandate above is unchanged for its own case, and it remains the better shape where it applies: a region present from the first frame whose text moves is announced without stealing focus from what the user is doing. Reach for `role="alert"` only when the element genuinely comes and goes — and prefer converting the element to an always-present region with an empty string.

**The two shapes are one component's decision on the map pane, not each call site's** (ADR-0034). `packages/ui/src/MapNotice.svelte` takes `shape` — what the notice does over time — and chooses the mechanism from it, so the notices both apps render cannot be an alert in one and a live region in the other. That is also how the two Base Map notices this amendment used to name as outstanding were fixed: `base-map-notice` and `base-map-not-published` are always-present regions holding an empty string, and `packages/ui/src/map-notice.dom.test.ts` holds both halves of the rule against the component.

### Amendment: an icon set is not a second UI dependency

`@lucide/svelte` is adopted for glyphs, and that is not a relaxation of "daisyUI is the only UI dependency". What this ADR rejected was a headless **component** library — `bits-ui`, Melt UI — because such a library owns focus, keyboard handling and ARIA, which is where WCAG 2.1 AA is won or lost, and because a second owner of those makes each surface's accessibility outcome depend on which library an implementer reached for. An icon is none of that: each Lucide icon is a Svelte component that renders one `<svg>` with `stroke="currentColor"` and no behaviour at all, imported one glyph at a time (`@lucide/svelte/icons/map`) so that only what is used is bundled. ISC, with portions of Feather under MIT; both plainly permissive, and no compiled artefact.

**The binding rule is that a glyph is never alone with meaning**, which is this ADR's tooltip consequence applied to icons rather than an exception to it. A kind icon sits beside the words it illustrates; an icon-only button carries its label in visible or `sr-only` text and its state in ARIA. An icon that would need a tooltip to be understood is the wrong icon, and the answer is words, not a `title` attribute. Where SPEC story 111 asks for an explanation, the explanation is still text.

Adopted for the Layer card redesign, which needed a Layer's *kind* to be recognisable before it is read; `apps/editor` only, so no published site downloads it (ADR-0019).

The Popover API mandate also buys correctness, not only compliance: dropdowns here open over a **MapLibre WebGL canvas** — a positioned canvas with its own stacking context, into which MapLibre injects its own controls. That is exactly where z-index and `overflow` bugs live, and top-layer rendering eliminates the class outright.

## Consequences

- **Tooltips are not an information channel.** daisyUI tooltips render via CSS `::before`, so screen readers do not announce them and they cannot be dismissed. Anything a user *needs* is visible text or `aria-describedby`. This matters specifically for ADR-0013's transformation guidance, which is exactly the copy that would otherwise be buried in a tooltip.
- **The reorderable layer list is custom** — no library provides drag-to-reorder — and **requires a keyboard path**: move-up/move-down controls, not drag-only. Layer order is load-bearing (ADR-0002), so a drag-only implementation would make core functionality keyboard-inaccessible.
- **One theme signal drives both the UI and the map.** Protomaps flavors include `LIGHT` and `DARK`; a dark UI must select the dark map flavor from the same source of truth, or the app presents a dark interface framing a bright white map.
- **Tracy's theme ships in the published viewer**, not only the authoring app. A published site is the artefact a scholar shows colleagues and cites; it is what most viewers will ever see.
- `@allmaps/tailwind` is deliberately **not** adopted. It exists and is MIT, but its purpose is to make things look like Allmaps, and the point of Tracy's work is that this tool has its own identity.
