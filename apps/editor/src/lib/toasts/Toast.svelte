<script lang="ts">
	// One message, stated where the thing that knows it lives and drawn in the one fixed stack.
	//
	// This component renders nothing. It exists so a call site stays declarative — `<Toast
	// text={session.saveError} …/>` beside the state it is about — while the markup lives in
	// `ToastStack`, which is mounted once for the whole app. Svelte has no portal, and a `.toast` per
	// call site is a stack per call site sitting on top of the others.
	//
	// The effect is the bridge between reactive text and a list, which is the one thing `$derived`
	// cannot do: the store has to be told when the words change *and* when this screen goes away, and
	// the cleanup is what withdraws a message whose source has been unmounted.

	import { toasts, type ToastTone } from './toasts.svelte.js';

	let {
		text,
		testid,
		tone = 'warning',
		refusal = false
	}: {
		/** What to say. `''` for nothing, which withdraws whatever this source last said. */
		text: string;
		/** The name the line carried before it became a toast; the stack puts it on the message. */
		testid: string;
		tone?: ToastTone;
		/** A refusal is announced on insertion; a status shares the stack's polite region. */
		refusal?: boolean;
	} = $props();

	$effect(() => {
		toasts.post({ text, testid, tone, refusal });
		return () => toasts.withdraw(testid);
	});
</script>
