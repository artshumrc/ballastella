# Autosave: debounced write-through with a visible save state

There is no Save button. Changes are written through to the ProjectStore automatically, under five specific rules — because "debounced autosave," left under-specified, is how data-loss bugs ship.

1. **Continuous gestures commit on gesture *end*, not on a timer.** Dragging a control point or a shape vertex writes once, on pointer-up. Cleaner than debouncing alone, and a dropped frame never costs a write. Without this rule, a drag is a write storm against the storage layer — worst in OPFS, which is the constrained backend.
2. **Debounce per file, not globally.** Otherwise editing annotations delays the alignment write, and one busy file starves the others.
3. **Flush on `visibilitychange` → hidden and on `pagehide`.** Not `beforeunload`, which is unreliable and ignored on mobile. This is the real "user closed the laptop" path.
4. **Write atomically: temp file, then rename.** Non-negotiable for `project.json`, which holds the layer list — a torn write there loses not one annotation but the map of everything. It is also the most frequently written file, since every visibility toggle and reorder touches it.
5. **Show a save state: saved / saving / unsaved.** With no Save button the user has no other signal, and scholars working on material they care about will not trust a tool that offers none. The user-facing promise should be an indicator that *shows* state rather than copy claiming everything is saved instantly.

## The two backends want different write architectures

OPFS's reliable fast write path, `FileSystemSyncAccessHandle`, exists **only inside a Worker**. File System Access's `createWritable()` is async and page-context. So the two ProjectStore backends from ADR-0001 have genuinely different preferred write architectures, and the abstraction has to absorb that difference rather than pretend it away.

## Consequences

- **Single-level undo (ADR-0014) must work across a save.** If undo is implemented as "revert to the last saved state" it is useless the moment autosave fires — which, with a sub-second debounce, is essentially always. Undo holds the prior value in memory, independent of write state.
- Losing power mid-drag costs at most the current gesture.
