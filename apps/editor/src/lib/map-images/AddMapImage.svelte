<script lang="ts">
	// One way into a Project for a Map Image, offering all three of its sources at once.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THREE SOURCES, EQUALLY VISIBLE, IN ONE PLACE
	//
	// A scholar has a map on their laptop, a map at a library, and a map they prepared last week, and
	// all three questions are answered here in the same register: three `<section>`s, all rendered,
	// none behind a disclosure, a link, or a tab. Answering them in three different registers — a file
	// input at the top of a section, a URL form below it, and nothing at all for a map already in the
	// Workspace — is what this shape is against.
	//
	// **Why a dialog rather than three panels in the sidebar.** The sidebar is a fixed 24rem column
	// beside the map, and the library flow alone is a URL form, a rights statement, a metadata table
	// and a scrolling list of canvases. Stacked in that column the three sources would be equally
	// *present* and nothing like equally *visible* — the third would be several screens below the fold,
	// which is the extra step this shape rules out, wearing a scrollbar instead of a link. So the
	// sidebar carries one button with words on it and this is what the button opens.
	//
	// ADR-0016 mandates `<dialog>` + `showModal()`, and {@link ModalDialog} is where that decision was
	// made once: Escape, the focus trap, and focus restoration come with it.
	//
	// **Mounted outside `project-screen`** by its caller: daisyUI's `.modal` keeps a closed `<dialog>`
	// laid out, so its controls answer a `querySelectorAll` of visible controls while being unreachable
	// by keyboard, and `editor-project-screen.e2e.ts` walks exactly that set.

	import { describeBytes, type WorkspaceMapImage } from '@ballastella/core';

	import ModalDialog from '$lib/components/ModalDialog.svelte';
	import AddRemoteMap from '$lib/remote-iiif/AddRemoteMap.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';

	import MapThumbnail from './MapThumbnail.svelte';

	let {
		session,
		open = $bindable(false),
		onnotice
	}: {
		session: EditorSession;
		open?: boolean;
		/**
		 * Something a source has to say that outlives this dialog, or `''` to clear it.
		 *
		 * Every one of the three sources closes the dialog when it succeeds, so anything worth reading
		 * afterwards has to be handed to the screen. See `AddRemoteMap`'s `onadded` for the case this
		 * exists for.
		 */
		onnotice?: (notice: string) => void;
	} = $props();

	/**
	 * The Workspace's Map Images, walked when the dialog opens and not before.
	 *
	 * `listWorkspaceMapImages` weighs every file under `images/`, which on a Workspace holding a
	 * gigapixel scan is tens of thousands of `size` calls — so it is tied to the gesture that needs
	 * it rather than to a render. Re-walked on every open, because the answer changes: an ingest
	 * that finished, a map deleted from the hub, a Layer added in another tab.
	 *
	 * **`refreshAddableMapImages` and not `refreshMapImages`**, which is the hub's. Two
	 * differences, both of which were defects: it re-reads the `remote.json` records the add itself
	 * needs, so this cannot list a map it will then refuse; and a walk that fails says so *here*
	 * rather than putting the whole editor into the unreachable state, which would blank an open
	 * Project because the user pressed a button.
	 *
	 * The last add's notice is cleared with the same gesture. It lives outside this dialog on
	 * purpose (see {@link onnotice}), so without this a sentence about an add that happened minutes
	 * ago sits in a live region beside a fresh one — and `aria-live` announces a *change*, so a
	 * stale sentence that is still true of nothing is worse than none.
	 */
	$effect(() => {
		if (!open) return;
		onnotice?.('');
		void session.refreshAddableMapImages();
	});

	/**
	 * The maps this Project could gain, which is every Map Image in the Workspace **except the
	 * ones it already draws**.
	 *
	 * Offering a map this Project already has would be offering an action that does nothing:
	 * `#addMapLayer` is a no-op on the stack for a map already in it, so the row would swallow a
	 * click and change nothing on screen. `mapLayerFor` is the session's one answer to "does this
	 * Project draw that map?", asked here rather than re-derived, so the list and the add cannot
	 * disagree about what is already in.
	 *
	 * A map whose pyramid is here but whose starter Alignment never landed is **in** this list, and
	 * that is the point of it: it has no Layer anywhere, so nothing else on this screen mentions it.
	 */
	const available = $derived(
		session.mapImages.filter((map) => session.mapLayerFor(map.imageId) === undefined)
	);

	/**
	 * The ADR-0011 shim each row's picture reads its tile through (ADR-0030).
	 *
	 * One for the whole list, as on the hub: it is Workspace-rooted and takes no Project.
	 */
	const fetchTile = $derived(session.imageServiceFetch());

	/** What a map is called in the list, never its hash where anything better is known. */
	const nameOf = (map: WorkspaceMapImage): string => map.label || map.imageId;

	/**
	 * What one Workspace map weighs, and how many files that is.
	 *
	 * The size is what a row has to state and the file count is what makes it legible: "3 files" and
	 * "31 000 files" are different news about the same 40 MB. Both come from `WorkspaceMapImage`,
	 * which is core's figure and the same one the hub's reclaim list states.
	 */
	const weightOf = (map: WorkspaceMapImage): string =>
		`${describeBytes(map.bytes)} in ${map.files} ${map.files === 1 ? 'file' : 'files'}`;

	/**
	 * Adding a Workspace map is one at a time, so a double click cannot make two Layers.
	 *
	 * **Two guards for one rule, and they catch different clicks.** `disabled` catches the second
	 * press once Svelte has flushed; the early return catches the one that arrives *before* it —
	 * two clicks dispatched in one task, which is what a real double-click on a slow machine is.
	 * `addWorkspaceMap` awaits a store read before it looks at the stack, so two calls in flight
	 * together both find no Layer for the map.
	 *
	 * ⚠ **`#addMapLayer` holds the same invariant a second time**, with three `drawnAlready()`
	 * checks across its awaits — so `editor-add-map-image.e2e.ts`'s "two clicks in one task"
	 * test asserts the *property* (one Layer, not two) and stays green with either guard alone.
	 *
	 * **Nothing re-checks that, and nothing here claims otherwise.** It was measured once, by hand,
	 * and the measurement is written down at the assertion it is about — that test's own header —
	 * rather than here, because that is the file a future reader is holding when the question comes
	 * up. There is no mutation harness in this repository, so no run will tell you this guard has
	 * gone dead: do not delete it on the strength of a green suite. What it earns on its own is
	 * cheap and real — it keeps a redundant Alignment `create` and a store read from happening at
	 * all, before either reaches the session.
	 */
	let adding = $state('');

	async function addFromWorkspace(imageId: string): Promise<void> {
		if (adding !== '') return;
		adding = imageId;
		// Read before the add, because the row this came from is gone by the time there is anything
		// to say — the dialog closes on success.
		const listed = session.mapImages.find((map) => map.imageId === imageId);
		const name = listed ? nameOf(listed) : imageId;
		onnotice?.('');
		try {
			const layer = await session.addWorkspaceMap(imageId);
			// Closed only on success. A refusal has a sentence, and a dialog that vanished with it is a
			// refusal nobody read.
			if (!layer) return;
			open = false;
			// ─────────────────────────────────────────────────────────────────────────────────────
			// SAID, BECAUSE THIS IS THE ONE SOURCE WITH NOTHING ELSE TO SAY IT
			//
			// The file source answers with a preparing card and a running commentary; the library
			// source answers with a card too, and with the community-Alignment notice. This one
			// finishes in a few milliseconds and closes the dialog, so a screen-reader user was left
			// with a dialog that vanished and no statement that anything had happened — which is
			// indistinguishable from a dialog that closed for no reason.
			//
			// The Layer's own name rather than the row's label, because the row is gone by now, and
			// the two facts a user cannot see are the two this says: it is a Layer here, and nothing
			// was copied to make it one.
			onnotice?.(
				`“${layer.name || name}” is now a Layer in this Project. Nothing was copied: it is the ` +
					`Map Image this Workspace already holds, with the Alignment it already has.`
			);
		} finally {
			adding = '';
		}
	}

	/** The file source. The dialog closes on the pick, because the progress is on the Layer's card. */
	function chooseFile(input: HTMLInputElement): void {
		const file = input.files?.[0];
		// Cleared straight away, so picking the same file twice runs twice: `change` does not fire for
		// an unchanged value, and "nothing happened" is indistinguishable from a silent failure.
		input.value = '';
		if (!file) return;
		onnotice?.('');
		open = false;
		void session.ingestImage(file);
	}

	/** The library source is done with; its Layer is in the stack, and it may have something to say. */
	function remoteAdded(added: { notice: string }): void {
		onnotice?.(added.notice);
		open = false;
	}
