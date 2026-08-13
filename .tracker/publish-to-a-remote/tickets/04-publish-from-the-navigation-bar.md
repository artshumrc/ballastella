# Publish from the navigation bar

## What to build

The first end-to-end publish a person can perform. The navigation bar reads **"Saved locally"** beside a
**Publish** button; pressing it shows what will be sent, and confirming it writes the viewer into the
Workspace and uploads the Workspace to its Remote. Progress is announced. The three budget warnings and the
truncation refusal are shown in words a scholar can act on.

This is where the epic becomes demoable: bind a Remote, press one button, and a site exists.

## Where to start

- `apps/editor/src/lib/components/SaveIndicator.svelte` — the label map is
  `{ saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes' }`. Only `saved` changes, to
  **"Saved locally"**. Leave `MINIMUM_SAVING_MS` and the `role="status"` region alone; read the comment
  explaining why the region is not a tooltip.
- `apps/editor/src/lib/components/NavigationBar.svelte` around line 444, where `<SaveIndicator>` sits. The
  Publish button goes beside it. Note the comment on the workspace-announcement region: **the save
  indicator already owns `role="status"` on this bar**, so a second one makes `getByRole('status')`
  ambiguous. Use `aria-live="polite"` for anything new here.
- `apps/editor/src/lib/publish/PublishDialog.svelte` — read the whole file, especially:
  - why the plan is computed **on open** rather than once;
  - why `stampCanonicalUrl` runs **before** `publish` (a refused address after a site has been written
    makes "nothing has been changed" false);
  - why progress is announced from **inside** the modal (`showModal()` makes the rest of the document
    inert, and an inert `aria-live` region is not announced at all) and the result from outside it after
    `tick()`;
  - why the confirm button uses `aria-disabled` and not `disabled` (a `disabled` button leaves the tab
    order the moment it is pressed, dropping focus to `<body>`).
  Every one of those four decisions must survive this ticket. They are the expensive ones.
- `apps/editor/src/lib/editor-session.svelte.ts` around `planPublish`, `publish`, `readPublishedSite`,
  `stampCanonicalUrl` — the session is where the new upload call belongs, beside these.
- `e2e/editor-publish.e2e.ts` — the existing end-to-end publish spec. Extend the same file rather than
  starting a new one where the flow is the same flow.
- `e2e/support/iiif-hosts.ts` — the shape for the new Playwright support module. Its header explains why
  `page.route` handlers are consulted before the `context.route` fence, which is what lets a routed host be
  served without weakening the fence.

## Contract

**A new e2e support module wraps ticket 01's fake in Playwright routes.** One module, shared by every spec
in this epic, installing `page.route` handlers for `api.github.com` and `raw.githubusercontent.com` and
backed by **the same fake** ticket 01 exported. Do not write a second in-page GitHub. That is precisely the
duplication `iiif-hosts.ts`'s header was written about.

**The publish flow is one dialog with two phases.** Phase one: what will be written locally (the viewer
bundle) and what will be uploaded — files, bytes, and the three budget lines. Phase two: it runs, with
per-file progress and the remaining hourly request budget. The existing dialog's two decisions stay: the
Base Map display-assets choice, and the canonical URL, settled before anything is uploaded.

**Progress reports three numbers**, because a publish can be slow for three different reasons and the user
cannot tell them apart otherwise: files done, files total, and requests remaining.

**Every refusal names its remedy.** A truncated tree quotes the file count and says what to remove. A byte
warning quotes the total and the limit. A request warning names the reset time. A missing credential says
so and offers the paste. A Remote that is not bound offers the Workspace menu.

**The Publish control's states**, which are this ticket's to settle — SPEC left them open:

| State | Behaviour |
| --- | --- |
| Unbound | enabled, and pressing it leads to binding |
| Bound, no credential | enabled, and pressing it asks for the credential |
| Bound, credential, nothing changed | enabled, and it says nothing needed changing |
| In flight | `aria-disabled`, label reflects progress |
| Refused | the refusal stays on screen after the dialog closes |
| Rate-limited | names the reset time |

