<script lang="ts">
	import type { ControlPoint, GeoPoint, ResourcePoint } from '@ballastella/core';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	import type { AlignmentPairing } from './pairing.svelte.js';

	let {
		pairing,
		onedit,
		onremove
	}: {
		pairing: AlignmentPairing | undefined;
		onedit: (point: ControlPoint, resource: ResourcePoint, geo: GeoPoint) => void;
		onremove: (point: ControlPoint) => void;
	} = $props();

	type CoordinateField = 'resourceX' | 'resourceY' | 'longitude' | 'latitude';
	const COORDINATE_FIELDS: readonly {
		field: CoordinateField;
		id: string;
		label: string;
		heading?: string;
	}[] = [
		{
			field: 'resourceX',
			id: 'resource-x',
			label: 'Map Image x coordinate',
			heading: 'Map Image pixels (x, y)'
		},
		{ field: 'resourceY', id: 'resource-y', label: 'Map Image y coordinate' },
		{
			field: 'longitude',
			id: 'longitude',
			label: 'Longitude',
			heading: 'Geographic coordinates (longitude, latitude)'
		},
		{ field: 'latitude', id: 'latitude', label: 'Latitude' }
	];

	const controlPoints = $derived(pairing?.controlPoints ?? []);
	const selectedId = $derived(pairing?.selectedId ?? null);
	let list = $state<HTMLElement | undefined>();
	let draft = $state<({ readonly id: string } & Record<CoordinateField, string>) | null>(null);
	let error = $state('');

	const pointReadout = (point: ControlPoint) =>
		`${Math.round(point.resource.x)}, ${Math.round(point.resource.y)} px → ${point.geo.lng.toFixed(5)}, ${point.geo.lat.toFixed(5)}`;

	const startEdit = (point: ControlPoint): void => {
		draft = {
			id: point.id,
			resourceX: String(point.resource.x),
			resourceY: String(point.resource.y),
			longitude: String(point.geo.lng),
			latitude: String(point.geo.lat)
		};
		error = '';
		requestAnimationFrame(() =>
			document.getElementById(`control-point-${point.id}-resource-x`)?.focus()
		);
	};

	const parseCoordinate = (value: string): number | null => {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	};

	const saveEdit = (): void => {
		const editing = draft;
		if (!editing || !pairing) return;
		const [resourceX, resourceY, longitude, latitude] = COORDINATE_FIELDS.map(({ field }) =>
			parseCoordinate(editing[field])
		);
		if (resourceX == null || resourceY == null || longitude == null || latitude == null) {
			error = 'Enter a number for every coordinate.';
			return;
		}
		const { width, height } = pairing.alignment.image;
		if (resourceX < 0 || resourceX > width || resourceY < 0 || resourceY > height) {
			error = `Map Image coordinates must be within 0–${width} by 0–${height} pixels.`;
			return;
		}
		if (latitude < -90 || latitude > 90) {
			error = 'Latitude must be between -90 and 90.';
			return;
		}
		const point = controlPoints.find((one) => one.id === editing.id);
		if (point) onedit(point, { x: resourceX, y: resourceY }, { lng: longitude, lat: latitude });
		draft = null;
	};

	export const cancelEdit = (): boolean => {
		if (!draft) return false;
		const { id } = draft;
		draft = null;
		error = '';
		requestAnimationFrame(() =>
			list
				?.querySelector<HTMLButtonElement>(
					`[data-testid="control-point-coordinates"][data-control-point-id="${id}"]`
				)
				?.focus()
		);
		return true;
	};
</script>

<section aria-labelledby="control-points-heading">
	<h4 id="control-points-heading" class="text-sm font-semibold">
		Control Points ({controlPoints.length})
	</h4>

	{#if controlPoints.length === 0}
		<p class="mt-1 text-sm opacity-70">None yet.</p>
	{:else}
		<ul bind:this={list} class="mt-2 flex flex-col gap-1" data-testid="control-point-list">
			{#each controlPoints as point (point.id)}
				<li class="flex items-center gap-2 text-sm" data-testid="control-point-row">
					<button
						class="btn shrink-0 btn-xs"
						class:btn-secondary={point.id === selectedId}
						aria-pressed={point.id === selectedId}
						data-testid="control-point-select"
						data-ordinal={point.ordinal}
						onclick={() => pairing?.toggleSelected(point.id)}
					>
						Point
						<span
							class="tabular-nums"
							data-testid="control-point-row-ordinal"
							data-ordinal={point.ordinal}>{point.ordinal}</span
						>
					</button>
					{#if draft?.id === point.id}
						<form
							class="min-w-0 flex-1"
							data-testid="control-point-coordinate-editor"
							onsubmit={(event) => {
								event.preventDefault();
								saveEdit();
							}}
						>
							<div class="grid grid-cols-2 gap-1">
								{#each COORDINATE_FIELDS as { field, id, label, heading } (field)}
									{#if heading}
										<p class="col-span-2 text-xs font-medium" class:mt-1={field !== 'resourceX'}>
											{heading}
										</p>
									{/if}
									<label class="sr-only" for="control-point-{point.id}-{id}">{label}</label>
									<input
										id="control-point-{point.id}-{id}"
										type="text"
										inputmode="decimal"
										class="input w-full input-sm"
										aria-invalid={error !== ''}
										aria-describedby={error === '' ? undefined : 'coordinate-error'}
										value={draft[field]}
										oninput={(event) => {
											if (!draft) return;
											draft[field] = event.currentTarget.value;
											error = '';
										}}
									/>
								{/each}
							</div>
							{#if error}
								<p id="coordinate-error" class="mt-1 text-xs text-error" role="alert">
									{error}
								</p>
							{/if}
							<div class="mt-1 flex gap-1">
								<button class="btn btn-primary btn-xs" type="submit">Save</button>
								<button class="btn btn-ghost btn-xs" type="button" onclick={cancelEdit}>
									Cancel
								</button>
							</div>
						</form>
					{:else}
						<button
							type="button"
							class="min-w-0 flex-1 truncate text-left font-mono opacity-70 hover:underline"
							title={pointReadout(point)}
							aria-label={`Edit Control Point ${point.ordinal} coordinates`}
							data-testid="control-point-coordinates"
							data-control-point-id={point.id}
							onclick={() => startEdit(point)}
						>
							{pointReadout(point)}
						</button>
					{/if}
					<button
						type="button"
						class="btn btn-square shrink-0 btn-outline btn-error btn-sm"
						data-testid="control-point-delete"
						onclick={() => onremove(point)}
					>
						<Trash2 size={13} aria-hidden="true" />
						<span class="sr-only">Delete Control Point {point.ordinal}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>
