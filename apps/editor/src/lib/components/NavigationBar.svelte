<script lang="ts">
	// The editor's navigation bar: the things that are true on every screen (ticket 04).
	//
	// **The container is `AppBar`, in `@ballastella/ui`, and the items below are this app's alone**
	// (ADR-0034). Everything here reaches into the editor — the Workspace switcher into
	// `workspace-storage.svelte.ts`, Workspace settings into the GitHub broker, publishing into the
	// planner — and moving the bar itself into the shared package would put all of that in the
	// viewer's reachable graph. So the shell is shared and the filling is not.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT BELONGS HERE
	//
	// Which Workspace you are in, which screen you are on and the way off it, what the interface looks
	// like, whether your work is kept, and how to take the last thing back. Every one of them is a
	// question a user has *while* doing something else, which is what makes a persistent bar the right
	// place for them rather than a panel that comes and goes.
	//
	// **Project-specific controls are still excluded**: the Base Map switcher and Project settings
	// belong to the Project screen. The Project name appears only as location in the breadcrumb, not as
	// a control owned by this component.
	//
	// The screen's hierarchy and way back arrive through the shell's page-chrome slot — one generic
	// slot a route fills, not a switch on the route. Ticket 04 read the rule more strictly and had each such
	// route carry its own header strip beneath this bar; on `/align`, with two live map panes, that was
	// a second header costing height the maps needed.
	//
	// Before this, the theme toggle was on `/base-map/`, `/layers/` and `/align/` and not on the hub;
	// the save indicator and the undo control were on three pages each, mounted separately. Three
	// copies of a thing that has one meaning is how they came to look different from each other.
	//
	// Workspace identity was a **label** in ticket 04. Ticket 12 makes it a switcher, because browser
	// storage now holds several named Workspaces (ADR-0024) — and from ticket 14 onward one of them can
	// be a throwaway Review Workspace, which is a thing a user must never be in doubt about.

	import { resolve } from '$app/paths';
	import { describeRemote } from '@ballastella/core';
	import { AppBar, BallastellaMark, MenuPopover } from '@ballastella/ui';
	// Every one `aria-hidden`: each sits beside its own label, and an icon that names itself as well
	// is the same word twice for a screen reader — and would change the accessible name the tests and
	// a user's own "click the button called…" both go by (SPEC story 111).
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Folder from '@lucide/svelte/icons/folder';
	import Plus from '@lucide/svelte/icons/plus';
	import Settings from '@lucide/svelte/icons/settings';

	import PublishDialog from '$lib/publish/PublishDialog.svelte';
	import { publishControlLabel, type PublishProgress } from '$lib/publish/publish-progress.js';
	import UndoControl from '$lib/undo/UndoControl.svelte';
	import { theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import Toast from '$lib/toasts/Toast.svelte';

	import RemoteStatus from './RemoteStatus.svelte';
	import SaveIndicator from './SaveIndicator.svelte';
	import WorkspaceSettings from './WorkspaceSettings.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	/**
	 * Which Workspace this is, in words (SPEC story 88).
	 *
	 * Named rather than iconified, because "which Workspace did that last edit go into?" is exactly
	 * the question a scholar asks after their work is not where they left it — and a disc glyph
	 * answers it for nobody using a screen reader (SPEC story 111).
	 *
	 * The Workspace's own name in both backings, rather than "Browser storage", which named the
	 * *backing*: with several named Workspaces on one backing that sentence no longer identifies
	 * anything, and from ticket 14 a Review Workspace is browser-backed too.
	 */
	const workspaceName = $derived(storage === null ? 'Starting…' : storage.name);

	/**
	 * Whether the open Workspace cannot be reached.
	 *
	 * ⚠ **The menu's markings are the only thing here that can send a scholar towards recovery**
	 * (SPEC story 43). `status` belongs to the open session, so this is a fact about the Workspace
	 * currently on screen and about no other — which is why the marking lands on the open one's row:
	 * the folder row when the backing is a folder, and that Workspace's own `switch-workspace` row
	 * when it is browser storage refusing.
	 */
	const unreachable = $derived(session?.status === 'unreachable');

	/**
	 * Where this Workspace's bytes are, in words — the header's second fact (SPEC story 41).
	 *
	 * Only for the two settled backings. A remembered folder that is not open yet is browser-backed
	 * by this test and "Kept in this browser" is false of it, so the header states that state in its
	 * own sentence rather than through this one — see `awaitingFolder`.
	 */
	const backingSentence = $derived(
		storage?.backing === 'folder' ? 'A folder on this computer' : 'Kept in this browser'
	);

	/**
	 * Whether a push credential is held, and as whom (SPEC story 32).
	 *
	 * Read from the credential store rather than from anything remembered here, so it says what is
	 * **true**: the store is sealed while a Review Workspace is open (ADR-0033), and a token that
	 * cannot be read is a token this menu must not claim to hold.
	 */
	const credentialSentence = $derived(
		storage?.signedIn
			? storage.identity
				? `Signed in to GitHub as ${storage.identity}`
				: 'Signed in to GitHub'
			: 'Not signed in'
	);

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();
	let settingsOpen = $state(false);
	let publishOpen = $state(false);
	/**
	 * Whether a publish is running, and how far it has got.
	 *
	 * Bound out of `PublishDialog` rather than kept there, because the control that started it is on
	 * this bar and has to say so: `aria-disabled` with a label that reflects progress, never
	 * `disabled` — a `disabled` button leaves the tab order the instant it is pressed, dropping a
	 * keyboard user's focus to `<body>` for the length of the publish (SPEC story 60, WCAG 2.4.3).
	 */
	let publishing = $state(false);
	let publishProgress = $state<PublishProgress | null>(null);
	/**
	 * Whether this Workspace may be published at all (ADR-0024, SPEC story 39).
	 *
	 * Absent inside a review copy rather than present and refused, which is the arrangement the hub
	 * already had: the review copy holds somebody else's work, the hub says so in words where the
	 * button used to be, and `packages/core` refuses the binding by any route regardless.
	 *
	 * Absent for the same reason over a Workspace whose interrupted Import (ticket 05) or Update
	 * (ticket 15) could not be resolved. A publish plan is a walk of the Workspace, and until the
	 * marker is resolved that walk would include provisional files — which is what the whole gate
	 * exists to prevent, and the hub is already saying why in words.
	 */
	const publishable = $derived(
		storage !== null && storage.review === null && storage.unavailable === ''
	);

	/**
	 * Whether there is trustworthy evidence of what this Workspace and its Remote last shared
	 * (ADR-0038).
	 *
	 * ⚠ **Text rather than a colour, and stated rather than omitted**, for the reason the publishing
	 * line above it is: `Cannot tell` is a *determination* — absence, corruption, a record naming
	 * another repository, or a Baseline this browser refused to keep — and a scholar who is shown
	 * nothing reads it as "up to date". The three-way comparison itself is not here; what this says is
	 * whether there is anything to compare against.
	 */
	const remoteStatusSentence = $derived(
		storage === null || storage.remoteStatus !== 'cannot-tell'
			? ''
			: 'Cannot tell what has changed since this Workspace and GitHub last agreed.'
	);
	/** The new-Workspace field, or `null` when it is not being asked for. */
	let newName = $state<string | null>(null);
	let newNameField = $state<HTMLInputElement | undefined>();
	/**
	 * A hydration-stable id for the inline field's label.
	 *
	 * Not a literal, for the reason `MenuPopover` documents about its own: a hardcoded id is a
	 * collision waiting for the second instance on a page, and `for`/`id` is the whole of what ties a
	 * label to its field for a screen reader.
	 */
	const newNameId = $props.id();
	/** The button the inline form was opened from, so focus has somewhere to go back to. */
	let newNameReturn: HTMLElement | null = null;

	/**
	 * What just happened to the Workspace, announced (SPEC stories 111 and 112).
	 *
	 * ⚠ **Switching Workspaces changes almost everything on screen and, without this, says nothing.**
	 * The only visible signal is the switcher button's own label mutating, and a screen reader reports
	 * no such thing — a control's accessible name changing is not an announcement. So a scholar using
	 * one would move between Workspaces, hear silence, and be looking at a Project list that is now
	 * somebody else's. Deleting already had a live region; this is the same courtesy for the two
	 * actions that are far more frequent, and it carries the refusals as well.
	 */
	let announcement = $state('');

	/** Open something from the menu, having handed focus back first — see `MenuPopover.dismiss`. */
	function fromMenu(act: () => void): void {
		menu?.dismiss();
		act();
	}

	/**
	 * Close the inline form and put focus back where it came from.
	 *
	 * Without this the form unmounts with the pressed button still focused, and focus falls to
	 * `<body>` — a keyboard user is returned to the top of the document with no idea whether anything
	 * happened (WCAG 2.4.3, the rule the hub's own reclaim line is shaped by).
	 */
	function closeNewWorkspace(): void {
		newName = null;
		(newNameReturn ?? menu?.button())?.focus();
		newNameReturn = null;
	}

	async function switchWorkspace(name: string): Promise<void> {
		if (!storage) return;
		await storage.openWorkspace(name);
		announcement = `Switched to the Workspace “${name}”.`;
	}

	async function createWorkspace(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = newName ?? '';
		if (asked.trim() === '') {
			closeNewWorkspace();
			return;
		}
		closeNewWorkspace();
		try {
			const made = await storage?.createWorkspace(asked);
			// The name it *really* got, which may carry a ` (2)` the user did not type. Saying the typed
			// name back would be the one announcement that is wrong exactly when it matters.
			announcement = `Created the Workspace “${made}” and switched to it.`;
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<!--
	The shell's identity slot, first in the masthead tier — which Workspace you are in, and what is true
	of it. A published site puts its own name in the same place, which is the whole of what makes the
	two bars one bar.
-->
{#snippet start()}
	<!--
		1. Which Workspace, and the way to another one.

		**Always visible, on every screen** — the label was, and the switcher has to be for a stronger
		reason: from ticket 14 a user can be inside a throwaway Review Workspace, and a control that
		says which one you are in is worth nothing on the screens it is missing from.

		The menu is the Popover API through `MenuPopover`, which is mandated rather than merely
		available (ADR-0016) — a `<details>` or CSS-`:focus` dropdown dismisses on neither Escape nor a
		click elsewhere. The button's text carries the name, so the identity is readable without
		opening anything.
	-->
	<div class="flex items-center gap-2 text-sm" data-testid="workspace-identity">
		<span class="opacity-70">Workspace:</span>
		{#if storage === null}
			<span class="font-medium">{workspaceName}</span>
		{:else}
			<!-- `max-w-*` and truncation, because the name is up to 64 characters of somebody else's
			     text and the bar has three other controls to fit. The full name is in the menu, in
			     Workspace settings, and in the button's own `title`-free accessible name, which is the
			     text node rather than the ellipsis CSS paints over it. -->
			<MenuPopover
				bind:this={menu}
				label={workspaceName}
				buttonClass="btn max-w-[14rem] truncate btn-sm font-medium"
				testid="workspace-switcher"
			>
				<!--
					What this Workspace is: its name, where its bytes are, and where it publishes (SPEC
					story 41). The only place in the app those facts appear together, and a heading rather
					than a set of controls — every decision behind them is in Workspace settings, so the
					same choice is never offered in two places that could disagree (story 45).

					**The publishing line is stated even when there is nothing bound.** An omitted line
					reads as a rendering fault, and "no Remote yet" is the state a first-time author is
					in. It is still not a sign-in prompt: nothing here asks for a credential (story 38).
				-->
				<!--
					⚠ **Every line states its own ink, and none of them may inherit.** daisyUI paints
					`.menu-title`'s contents at `color-mix(in oklab, base-content 40%, transparent)`, which
					is 2.52:1 in light and 3.25:1 in dark against `base-100` — below AA at any size. Full
					`base-content` is 17.05:1 and 13.03:1, and `opacity-70` over it is 6.45:1 and 7.05:1, so
					a de-emphasised line still clears 4.5:1. `text-warning` is used only at full opacity:
					at 70% it falls to 2.79:1 in light.
				-->
				<li class="menu-title" data-testid="workspace-header">
					<span class="block truncate text-sm font-semibold text-base-content">
						{workspaceName}
					</span>
					<span class="block font-normal" data-testid="workspace-backing">
						{#if storage.awaitingFolder}
							<!--
								⚠ **"Kept in this browser" is false here** and this is the state every
								folder-backed scholar returns in: the folder is remembered, the browser wants a
								gesture before handing it back, and until that gesture the backing reads as
								`browser` (`workspace-storage.svelte.ts`, `awaitingFolder`). So the line names the
								folder, says it is not open, and says where the gesture is — the menu offers no
								folder control of its own (SPEC story 45).
							-->
							<span class="text-warning" data-testid="workspace-awaiting-folder">
								Your work is in the folder “{storage.reopenable}”, which is not open yet. Workspace
								settings can reopen it.
							</span>
						{:else}
							<span class="text-base-content opacity-70">{backingSentence}</span>
						{/if}
					</span>
					<span
						class="block font-normal text-base-content opacity-70"
						data-testid="workspace-publishes"
					>
						{#if storage.remote}
							Publishes to <span data-testid="workspace-remote"
								>{describeRemote(storage.remote)}</span
							>. <span data-testid="workspace-credential">{credentialSentence}</span>.
							<span data-testid="remote-status">{remoteStatusSentence}</span>
						{:else}
							No Remote yet, so nothing is published from this Workspace.
						{/if}
					</span>
				</li>
				<li class="menu-title">Switch to</li>
				{#each storage.workspaces as name (name)}
					<li>
						<button
							type="button"
							data-testid="switch-workspace"
							data-workspace={name}
							aria-current={storage.isOpen(name) ? 'true' : undefined}
							onclick={() => fromMenu(() => void switchWorkspace(name))}
						>
							<!-- A browser window, because that is where these are: the user needs to know their
							     work is in the browser rather than among their own files, and never that the
							     mechanism underneath is called OPFS. -->
							<AppWindow size={16} aria-hidden="true" class="shrink-0" />
							<!--
								The name and what is true of it in **one** truncating span, so they stay next to
								each other: as separate flex children the name's `truncate` takes the free space
								and shunts "(open)" to the far edge of the menu, where it reads as a column
								heading rather than as part of the line it belongs to.

								Which of these is somebody else's work in a throwaway Workspace, in **words**
								rather than as a tint or an icon (workspace-and-layers SPEC story 111). Review copies stay in the
								list rather than being filtered out of it: a teacher marking thirty submissions
								moves between them, and two students' conflicting Alignments of the same sheet
								never meet precisely because each is in its own Workspace (ADR-0024).
							-->
							<span class="min-w-0">
								<!-- `&nbsp;` and not a literal space: Svelte strips whitespace at the start of an
								     element, so `<span> (open)</span>` renders as "My Workspace(open)". -->
								<span class="block truncate">
									{name}{#if storage.reviewWorkspaces.includes(name)}<span class="opacity-70"
											>&nbsp;(review copy)</span
										>{/if}{#if storage.isOpen(name)}<span class="opacity-70">&nbsp;(open)</span
										>{/if}
								</span>
								{#if unreachable && storage.backing === 'browser' && storage.isOpen(name)}
									<!--
										The same marking as the folder row's, on the row that is the open Workspace when
										the backing is browser storage — OPFS itself refusing, which a second tab
										deleting the directory produces. One idiom for "this Workspace cannot be
										reached" rather than two, and it names a different way back only because a
										different one is true: nothing in Workspace settings locates a browser
										Workspace, and `WorkspaceRecovery`'s alert — which is on every screen — does.
									-->
									<span class="block text-warning" data-testid="workspace-unreachable">
										Unreachable. The notice on this screen can locate it again.
									</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
				{#if storage.backing === 'folder'}
					<!-- The folder Workspace is not one of the named ones and never appears in the list: it
					     is a different backing, and showing it as a sibling would suggest it can be deleted
					     from settings alongside them, which it cannot. -->
					<li>
						<span>
							<Folder size={16} aria-hidden="true" class="shrink-0" />
							<span class="min-w-0">
								<span class="block truncate opacity-70">
									{storage.folderName || 'A folder on this computer'} (open)
								</span>
								{#if unreachable}
									<!--
										⚠ **The whole of the way back, now that the folder controls are in settings**
										(SPEC story 43, ADR-0008). A folder that has moved, been renamed or been
										unplugged is a normal state, and a scholar who cannot see that it has
										happened has no reason to go looking for the control that fixes it — so the
										row says so in `warning`, in words, and names where the recovery is.
									-->
									<span class="block text-warning" data-testid="workspace-unreachable">
										Unreachable. Workspace settings can locate it again.
									</span>
								{/if}
							</span>
						</span>
					</li>
				{/if}
				<li>
					<button
						type="button"
						data-testid="new-workspace"
						onclick={() =>
							fromMenu(() => {
								// The switcher button, which is where focus is by now and where it goes back to.
								newNameReturn = menu?.button() ?? null;
								newName = '';
								// After the popover has gone, or focus lands on an element about to be hidden.
								queueMicrotask(() => newNameField?.focus());
							})}
					>
						<Plus size={16} aria-hidden="true" class="shrink-0" />
						New Workspace…
					</button>
				</li>
				<!-- A boundary rather than an emphasis, which is what ADR-0036 permits a rule to be: above
				     it is this Workspace and the others, below it is the way out of the menu.

				     `aria-hidden` and no `role`: `MenuPopover`'s list is a plain `<ul>` with no
				     `role="menu"`, so this is a listitem, and a `role="separator"` that is also hidden
				     announces nothing while adding a widget role to a list that has none. -->
				<li aria-hidden="true" class="my-1 border-t border-rule"></li>
				<li>
					<button
						type="button"
						data-testid="open-workspace-settings"
						onclick={() => fromMenu(() => (settingsOpen = true))}
					>
						<Settings size={16} aria-hidden="true" class="shrink-0" />
						Workspace settings…
					</button>
				</li>
			</MenuPopover>
		{/if}
	</div>

	{#if newName !== null && storage !== null}
		<!-- Inline on the bar rather than in a dialog: it is one field and one button, and a modal for
		     that is a modal a user has to dismiss to see the Workspace they just left. -->
		<form class="flex items-center gap-2" onsubmit={(event) => void createWorkspace(event)}>
			<label class="text-sm" for={newNameId}>Name</label>
			<input
				id={newNameId}
				class="input input-sm"
				bind:this={newNameField}
				bind:value={newName}
				data-testid="new-workspace-name"
				onkeydown={(event) => {
					if (event.key === 'Escape') closeNewWorkspace();
				}}
			/>
			<button class="btn btn-primary btn-sm" type="submit" data-testid="create-workspace">
				Create and switch
			</button>
			<button class="btn btn-sm" type="button" onclick={() => closeNewWorkspace()}>Cancel</button>
		</form>
	{/if}

	<!--
		What just happened to the Workspace. `aria-live` rather than `role="status"`: the save indicator
		already owns `status` on this bar, and a second one makes `getByRole('status')` ambiguous — which
		is a hint that a screen-reader user would have to disambiguate too. Visually hidden because the
		screen already shows the answer; the announcement is for the reader who cannot see it change.
	-->
	<p class="sr-only" aria-live="polite" data-testid="workspace-announcement">{announcement}</p>
{/snippet}

<!--
	What can be done on this screen, at the far end of the main row — opposite the page-chrome slot
	that says which screen it is, so that where you are and what you can do here are one row.

	The theme control is not among them: it is the shell's, it is the one thing both apps offer
	outright, and it now sits beside these in the main row's right cluster.
-->
{#snippet end()}
	{#if session !== null}
		<!--
			4. The way back from the last destructive action (SPEC story 12, ADR-0014). A slot rather
			than a button, because `UndoControl` renders nothing when there is nothing to undo — absent
			is the honest state, and it still has to be one identifiable place on the bar.
		-->
		<div data-testid="undo-slot">
			<UndoControl {session} />
		</div>

		<!--
			5. Putting the work on the web (SPEC story 1, ADR-0032).

			**In the bar with the save indicator, and that is the whole point of both.** "Saved locally"
			and "Publish" answer the two questions a scholar has about where their work is, and separating
			them across two screens is how somebody comes to believe a saved edit is a published one.
			They sit in different tiers because they answer differently: whether the work is kept is true
			of the Workspace, while publishing is an action taken from wherever you are. The Workspace is
			the site (ADR-0008), so this belongs to the bar rather than to a Project — it was on the hub,
			which meant it was absent from every screen where a person is actually working.

			**Enabled in every state except while it is running**, and each of them leads somewhere: it
			offers the binding when there is none, asks for the credential when there is no credential,
			and says so when nothing needs changing. A disabled Publish button with no explanation is
			the failure this epic exists to remove.
		-->
		{#if publishable}
			<button
				type="button"
				class="btn btn-sm"
				class:btn-disabled={publishing}
				aria-disabled={publishing}
				data-testid="publish"
				onclick={() => {
					if (!publishing) publishOpen = true;
				}}
			>
				{publishing ? publishControlLabel(publishProgress) : 'Publish…'}
			</button>
		{/if}
	{/if}
{/snippet}

<!--
	What is true of the Workspace whatever screen is on: whether the work is kept, and every reason it
	might not be. The eyebrow, beside the Workspace's own identity — a scholar asking whether their
	work is safe is asking about their Workspace and not about this screen (SPEC story 25).
-->
{#snippet status()}
	{#if session !== null}
		<!-- 6. Whether the work is kept. ADR-0017 rule 5: there is no Save button, so this is the
		     only signal that anything reached storage — which is why it is on every screen and not
		     only on the ones that happen to write. -->
		<!-- `min-h-8`, matching the Remote status's leading row: the eyebrow top-aligns its clusters, so
		     the badge keeps its centre line beside the Remote status and its buttons. -->
		<div class="flex min-h-8 items-center" data-testid="save-slot">
			<SaveIndicator saveState={session.saveState} />
		</div>

		<!--
			Why the work is not kept, and every neighbouring refusal, as messages the reader can put
			away rather than sentences under the bar for the rest of the session.

			**`SaveIndicator` still says *whether* the work is kept and this says *why not*.** The badge
			is a standing fact and belongs in the bar; each of these is news about something that just
			happened, and the eyebrow is not a log. `Toast` renders nothing here — the words are drawn
			in the layout's one stack — so a save error no longer moves the Remote status beside it.

			`refusal` on the three that are inserted at the moment their text first exists, which a
			polite region does not reliably announce (ADR-0016's amendment, SPEC story 112).
			`unprotected-browser` is not one of them: it is a steady-state fact about the browser, true
			from the first frame, and an assertive announcement would interrupt a scholar mid-alignment
			to tell them something that was already true when they opened the page.
		-->
		<Toast text={session.saveError} testid="save-error" refusal />
		<Toast text={session.protectionWarning} testid="protection-warning" refusal />
		<Toast text={session.deletionWarning} testid="deletion-warning" refusal />
		<Toast text={storage?.unprotected ?? ''} testid="unprotected-browser" />

		<!--
			7. Whether GitHub agrees with this Workspace (SPEC stories 111–118, ADR-0038).

			**Its own region, beside the save indicator and never inside it.** "Saved locally" is about
			this machine and says nothing about the Remote; a scholar who reads the one as the other
			publishes over a colleague's afternoon. They sit next to each other because they are the two
			halves of "where is my work", and they are two controls because they have two remedies.

			Only for an ordinary bound Workspace. A Review Workspace is never bound (ADR-0024) and an
			unbound one has nothing to compare against — the Workspace menu already states "No Remote
			yet, so nothing is published from this Workspace" in words, so a second empty control here
			would be a gap that reads as a rendering fault.
		-->
		{#if storage !== null && storage.remote !== null && storage.review === null}
			<RemoteStatus
				state={storage.remoteStatusState}
				onCheck={() => void storage.checkRemoteStatus()}
				update={storage.updateProgress}
				notice={storage.updateNotice}
				failure={storage.updateFailure}
				onUpdate={() => void storage.updateFromRemote()}
				deletionPreview={storage.deletionPreview}
				onAnswerDeletions={(confirmed) => storage.answerDeletionPreview(confirmed)}
			/>
		{/if}
	{/if}
{/snippet}

<!--
	`status` and no `menu`. The status puts the bar in two rows: the eyebrow holds `start` and the save
	state, and the taller main row holds the screen, the centered wordmark, and `end` + theme. No menu
	because authoring is desktop-only (ADR-0014), so this bar does not fold at any width.
-->
<!--
	The app's own name, in the display face, at the centre of the main row.

	ADR-0036 gives Bluu Next three jobs — it heads a section, names the app, and titles a dialog — and
	this is the one that names the app.

	**A link to the root route, which is what the viewer's own name has always been** (`SiteBar.svelte`
	renders `site-name` as an anchor to `resolve('/')`). The main row is the taller row that a scholar
	scans for where they are, so centering the mark there puts the app's name at the bar's visual
	centre (`AppBar`'s `1fr auto 1fr` grid). A wordmark that is not clickable reads as broken, because
	every other site a scholar uses has trained them otherwise.

	**Not a heading, and not a control label.** Every screen carries exactly one `<h1>` and three specs
	count it, so a second would break them — this is an `<a>`, not a heading. And ADR-0036's rule that
	this face never reaches a *control label* is about the text on a button or an input that names an
	action: naming the app is one of the face's three sanctioned jobs, and a name that is also the way
	home is still a name. The rule would be broken by setting `Publish` in Bluu Next, not by this.

	**Hidden below `lg` on the old masthead; now always flex.** The eyebrow is compact, so the main
	row has room to keep the wordmark centred at every desktop width the editor is used at. It hides
	below `md` only, where the breadcrumbs already need the width.
-->
{#snippet wordmark()}
	<a
		class="hidden link items-center gap-2 font-serif text-xl leading-none link-hover md:flex"
		data-testid="app-wordmark"
		href={resolve('/')}
	>
		<BallastellaMark />
		Ballastella
	</a>
{/snippet}

<AppBar
	{start}
	{end}
	{status}
	{wordmark}
	theme={theme.current}
	onToggleTheme={() => theme.toggle()}
	homeHref={resolve('/')}
/>

<!--
	Outside the bar so its own layout does not have to make room for a modal, and mounted
	unconditionally so the `<dialog>` element exists before `showModal()` is asked for.
-->
{#if storage !== null}
	<WorkspaceSettings bind:open={settingsOpen} {storage} />
{/if}

<!--
	ADR-0024: a Review Workspace is never published. Not mounted at all inside one, so there is no
	dialog to reach by any route — `WorkspaceStorage.assertNotReviewing` is the second layer, on the
	backup path where the button is in another component entirely.

	Its own live regions — the outcome, the staleness notice and a refusal that outlives the modal —
	render here, immediately under the bar, so that they are on whichever screen the user was on when
	they pressed the button.
-->
{#if publishable && storage !== null}
	<PublishDialog
		{storage}
		bind:open={publishOpen}
		bind:publishing
		bind:progress={publishProgress}
	/>
{/if}
