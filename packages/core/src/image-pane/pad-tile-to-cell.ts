// Chromium rounds a fractional drawImage destination, so stage at a 2^n multiple and blit down.
const MAX_SUPERSAMPLE = 8;
const EDGE = 1;

function supersampleFor(extent: number): number {
	let multiple = 1;
	while (multiple < MAX_SUPERSAMPLE && !Number.isInteger(extent * multiple)) multiple *= 2;
	return multiple;
}

function context2dOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('No 2d context on an OffscreenCanvas — cannot place ragged edge tiles.');
	}
	context.imageSmoothingQuality = 'high';
	return context;
}

export async function padTileToCell(
	body: Blob,
	placement: { width: number; height: number },
	tileSize: number
): Promise<ImageBitmap> {
	const served = await createImageBitmap(body);

	try {
		const multiple = {
			x: supersampleFor(placement.width),
			y: supersampleFor(placement.height)
		};

		const cell = {
			width: Math.min(tileSize, Math.ceil(placement.width) + EDGE),
			height: Math.min(tileSize, Math.ceil(placement.height) + EDGE)
		};

		const stage = context2dOf(
			new OffscreenCanvas(cell.width * multiple.x, cell.height * multiple.y)
		);
		const staged = { width: placement.width * multiple.x, height: placement.height * multiple.y };

		stage.drawImage(served, 0, 0, staged.width, staged.height);

		// Linear filtering blends the edge with transparent black; a replicated edge pixel stops it darkening.
		if (placement.width < tileSize) {
			stage.drawImage(
				served,
				served.width - 1,
				0,
				1,
				served.height,
				staged.width,
				0,
				EDGE * multiple.x,
				staged.height
			);
		}

		if (placement.height < tileSize) {
			stage.drawImage(
				served,
				0,
				served.height - 1,
				served.width,
				1,
				0,
				staged.height,
				staged.width + EDGE * multiple.x,
				EDGE * multiple.y
			);
		}

		const canvas = new OffscreenCanvas(tileSize, tileSize);
		context2dOf(canvas).drawImage(stage.canvas, 0, 0, cell.width, cell.height);

		return canvas.transferToImageBitmap();
	} finally {
		served.close();
	}
}
