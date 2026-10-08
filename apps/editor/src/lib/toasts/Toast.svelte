<script lang="ts">
	import { toasts, type ToastTone } from './toasts.svelte.js';

	let {
		text,
		testid,
		tone = 'warning',
		refusal = false
	}: {
		text: string;
		testid: string;
		tone?: ToastTone;
		refusal?: boolean;
	} = $props();

	$effect(() => {
		toasts.post({ text, testid, tone, refusal });
		return () => toasts.withdraw(testid);
	});
</script>