Choose "enabled and it leads somewhere" over "disabled" everywhere. A disabled Publish button with no
explanation is the failure this whole epic exists to remove.

**The manifest returned by ticket 02 is persisted locally**, keyed by Workspace and backing exactly as the
write-ahead journal is. It is not written into the store. Ticket 05 reads it.

### User Stories

1, 2, 3, 9, 10, 11, 12, 13, 14, 59, 60, 61, 62.

## Out of scope

- **No conflict detection.** Ticket 05. This ticket persists the manifest; it does not compare it.
- **No front-page flag.** Ticket 06. Everything publishes and everything is listed.
- **No Clone, no Review, no Front Page link.** Tickets 07–09.
- **No OAuth.** Ticket 10. The credential comes from ticket 03's paste.
- **Do not restructure `PublishDialog`'s accessibility model.** The inert-modal reasoning, the
  `aria-disabled` choice, and the two `aria-live` regions are load-bearing and were each arrived at from a
  real defect. Extend; do not rewrite.
- **Do not change the local publish path's behaviour.** A user with no Remote must still be able to publish
  locally exactly as today, even though nothing advertises it. SPEC "Out of scope" item 8.
- **No background or debounced publish.** Autosave stops at local storage. SPEC "Out of scope" item 6.

## Acceptance criteria

- [ ] The bar reads "Saved locally" when saved, and the other two save states are unchanged.
- [ ] `getByRole('status')` on the editor is still unambiguous — the save indicator remains the only one.
- [ ] With a bound Remote and a credential, pressing Publish uploads the Workspace and the fake's tree
      afterwards holds the Workspace's files and `.nojekyll`.
- [ ] Publishing twice with no change reports that nothing needed changing and posts zero blobs.
- [ ] Progress announces files done, files total, and requests remaining, from inside the modal while it is
      open.
- [ ] The outcome is announced from outside the dialog after it closes, and survives on screen.
- [ ] A truncated tree shows a refusal quoting the file count, and nothing is uploaded.
- [ ] A byte total over the hosting limit warns and names both numbers.
- [ ] A publish needing more requests than remain warns before starting and names the reset time.
- [ ] Rate-limit exhaustion partway through leaves the site unchanged and says so.
- [ ] Each of the six control states above is reachable and asserted.
- [ ] Keyboard focus is never lost to `<body>` while a publish runs.
- [ ] The canonical URL is still settled before any upload; a refused address uploads nothing.

```
pnpm test:e2e editor-publish
pnpm --filter @ballastella/editor test
pnpm check
pnpm lint
```

Success: `editor-publish` passes including the new cases. Run by spec name, not file:line.

## Carried over from ticket 03: a stale "Signed in to GitHub"

**Recorded here rather than fixed there, and it must not survive this ticket silently.**

`readRemoteRights` runs at exactly two moments — binding, and signing in — so what the bar means by
"Signed in to GitHub" is *a credential is held*, never *a credential still works*. A token that has
since expired, been revoked, or had its repository access withdrawn reads "Signed in to GitHub"
indefinitely. In ticket 03 that costs nothing: nothing publishes, so the worst outcome is a label.

This ticket is where it starts costing something, because the Publish control's states are settled
here and two of them are read off that same fact. "Bound, credential" is the state that leads
straight to an upload, and a credential that GitHub will no longer accept turns it into a refusal
discovered after the dialog has opened — or, on a large Workspace, after tiles have gone.

Decide it deliberately, and write down which was chosen:

- re-check the rights when the publish dialog opens, so the state is read from GitHub rather than
  from what was true an hour ago; or
- leave the label alone and make the *refusal* carry it — a 401 during a publish says the sign-in has
  expired, offers the paste, and clears the credential rather than reporting "GitHub refused this
  publish".

What is not acceptable is the third outcome, which is what happens if nobody looks: the bar says
signed in, Publish is offered, and the scholar learns otherwise from a message about a repository
that is perfectly fine.

## Blocked by

- Ticket 03
