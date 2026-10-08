type ImageHeader = {
	readonly width: number;
	readonly height: number;
	readonly format: 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'tiff';
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 &&
		ascii(bytes, 1, 3) === 'PNG' &&
		ascii(bytes, 12, 4) === 'IHDR'
	) {
		return { width: view.getUint32(16), height: view.getUint32(20), format: 'png' };
	}

	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return readJpegHeader(bytes, view);
	}

	if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return readWebpHeader(bytes, view);
	}

	if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
		return { width: view.getUint16(6, true), height: view.getUint16(8, true), format: 'gif' };
	}

	if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM' && view.getUint32(14, true) >= 40) {
		return {
			width: Math.abs(view.getInt32(18, true)),
			height: Math.abs(view.getInt32(22, true)),
			format: 'bmp'
		};
	}

	const tiff = tiffByteOrder(bytes, view);
	if (tiff !== undefined) return readTiffHeader(view, tiff, view.getUint32(4, tiff));

	return undefined;
}

export const IMAGE_HEADER_BYTES = 64 * 1024;

export async function readImageHeaderFromBlob(file: Blob): Promise<ImageHeader | undefined> {
	const head = new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
	const direct = readImageHeader(head);
	if (direct) return direct;
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const little = tiffByteOrder(head, view);
	if (little === undefined) return undefined;
	const ifd = view.getUint32(4, little);
	if (ifd < head.byteLength) return undefined;
	const tail = new Uint8Array(await file.slice(ifd, ifd + IMAGE_HEADER_BYTES).arrayBuffer());
	if (tail.byteLength < 2) return undefined;

	return readTiffHeader(new DataView(tail.buffer, tail.byteOffset, tail.byteLength), little, 0);
}

function tiffByteOrder(bytes: Uint8Array, view: DataView): boolean | undefined {
	if (bytes.length < 8) return undefined;
	if (ascii(bytes, 0, 2) === 'II' && view.getUint16(2, true) === 42) return true;
	if (ascii(bytes, 0, 2) === 'MM' && view.getUint16(2, false) === 42) return false;
	return undefined;
}

function readJpegHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
	let offset = 2;

	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1] as number;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		const length = view.getUint16(offset + 2);
		const isFrameHeader =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrameHeader) {
			if (offset + 9 > bytes.length) return undefined;
			return {
				height: view.getUint16(offset + 5),
				width: view.getUint16(offset + 7),
				format: 'jpeg'
			};
		}
		if (length < 2) return undefined;
		offset += 2 + length;
	}

	return undefined;
}

function readWebpHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
	const chunk = ascii(bytes, 12, 4);

	if (chunk === 'VP8X') {
		const width = (view.getUint16(24, true) | (bytes[26]! << 16)) + 1;
		const height = (view.getUint16(27, true) | (bytes[29]! << 16)) + 1;
		return { width, height, format: 'webp' };
	}

	if (chunk === 'VP8 ') {
		return {
			width: view.getUint16(26, true) & 0x3fff,
			height: view.getUint16(28, true) & 0x3fff,
			format: 'webp'
		};
	}

	if (chunk === 'VP8L') {
		const bits = view.getUint32(21, true);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
			format: 'webp'
		};
	}

	return undefined;
}

function readTiffHeader(view: DataView, little: boolean, ifd: number): ImageHeader | undefined {
	if (ifd + 2 > view.byteLength) return undefined;
	const entries = view.getUint16(ifd, little);
	let width: number | undefined;
	let height: number | undefined;

	for (let index = 0; index < entries; index++) {
		const entry = ifd + 2 + index * 12;
		if (entry + 12 > view.byteLength) return undefined;
		const tag = view.getUint16(entry, little);
		if (tag !== 256 && tag !== 257) continue;
		const type = view.getUint16(entry + 2, little);
		const value =
			type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
		if (tag === 256) width = value;
		else height = value;
	}

	if (width === undefined || height === undefined) return undefined;
	return { width, height, format: 'tiff' };
}
