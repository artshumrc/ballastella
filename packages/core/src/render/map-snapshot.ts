const BYTES_PER_PIXEL = 4;
export const mapSnapshotFileName = (directory: string): string => `${directory}.map-snapshot.png`;

interface DrawingBufferRead {
	readonly pixels: Uint8Array;
	readonly width: number;
	readonly height: number;
}

interface SnapshotSource {
	getCanvas(): HTMLCanvasElement;
	once(type: 'render', listener: () => void): unknown;
	triggerRepaint(): void;
}

export function flipPixelRows(
	pixels: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number
): Uint8ClampedArray<ArrayBuffer> {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(
			`A frame of ${width} × ${height} has no dimensions to encode: both have to be whole pixels above zero.`
		);
	}
	const stride = width * BYTES_PER_PIXEL;
	const expected = stride * height;
	if (pixels.length !== expected) {
		throw new Error(
			`A ${width} × ${height} frame is ${expected} bytes, but this read is ${pixels.length}.`
		);
	}
	const flipped = new Uint8ClampedArray(new ArrayBuffer(expected));
	for (let row = 0; row < height; row += 1) {
		flipped.set(pixels.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
	}
	return flipped;
}

export function readDrawingBuffer(canvas: HTMLCanvasElement): DrawingBufferRead {
	const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
	if (gl === null) throw new Error('This canvas has no WebGL context to read a frame from.');
	const width = gl.drawingBufferWidth;
	const height = gl.drawingBufferHeight;
	const pixels = new Uint8Array(width * height * BYTES_PER_PIXEL);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	return { pixels, width, height };
}

export async function encodeSnapshotPng(read: DrawingBufferRead): Promise<Blob> {
	const { width, height } = read;
	const image = new ImageData(flipPixelRows(read.pixels, width, height), width, height);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('This browser gave no 2d context to encode the PNG in.');
	context.putImageData(image, 0, 0);
	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				reject(new Error('The browser produced no PNG for this frame.'));
				return;
			}
			resolve(blob);
		}, 'image/png');
	});
}

// Read inside `render`: the drawing buffer is cleared once the frame is composited.
export async function captureMapFrame(map: SnapshotSource): Promise<Blob> {
	const read = await new Promise<DrawingBufferRead>((resolve, reject) => {
		map.once('render', () => {
			try {
				resolve(readDrawingBuffer(map.getCanvas()));
			} catch (cause) {
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
		map.triggerRepaint();
	});
	return encodeSnapshotPng(read);
}