</script>

<ModalDialog bind:open title="Add a Map Image" wide>
	<p class="max-w-prose text-sm">
		Map images can be added from a file on your computer or from the web. 
		The same image can be reused across project: align once, use multiple times.
	</p>

	<!--
		Source one: a file on this computer.

		Every image becomes a IIIF pyramid, including a small one, because an untiled level-0 image
		cannot be parsed at all (ADR-0003). So this is a job with progress rather than a file input that
		finishes instantly — and the progress is reported on the new Layer's own card in the sidebar,
		which is why this dialog closes the moment a file is picked.

		**The label is unchanged** ("Add a Map Image from a file"): it is what a screen-reader user
		and a keyboard user both go on, and it is what the whole browser suite reaches this control by.
	-->
	<section class="mt-6" aria-labelledby="add-from-file-heading">
		<h3 id="add-from-file-heading" class="text-lg font-semibold">From a file on this computer</h3>
		<label class="mt-3 block">
			<span class="mb-1 block text-sm">Add a Map Image from a file</span>
			<input
				class="file-input w-full"
				type="file"
				accept="image/*"
				data-testid="add-from-file"
				disabled={session.ingest !== null}
				onchange={(event) => chooseFile(event.currentTarget)}
			/>
		</label>
		{#if session.ingest !== null}
			<!--
				Why the input is disabled, said rather than left as a control that ignores a click. The
				refusal `ingestImage` answers a second file with is the same fact after the fact; this is it
				before, which is the half a user can act on.
			-->
			<p class="mt-2 max-w-prose text-sm" data-testid="ingest-busy">
				“{session.ingestLabel}” is still being prepared. Its Layer in this Project shows how far it
				has got, and one map is prepared at a time.
			</p>
		{/if}
	</section>

	<!--
		Source two: a map on a Library's server.

		`AddRemoteMap` carries the machinery — the Manifest, Collection and bare-image-service reading,
		the canvas picker, the CORS probe and the ADR-0015 community lookup. This dialog decides where
		it is reached from and nothing about what it does.
	-->
	<div class="mt-8 border-t border-base-300 pt-2">
		<!-- Its own `<section>` and its own heading, "Add a Map Image from a library". A second
		     heading wrapped around it would announce the same source twice. -->
		<AddRemoteMap {session} onadded={remoteAdded} />
	</div>

	<!--
		Source three: a Map Image this Workspace already holds.

		The one ADR-0023 is for: nothing is copied, the pyramid is not read, and an Alignment made in
		another Project applies here the moment the Layer appears.
	-->
	<section class="mt-8 border-t border-base-300 pt-6" aria-labelledby="add-from-workspace-heading">
		<h3 id="add-from-workspace-heading" class="text-lg font-semibold">Already in this Workspace</h3>
		<p class="mt-1 max-w-prose text-sm opacity-70">
			Nothing is copied and nothing is prepared again. If the map has already been placed on the
			earth — in this Project or any other — it is drawn as soon as it is added.
		</p>

		{#if session.addMapError}
			<div role="alert" class="mt-3 alert max-w-prose alert-warning">
				<p data-testid="add-from-workspace-error">{session.addMapError}</p>
			</div>
		{/if}

		{#if session.mapImagesLoading && session.mapImages.length === 0}
			<p class="mt-3 text-sm" data-testid="workspace-maps-loading">
				Looking through this Workspace…
			</p>
		{:else if available.length === 0}
			<!--
				Two different facts, and they must not share a sentence: a Workspace with no other maps in
				it, and a Workspace whose maps are all already here. The second is the more common and the
				more confusing one — a list that is empty because everything is in already reads as a list
				that is broken.
			-->
			<p class="mt-3 max-w-prose text-sm" data-testid="no-workspace-maps">
				{session.mapImages.length === 0
					? 'This Workspace holds no Map Images yet. Add one from a file or from a library, and it is here for every Project afterwards.'
					: 'Every Map Image in this Workspace is already in this Project.'}
			</p>
		{:else}
			<ul
				class="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto"
				aria-label="Map Images in this Workspace"
			>
				{#each available as map (map.imageId)}
					<!-- The row rather than the button, because the picture is beside the button: a picture
					     of the wrong map would be worse than no picture, so an assertion about one has to be
					     able to scope itself to the candidate it belongs to. -->
					<li class="flex items-center gap-3" data-testid="workspace-map-row">
						<!--
							A picture of the sheet, before the text, exactly as the hub's card row has it
							(ADR-0030) — this is the surface where recognising a sheet matters most, because a
							scholar choosing between eleven scans is otherwise choosing between eleven folder
							names.

							**Beside the button and not inside it**, which is both halves of the rule: a `<div>`
							is not phrasing content and so has no business inside a `<button>`, and the picture
							stays a picture — no tab stop, no handler, nothing between a scholar and the control
							they are reaching for. `48` rather than the hub's 96: these rows are a scrolling list
							in a dialog, not cards.
						-->
						<MapThumbnail {map} {fetchTile} size={48} />
						<!--
							A real `<button>` per map, so Tab reaches each and Enter and Space activate it — the
							same shape the canvas picker uses, and for the same reason. The size is inside the
							button rather than beside it, so it is part of the accessible name: a
							screen-reader user choosing between two maps needs the number the sighted user is
							choosing on.
						-->
						<button
							class="btn h-auto grow flex-col items-start gap-0 btn-ghost py-2"
							type="button"
							data-testid="workspace-map"
							data-image-id={map.imageId}
							disabled={adding !== ''}
							onclick={() => void addFromWorkspace(map.imageId)}
						>
							<span class="font-medium">{nameOf(map)}</span>
							<span class="text-xs font-normal opacity-70">{weightOf(map)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#snippet actions()}
		<button
			type="button"
			class="btn btn-sm"
			data-testid="close-add-map-image"
			onclick={() => (open = false)}
		>
			Close
		</button>
	{/snippet}
</ModalDialog>
