<script lang="ts">
	import BusyButton from '$lib/components/BusyButton.svelte';
	import { Task } from '$lib/task.svelte';

	let {
		name,
		directory,
		onFrontPage,
		shareLinks,
		link,
		unsent,
		setOnFrontPage,
		enableShareLinks,
		verifyShareLinks,
		send
	}: {
		name: string;
		directory: string;
		onFrontPage: boolean;
		shareLinks: boolean | null;
		link: string;
		unsent: boolean;
		setOnFrontPage: (on: boolean) => Promise<void>;
		enableShareLinks: () => Promise<void>;
		verifyShareLinks: () => Promise<string>;
		send: () => Promise<void>;
	} = $props();

	const task = new Task();
	let asking = $state<'none' | 'share-links' | 'unsent'>('none');
	let copied = $state(false);
	let verified = $state(false);
	let refusal = $state('');
	const problem = $derived(task.problem || refusal);

	const forget = (): void => {
		copied = false;
		refusal = '';
		task.problem = '';
	};

	async function copyLink(): Promise<void> {
		asking = 'none';
		forget();
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
		} catch {
			refusal =
				`This browser would not let the page put anything on the clipboard, so copy the address ` +
				`above by hand. It is usually a setting this browser holds for this site.`;
		}
	}

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
		await task.run(async () => {
			refusal = await verifyShareLinks();
			if (refusal !== '') return;
			verified = true;
			await copyLink();
		});
	}

	const turnOnShareLinks = () =>
		task.run(async () => {
			await enableShareLinks();
			verified = true;
			asking = unsent ? 'unsent' : 'none';
			if (asking === 'none') await copyLink();
		});

	const syncAndCopy = () =>
		task.run(async () => {
			await send();
			await copyLink();
		});
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
	{#if verified && link !== ''}
		<code class="text-xs break-all opacity-70" data-testid="share-project-link">{link}</code>
	{/if}
	<BusyButton
		type="button"
		class="btn btn-sm"
		busy={task.working}
		data-testid="share-project"
		onclick={shareProject}
	>
		{task.working ? 'Checking Pages…' : 'Share Project'}<span class="sr-only"> {name}</span>
	</BusyButton>

	{#if asking === 'share-links'}
		<div class="flex max-w-prose flex-col items-start gap-2" data-testid="share-needs-share-links">
			<p class="text-sm">
				This Workspace has no Share Links yet, so there is no address to give anybody. Turning them
				on adds a read-only reading site to your repository; your own files travel either way.
			</p>
			<BusyButton
				type="button"
				class="btn btn-primary btn-sm"
				busy={task.working}
				data-testid="enable-share-links"
				onclick={turnOnShareLinks}
			>
				{task.working ? 'Asking GitHub…' : 'Turn Share Links on'}
			</BusyButton>
		</div>
	{/if}

	{#if asking === 'unsent'}
		<div class="flex max-w-prose flex-col items-start gap-2" data-testid="share-unsent">
			<p class="text-sm" data-testid="share-reader-would-see">
				This Project has work GitHub has not got. A Reader following the link now would see the last
				version that reached it, or nothing at all if none of it has.
			</p>
			<div class="flex flex-wrap gap-2">
				<BusyButton
					type="button"
					class="btn btn-primary btn-sm"
					busy={task.working}
					data-testid="sync-and-copy-link"
					onclick={syncAndCopy}
				>
					{task.working ? 'Sending…' : 'Sync and copy the link'}
				</BusyButton>
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
