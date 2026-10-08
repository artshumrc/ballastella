<script lang="ts">
	import { toasts } from './toasts.svelte.js';
</script>

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
