<script lang="ts">
	/**
	 * The two controls a Project's own settings carry: whether a Reader is offered it, and its link.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────────
	 * TWO CONTROLS, TWO DIFFERENT DEMANDS ON THE WORKSPACE, AND THE ASYMMETRY IS DELIBERATE
	 *
	 * **Show on Front Page** records an intention. It writes `project.json`, costs nothing to record
	 * early, and is offered with no Remote and no Share Links — with one line saying the front page
	 * does not exist yet, so nobody waits for something to happen. **Share Project** has to produce a
	 * working address, so it cannot be answered before there is a site to serve one: with no Share
	 * Links it offers the setup rather than refusing, and with work that has not reached the Remote it
	 * offers to send that first (ADR-0045).
	 *
	 * ⚠ **Nothing here is privacy, and nothing here may be worded as if it were.** The repository is
	 * readable and `?p=<directory>` opens the Project for anybody who has the link, so the Front Page
	 * decides one list and nothing else. A scholar with embargoed material will act on the reading the
	 * interface invites, so the invited reading has to be the true one — which is why the sentence
	 * below is beside the control rather than in a document.
	 *
	 * ⚠ **`aria-live="polite"` and never `role="status"`.** The save indicator in the root layout owns
	 * the app's one `status` region; a second one is an ambiguity for the reader who cannot see which
	 * is which.
	 */
	let {
		name,
		directory,
		onFrontPage,
		shareLinks,
		link,
		unsent,
		setOnFrontPage,
		enableShareLinks,
		send
	}: {
		/** The Project's display name, for the controls' accessible names. */
		name: string;
		/** The Project's folder, which is its identity and what its link names (ADR-0008). */
		directory: string;
		onFrontPage: boolean;
		/** Whether the Workspace carries a site, or `null` while nothing has read the files yet. */
		shareLinks: boolean | null;
		/** The address *Share Project* hands over, or `''` where there is no repository to serve it. */
		link: string;
		/** Whether this Project holds work the Remote has not got. */
		unsent: boolean;
		setOnFrontPage: (on: boolean) => Promise<void>;
		/** Turn Share Links on. Resolves to `''`, or to the sentence the author has to act on. */
		enableShareLinks: () => Promise<string>;
		/** Send this Workspace's files. Resolves to `''`, or to the sentence the author has to act on. */
		send: () => Promise<string>;
	} = $props();

	/** Which question *Share Project* is waiting on an answer to, or `'none'`. */
	let asking = $state<'none' | 'share-links' | 'unsent'>('none');
	let busy = $state(false);
	let copied = $state(false);
	let problem = $state('');

	const forget = (): void => {
		copied = false;
		problem = '';
	};

	/**
	 * Put the link on the clipboard.
	 *
	 * The address is rendered as text as well, because a browser that refuses clipboard access must
	 * not leave the author with no way to read what they asked for.
	 */
	async function copyLink(): Promise<void> {
		asking = 'none';
		forget();
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
		} catch {
			problem =
				`This browser would not let the page put anything on the clipboard, so copy the address ` +
				`above by hand. It is usually a setting this browser holds for this site.`;
		}
	}

	/** *Share Project*: the link, or whichever of the two things standing between it and the link. */
	async function shareProject(): Promise<void> {
		forget();
		if (shareLinks !== true) {
			asking = 'share-links';
			return;
		}
		if (unsent) {
			asking = 'unsent';
			return;
		}
		await copyLink();
	}

	/** The answer to the setup offer, which continues to the link rather than stopping at success. */
	async function turnOnShareLinks(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			problem = await enableShareLinks();
			if (problem !== '') return;
			asking = unsent ? 'unsent' : 'none';
			if (asking === 'none') await copyLink();
		} finally {
			busy = false;
		}
	}

	/** *Sync and copy the link*: the send first, and the link only where it succeeded. */
	async function syncAndCopy(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			problem = await send();
			if (problem === '') await copyLink();
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col items-start gap-3 pt-6" data-testid="front-page-settings">
	<h3 class="font-serif text-lg">Front page</h3>
	<p class="max-w-prose text-sm opacity-70">
		Whether a Reader arriving at your site's front page is offered this Project. It is not privacy:
		the repository is readable and the Project's own link opens it for anybody who has the link,
		whether or not the front page lists it.
	</p>
	<label class="flex items-center gap-3">
		<input
			type="checkbox"
			class="toggle toggle-sm"
			data-testid="on-front-page-{directory}"
			checked={onFrontPage}
			aria-label="Show on Front Page — {name}"
			onchange={(event) => void setOnFrontPage(event.currentTarget.checked)}
		/>
		<span class="text-sm font-medium">Show on Front Page</span>
	</label>
	<!--
		⚠ **Said where the flag is recorded early, so nobody waits for something to happen.** Recording
		the intention is free and is offered before there is a Remote at all; what does not exist yet
		is the page it decides a listing on.
	-->
	{#if shareLinks !== true}
		<p class="max-w-prose text-sm opacity-70" data-testid="no-front-page-yet">
			This Workspace has no front page yet. Turning Share Links on gives it one, and this choice is
			waiting for it.
		</p>
	{/if}
</section>

<section class="flex flex-col items-start gap-3 pt-6" data-testid="share-project-settings">
	<h3 class="font-serif text-lg">Share Project</h3>
	<p class="max-w-prose text-sm opacity-70">
		A link that opens this Project alone. It works whether or not the front page lists it.
	</p>
	{#if link !== ''}
		<code class="text-xs break-all opacity-70" data-testid="share-project-link">{link}</code>
	{/if}
	<button
		type="button"
		class="btn btn-sm"
		data-testid="share-project"
		onclick={() => void shareProject()}
	>
		Share Project<span class="sr-only"> {name}</span>
	</button>

	<!-- No site to serve the address: the answer to the request is the thing that was asked for. -->
	{#if asking === 'share-links'}
		<div class="flex max-w-prose flex-col items-start gap-2" data-testid="share-needs-share-links">
			<p class="text-sm">
				This Workspace has no Share Links yet, so there is no address to give anybody. Turning them
				on adds a read-only reading site to your repository; your own files travel either way.
			</p>
			<!-- `aria-disabled` and never `disabled`: a pressed `disabled` button leaves the tab order
			     and drops a keyboard user to `<body>` (WCAG 2.4.3). -->
			<button
				type="button"
				class="btn btn-primary btn-sm"
				class:btn-disabled={busy}
				aria-disabled={busy}
				data-testid="enable-share-links"
				onclick={() => void turnOnShareLinks()}
			>
				{busy ? 'Asking GitHub…' : 'Turn Share Links on'}
			</button>
		</div>
	{/if}

	<!--
		⚠ **Work that has not reached the Remote is offered the Sync first, and never instead.** A link
		to last week is worse than a wait, and a scholar who knows what they are doing is not blocked:
		both presses are here, and the sentence says which Project a Reader would meet.
	-->
	{#if asking === 'unsent'}
		<div class="flex max-w-prose flex-col items-start gap-2" data-testid="share-unsent">
			<p class="text-sm" data-testid="share-reader-would-see">
				This Project has work GitHub has not got. A Reader following the link now would see the last
				version that reached it, or nothing at all if none of it has.
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="btn btn-primary btn-sm"
					class:btn-disabled={busy}
					aria-disabled={busy}
					data-testid="sync-and-copy-link"
					onclick={() => void syncAndCopy()}
				>
					{busy ? 'Sending…' : 'Sync and copy the link'}
				</button>
				<button
					type="button"
					class="btn btn-sm"
					data-testid="copy-link-anyway"
					onclick={() => void copyLink()}
				>
					Copy the link anyway
				</button>
			</div>
		</div>
	{/if}

	<p aria-live="polite" class="max-w-prose text-sm" data-testid="share-project-said">
		{#if problem !== ''}
			{problem}
		{:else if copied}
			The link is on your clipboard.
		{/if}
	</p>
</section>
