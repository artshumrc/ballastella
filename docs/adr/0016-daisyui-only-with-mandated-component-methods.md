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

The Popover API mandate also buys correctness, not only compliance: dropdowns here open over a **MapLibre WebGL canvas** — a positioned canvas with its own stacking context, into which MapLibre injects its own controls. That is exactly where z-index and `overflow` bugs live, and top-layer rendering eliminates the class outright.

## Consequences

- **Tooltips are not an information channel.** daisyUI tooltips render via CSS `::before`, so screen readers do not announce them and they cannot be dismissed. Anything a user *needs* is visible text or `aria-describedby`. This matters specifically for ADR-0013's transformation guidance, which is exactly the copy that would otherwise be buried in a tooltip.
- **The reorderable layer list is custom** — no library provides drag-to-reorder — and **requires a keyboard path**: move-up/move-down controls, not drag-only. Layer order is load-bearing (ADR-0002), so a drag-only implementation would make core functionality keyboard-inaccessible.
- **One theme signal drives both the UI and the map.** Protomaps flavors include `LIGHT` and `DARK`; a dark UI must select the dark map flavor from the same source of truth, or the app presents a dark interface framing a bright white map.
- **Tracy's theme ships in the published viewer**, not only the authoring app. A published site is the artefact a scholar shows colleagues and cites; it is what most viewers will ever see.
- `@allmaps/tailwind` is deliberately **not** adopted. It exists and is MIT, but its purpose is to make things look like Allmaps, and the point of Tracy's work is that this tool has its own identity.
