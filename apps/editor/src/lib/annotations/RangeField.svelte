<script lang="ts">
	import { KIND_STYLE } from '@ballastella/ui';

	let {
		label,
		testid,
		value,
		min,
		max,
		step,
		kind = 'annotation',
		oninput,
		oncommit
	}: {
		label: string;
		testid: string;
		value: number;
		min: number;
		max: number;
		step: number;
		kind?: 'annotation' | 'map';
		oninput: (value: number) => void;
		oncommit: () => void;
	} = $props();
</script>

<label class="flex items-center justify-between gap-2 text-sm">
	<span>{label}</span>
	<span class="flex items-center gap-2">
		<input
			type="range"
			class="range w-32 shrink-0 range-sm {KIND_STYLE[kind].range}"
			{min}
			{max}
			{step}
			{value}
			data-testid={testid}
			oninput={(event) => oninput(Number(event.currentTarget.value))}
			onchange={() => oncommit()}
		/>
		<span class="w-10 shrink-0 text-right tabular-nums" data-testid="{testid}-value">
			{value}
		</span>
	</span>
</label>
