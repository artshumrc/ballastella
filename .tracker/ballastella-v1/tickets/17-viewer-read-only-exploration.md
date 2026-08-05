# 17 — Viewer: read-only exploration, base map switcher, unwarped view, responsive

## What to build

The read-only experience a Reader gets from a Published Site. They arrive at a hub page, open a Project, and explore it: toggling Layers, adjusting the opacity of an aligned Historical Map, clicking an Annotation to read its title and description, switching Base Maps, and opening a Historical Map on its own to read it as a document.

It reads well on a phone. Nothing can be edited.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 70, 71, 72, 83, 84, 85, and 86, plus the Reader half of 82 and the viewer's case of 77. With ticket 04: 98 — the catalog supplies the high-contrast entry, this ticket makes a Reader able to choose it.

## Where to start

[ADR-0006](../../../docs/adr/0006-the-project-directory-is-the-published-site.md) (the HTTP `ProjectStore` adapter), [ADR-0020](../../../docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md) (reader switching and persistence), [ADR-0014](../../../docs/adr/0014-v1-scope-fences.md) (authoring is desktop, **viewing is fully responsive**), [ADR-0009](../../../docs/adr/0009-annotations-use-simplestyle-spec.md) (sanitisation), [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) (theme ships with the viewer).

The bundle and its placement come from ticket 16.

## Contract

**The viewer is the same reading code with a third `ProjectStore` adapter: HTTP `fetch` over relative paths.** OPFS, File System Access, and now HTTP — ADR-0001's abstraction paying out a third time. Do not write a parallel data layer.

`size` may be left unsupported on this adapter. Nothing a Reader does needs it — the hosting-limit warnings belong to the editor (tickets 15 and 16) — and implementing it would mean a `HEAD` request per file for no benefit.

**Nothing is editable.** No drawing tools, no Control Point manipulation, no writes of any kind. The viewer has no store `write`.

Reader capabilities:

- **Layer visibility and opacity**, honouring `order` and stacking across kinds (ticket 09). These are *view* controls: they must not attempt to persist to `project.json`, which is read-only over HTTP anyway — a naive reuse of the editor's controls would try, fail, and surface a confusing error.
- **Annotation popups** rendering `title` and Markdown `description`, using **ticket 10's sanitised renderer**. This is the highest-stakes reuse in the epic: the viewer runs on the user's own domain, and the Project may have arrived from someone else.
- **Base Map switching**, starting at the author's default from `project.json`, persisted in **`localStorage` keyed per site** so a preference on one scholar's site does not leak into another's. **Never** written to Project data.
- Entries with `needsNetwork: true` are **marked or disabled**, or a Reader on a plane selects satellite imagery and gets a blank map with no explanation.
- **Unwarped viewing** via triiiceratops (ticket 14) reading through the HTTP adapter.

**Responsive.** Authoring is desktop-only and that is settled, but published sites must read well on a phone, because that is where Readers are. This is the one surface in the epic with a genuine mobile requirement — a scholar shows this to colleagues and cites it, so it is what most people will ever see.

**Tracy's theme ships here**, not only in the editor (ADR-0016). One theme signal still drives both the UI and the Base Map flavor, so a dark UI never frames a white map.

Graceful degradation, since a Published Site is a snapshot that may outlive its authoring app:

| Condition | Behaviour |
|---|---|
| Referenced image whose host is unreachable | Say so, naming the host; keep the rest of the site working |
| Base map id absent from the bundled catalog | Fall back to the catalog default with a quiet notice |
| `formatVersion` newer than the bundle understands | Say so plainly rather than misrendering (ADR-0010) |

A missing or broken single Layer must never take down the whole Project view.

## Out of scope

- **Any editing.** No drawing, no Control Points, no writes.
- **Distortion overlay and the warped graticule.** ADR-0013 keeps the distortion toggle out of `project.json` precisely so a Published Site cannot load colourised; a deliberate "show distortion" exhibit is a plausible future feature and is not this.
- **Reader accounts, comments, or annotation submission.**
- **Search within a Project.**
- **The service worker** — ticket 18.
- **Editing the author's default base map.** Readers deviate for themselves; the author's default governs first contact.
- **Persisting reader preferences beyond base map choice.**

## Acceptance criteria

- [ ] The hub page lists Projects and `?p=<dir>` opens one, served over plain HTTP with no server-side logic
- [ ] The viewer reads exclusively through the HTTP `ProjectStore` adapter, and exposes no `write`
- [ ] Layer visibility and opacity work and honour `order`, including an annotation Layer drawing above a map Layer
- [ ] Changing a view control makes **no** write attempt and produces no error
- [ ] Annotation popups render `title` and Markdown `description`
- [ ] A `description` containing an XSS payload renders inert in the **viewer** — asserted here as well as in ticket 10, because this is the origin that matters
- [ ] The Base Map starts at the author's default
- [ ] Switching Base Maps works, persists via `localStorage`, and is restored on return
- [ ] The `localStorage` key is per site: two Published Sites on different paths do not share a preference
- [ ] Base Map choice is **never** written to Project data
- [ ] Entries needing network are marked or disabled
- [ ] A Historical Map opens unwarped via triiiceratops, reading over HTTP
- [ ] The site is usable at a 375 px viewport width: no horizontal page scroll, controls reachable, popups readable
- [ ] Tracy's theme is applied, and toggling theme changes the Base Map flavor in the same action
- [ ] An unreachable referenced host, an unknown base map id, and a newer `formatVersion` each degrade with a clear message and do not blank the site
- [ ] Every Reader control is reachable and operable by keyboard, and layer state changes are announced
- [ ] A low-contrast-sensitive Reader can select a high-contrast or muted Base Map

```bash
pnpm -r build
pnpm test:e2e                    # served at root AND at a subpath; desktop AND 375px viewport
pnpm --filter @ballastella/core test    # HTTP adapter, per-site localStorage keying, degradation paths
pnpm lint && pnpm check

# the viewer must ship no write path
grep -rn "createWritable\|getFileHandle(.*create: *true" apps/viewer/src && echo "FAIL" || echo "OK: read-only"
```

Success: all exit 0 and the `grep` prints `OK: read-only`. The e2e suite must run the responsive assertions at a real 375 px viewport — a desktop-only run would pass while the phone experience, which is where most Readers arrive, stayed broken.

## Blocked by

- Ticket 16
