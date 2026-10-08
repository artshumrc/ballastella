import type { MapImageSource } from '@ballastella/core';

export function mapImageSourceOf(
	lookUp: (imageId: string) => MapImageSource,
	imageId: () => string
): { readonly current: MapImageSource } {
	const service = $derived.by(() => {
		const found = lookUp(imageId());
		return found.imageMode === 'referenced' ? found.service : '';
	});

	const current = $derived<MapImageSource>(
		service === ''
			? { imageMode: 'offline-copy', imageId: imageId() }
			: { imageMode: 'referenced', imageId: imageId(), service }
	);

	return {
		get current() {
			return current;
		}
	};
}
