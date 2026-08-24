<script lang="ts">
	// Where every dismissible message is drawn: one fixed stack, mounted once by the layout.
	//
	// ⚠ **A message inside an open `<dialog>` cannot live here.** `showModal()` puts the dialog in the
	// top layer and makes the rest of the document inert, so a toast posted while a modal is open is
	// both invisible and unannounced. Outcomes that belong to a dialog are stated inside it, and reach
	// this stack only once it has closed — which is what `PublishDialog` does with its result.

	import { toasts } from './toasts.svelte.js';
</script>

<!--
	`aria-live="polite"` on the container, which is mounted from the first frame: a region inserted at
	the same moment as its first text is not reliably announced (ADR-0016), and that is the whole
	reason the stack is always here and empty rather than raised with its first message. A refusal
	carries `role="alert"` on the message itself, which announces on insertion.

	`mt-20` clears the navigation bar, so a message never covers the Publish button or the theme
	control it is most likely to be about.
-->
<div class="toast toast-end toast-top z-50 mt-20" aria-live="polite" data-testid="toast-stack">
	{#each toasts.items as item (item.id)}
		<div
			class="alert max-w-md items-start"
			class:alert-info={item.tone === 'info'}
			class:alert-warning={item.tone === 'warning'}
			class:alert-error={item.tone === 'error'}
			role={item.refusal ? 'alert' : undefined}
			aria-live={item.refusal ? undefined : 'polite'}
			aria-atomic="true"
			data-testid={item.testid}
		>
			<p class="text-sm">{item.text}</p>
			<button type="button" class="btn shrink-0 btn-sm" onclick={() => toasts.dismiss(item.id)}>
				Dismiss
			</button>
		</div>
	{/each}
</div>
