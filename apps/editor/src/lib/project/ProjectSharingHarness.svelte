<script lang="ts">
	// A parent for `ProjectSharing` in component tests. **Not shipped and not imported by the app.**
	//
	// The round trip is the point, for the reason `BorderStyleFieldsHarness` records: the Front Page
	// toggle's state is a reading of `project.json` rather than of the checkbox, so the harness holds
	// the value and hands it back down. And `shareLinks` moves — turning them on is one of the three
	// things *Share Project* can do — so the component must be re-rendered from what the Workspace
	// then holds rather than from a flag it set itself.

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
		enableShareLinks = async () => '',
		verifyShareLinks = async () => '',
		send = async () => ''
	}: {
		name?: string;
		directory?: string;
		onFrontPage?: boolean;
		shareLinks?: boolean | null;
		link?: string;
		unsent?: boolean;
		/** Reported as well as applied, so a spec can assert what the toggle asked for. */
		onwrite?: (on: boolean) => void;
		/** Answers `''` for success, or the sentence the author is left holding. */
		enableShareLinks?: () => Promise<string>;
		/** Answers `''` when GitHub Pages is serving the Workspace. */
		verifyShareLinks?: () => Promise<string>;
		send?: () => Promise<string>;
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
		const refusal = await enableShareLinks();
		if (refusal === '') shareLinks = true;
		return refusal;
	}}
	{verifyShareLinks}
	send={async () => {
		const refusal = await send();
		if (refusal === '') unsent = false;
		return refusal;
	}}
/>
