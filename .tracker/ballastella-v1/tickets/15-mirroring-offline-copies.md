# 15 — Mirroring: "make an offline copy"

## What to build

A per-image action that copies a referenced remote Historical Map into the Project as local tiles, so the work survives the host reorganising or disappearing, works offline, and can be published as a genuinely self-contained site.

The user sees the source's rights statement at the moment they choose to copy, and is warned when copying will be expensive for the host.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 27 and 28. With ticket 16: 15 — the warning lands here, where a workspace actually grows, and again at publish. Sets `imageMode: 'mirrored'`, which is what stories 29, 88, and 90 read. Mirroring is also what makes story 8 (fully offline) true for a Project sourced remotely.

## Where to start

[ADR-0007](../../../docs/adr/0007-remote-iiif-is-referenced-by-default-mirrored-on-request.md) (the whole slice), [ADR-0003](../../../docs/adr/0003-every-image-is-tiled-client-side.md) (the tiler this reuses), [ADR-0002](../../../docs/adr/0002-display-state-separate-from-portable-documents.md) (`imageMode` on the Layer).

The tiler is ticket 05, remote ingest is ticket 14, the injection shim is ticket 06.

## Contract

**Mirroring reuses ticket 05's contract exactly: `ImageSource → level-0 pyramid in the ProjectStore`.** The output must be indistinguishable from a locally ingested image, so nothing downstream needs to know how a pyramid arrived. This is why the ticket is cheap.

**Cost depends on the source's compliance level, and the two paths are genuinely different:**

| Source | Path |
|---|---|
| **level 2** | Request `/full/max/0/default.jpg` — **one** request — then feed the existing tiler. The local-image path reused exactly. |
| **level 0** | Only pre-cut tiles exist, so mirroring means pulling its **entire pyramid**: potentially thousands of requests against someone else's server. |

**Warn explicitly on the level-0 case**, naming that it means many requests to the host. This is a politeness obligation, not a performance note.

Note the interaction with ticket 05's decode ceiling: a level-2 `full/max` response may exceed it, in which case the streaming tiler applies as normal. Also respect `maxWidth`, `maxHeight`, and `maxArea` from the parsed profile — `full/max` may be capped by the server, and requesting beyond the cap yields an error rather than a bigger image.

**Surface the manifest's `rights` and `requiredStatement` at the moment the user chooses to copy** (ADR-0007). Copying someone else's images is per-collection acceptable, not universally so, and the decision must not be made implicitly by a button labelled only "Download."

**State the size the copy will add, against the workspace's current size, before it starts.** Mirroring is the only action in the app that grows a workspace by hundreds of megabytes in one gesture, so it is where the ~1 GB static-hosting cliff (ADR-0008) is actually approached — ticket 16's publish-time warning arrives after the fact. Use ticket 02's `ProjectStore#size`; the copy's size is estimable from the parsed profile's dimensions. If the copy would take the workspace past the cliff, say so plainly and let the user proceed anyway — this is information, not a gate.

**Update `imageMode` from `'referenced'` to `'mirrored'`** on the Layer (ticket 09's union). This is not bookkeeping — it changes what publishing means (ticket 16), and a referenced image makes a Published Site network-dependent.

The mirrored pyramid gets the placeholder `id` — `https://unset.invalid/<image-id>` — exactly as a local image does (ADR-0004), so the injection shim from ticket 06 resolves it with no special case. **The `image-id` does not change**: it remains `generateId(uri)` from ticket 14, so the link to the canonical source and the Allmaps community lookup survive mirroring.

Record the source URI in the Project so a mirrored image can still be cited and traced back. Mirroring must not orphan the copy.

Mirroring is a long job with progress and must be **cancellable**, leaving no half-written pyramid behind — a partial pyramid renders with holes, which looks like corruption.

Reversing is out of scope, but the Layer must not be left inconsistent if mirroring fails: on failure it stays `'referenced'` and keeps working.

## Out of scope

- **Mirroring by default.** Referencing is the default and this is opt-in per image (ADR-0007).
- **Un-mirroring** — dropping local tiles to go back to referencing. Plausible later.
- **Bulk mirroring** of every image in a Project or Collection. One image at a time — partly to keep the host-load decision explicit.
- **Publishing behaviour** — ticket 16 reads `imageMode`; this ticket only sets it.
- **Rights enforcement.** Show the statement; the scholar decides. Do not block based on parsed rights.
- **A `sharp` CLI for oversized sources.** Prose in the docs (ADR-0003).

## Acceptance criteria

- [ ] "Make an offline copy" is available per image on a referenced Layer
- [ ] Mirroring a **level 2** source issues a single `full/max` request and then tiles locally
- [ ] Mirroring a **level 0** source fetches its existing tiles and warns beforehand that this means many requests to the host
- [ ] `rights` and `requiredStatement` from the manifest are shown before the copy begins
- [ ] The estimated size of the copy and the workspace's current size are both shown before the copy begins, and a copy that would cross ~1 GB warns explicitly while still allowing the user to proceed
- [ ] The workspace size is obtained via `ProjectStore#size` and **not** by reading tile bytes — asserted with a spy on `read`
- [ ] The resulting pyramid is structurally identical to a locally ingested one: same paths, same tile geometry, same square tiles, `id` set to the `unset.invalid` placeholder
- [ ] The `image-id` is unchanged by mirroring, and remains `generateId(uri)`
- [ ] The source URI is recorded and still visible after mirroring
- [ ] The Layer's `imageMode` becomes `'mirrored'`
- [ ] The mirrored image renders through the injection shim with **no** network requests to the original host
- [ ] A source whose `full/max` exceeds the decode ceiling routes to the streaming tiler
- [ ] A capped `maxWidth`/`maxArea` profile is respected rather than producing a failed oversized request
- [ ] Cancelling mid-mirror leaves no partial pyramid, and the Layer remains `'referenced'` and functional
- [ ] A failed mirror leaves the Layer `'referenced'` and still rendering
- [ ] Progress is reported and announced to assistive technology

```bash
pnpm --filter @ballastella/core test    # level-2 vs level-0 path selection, profile caps, id stability
pnpm test:e2e                    # rights shown, level-0 warning, cancel cleanliness, offline render
pnpm -r build && pnpm lint && pnpm check

# after mirroring: zero requests to the original host (assert via request interception)
```

Success: all exit 0, and the post-mirror test asserts by request interception that **no** request reaches the original host — that is the entire point of mirroring and the only proof that the copy is actually being used.

## Blocked by

- Ticket 05
- Ticket 14
