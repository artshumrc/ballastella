<script lang="ts">
	import { untrack } from 'svelte';

	import ProjectSharing from './ProjectSharing.svelte';

	let {
		name = 'Amsterdam 1625',
		directory = 'amsterdam-1625',
		onFrontPage: initiallyOnFrontPage = false,
		shareLinks: initialShareLinks = false,
		link = 'https://ada.github.io/atlas/?p=amsterdam-1625',
		unsent: initiallyUnsent = false,
		onwrite,
		enableShareLinks = async () => {},
		verifyShareLinks = async () => '',
		send = async () => {}
	}: {
		name?: string;
		directory?: string;
		onFrontPage?: boolean;
		shareLinks?: boolean | null;
		link?: string;
		unsent?: boolean;
		onwrite?: (on: boolean) => void;
		enableShareLinks?: () => Promise<void>;
		verifyShareLinks?: () => Promise<string>;
		send?: () => Promise<void>;
	} = $props();

	let onFrontPage = $state(untrack(() => initiallyOnFrontPage));
	let shareLinks = $state<boolean | null>(untrack(() => initialShareLinks));
	let unsent = $state(untrack(() => initiallyUnsent));
</script>

<ProjectSharing
	{name}
	{directory}
	{onFrontPage}
	{shareLinks}
	{link}
	{unsent}
	setOnFrontPage={async (on) => {
		onwrite?.(on);
		onFrontPage = on;
	}}
	enableShareLinks={async () => {
		await enableShareLinks();
		shareLinks = true;
	}}
	{verifyShareLinks}
	send={async () => {
		await send();
		unsent = false;
	}}
/>
