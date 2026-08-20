<script lang="ts">
	import mark from './assets/ballastella-mark.png';

	let { class: className = '' }: { class?: string } = $props();
</script>

<img class={className} src={mark} alt="" aria-hidden="true" />

<style>
	img {
		width: 1em;
		height: 1em;
	}
</style>
