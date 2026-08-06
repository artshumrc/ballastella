// How big is this image, without decoding it?
//
// The tiler has to answer that before it does anything else, because the answer is what
// decides which tiler runs (ADR-0003): a scan above the `createImageBitmap` decode ceiling
// must never be handed to `createImageBitmap`, and there is no way to ask that API for an
// image's dimensions without asking it to decode the whole thing first — which is the exact
// allocation the routing exists to avoid.
//
// So the dimensions come out of the container's header. Every format here states its size in
// the first few dozen bytes, and reading them costs nothing.
//
// TIFF is included even though no browser can decode one, because an uncompressed or LZW TIFF
// is what a library hands a scholar when they ask for the archival master (SPEC story 22).
// libvips reads it, so the streaming path can tile it; what would otherwise happen is that the
// format falls through to the decode path, `createImageBitmap` refuses it, and the user is told
// their file is broken.

/** The intrinsic pixel size of an image file, and the container it was read from. */
export type ImageHeader = {
	readonly width: number;
	readonly height: number;
	readonly format: 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'tiff';
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * The size declared in `bytes`' header, or `undefined` for a container this does not know.
 *
 * `undefined` is a normal answer, not a failure: the caller falls back to decoding, which is
 * the right thing for a format a browser supports and this does not (AVIF, JPEG XL, an SVG).
 * What it must not do is guess, because a guess that comes in under the decode ceiling is a
 * tab that dies rather than an image that is rejected.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// PNG: signature, then IHDR's width and height as the first two big-endian uint32s.
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

	// BMP: a BITMAPINFOHEADER or later. Height is signed — a negative value means the rows are
	// stored top-down, and the image is still that many pixels tall.
	if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM' && view.getUint32(14, true) >= 40) {
		return {
			width: Math.abs(view.getInt32(18, true)),
			height: Math.abs(view.getInt32(22, true)),
			format: 'bmp'
		};
	}

	if (bytes.length >= 8) {
		const little = ascii(bytes, 0, 2) === 'II' && view.getUint16(2, true) === 42;
		const big = ascii(bytes, 0, 2) === 'MM' && view.getUint16(2, false) === 42;
		if (little || big) return readTiffHeader(view, little);
	}

	return undefined;
}

/**
 * JPEG: walk the marker segments to the frame header, which is the only place the size is.
 *
 * Deliberately not "read a fixed offset". A JPEG out of a scanner opens with an EXIF or ICC
 * segment tens of kilobytes long, and the frame header can be any of the eight `SOF` markers —
 * a large scan is quite often progressive (`SOF2`) rather than baseline.
 */
function readJpegHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
	let offset = 2;

	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) {
			// Fill bytes between segments are legal; anything else means this is not parseable.
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1] as number;
		// Standalone markers carry no length.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined; // end of image, or scan data
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

/** WebP: three sub-formats, each stating the size in a different place. */
function readWebpHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
	const chunk = ascii(bytes, 12, 4);

	if (chunk === 'VP8X') {
		// Canvas size, 24-bit little-endian, stored minus one.
		const width = (view.getUint16(24, true) | (bytes[26]! << 16)) + 1;
		const height = (view.getUint16(27, true) | (bytes[29]! << 16)) + 1;
		return { width, height, format: 'webp' };
	}

	if (chunk === 'VP8 ') {
		// A VP8 key frame: 3-byte tag, 3-byte start code, then 14-bit width and height.
		return {
			width: view.getUint16(26, true) & 0x3fff,
			height: view.getUint16(28, true) & 0x3fff,
			format: 'webp'
		};
	}

	if (chunk === 'VP8L') {
		// 14-bit width and height, stored minus one, packed into the bits after the 0x2f signature.
		const bits = view.getUint32(21, true);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
			format: 'webp'
		};
	}

	return undefined;
}

/** TIFF: the first IFD's `ImageWidth` (256) and `ImageLength` (257) tags. */
function readTiffHeader(view: DataView, little: boolean): ImageHeader | undefined {
	const ifd = view.getUint32(4, little);
	if (ifd + 2 > view.byteLength) return undefined;
	const entries = view.getUint16(ifd, little);

	let width: number | undefined;
	let height: number | undefined;

	for (let index = 0; index < entries; index++) {
		const entry = ifd + 2 + index * 12;
		if (entry + 12 > view.byteLength) return undefined;
		const tag = view.getUint16(entry, little);
		if (tag !== 256 && tag !== 257) continue;
		// Type 3 is SHORT and type 4 is LONG; a scan wider than 65535 pixels needs the latter, and
		// those are exactly the images this whole slice is about.
		const type = view.getUint16(entry + 2, little);
		const value =
			type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
		if (tag === 256) width = value;
		else height = value;
	}

	if (width === undefined || height === undefined) return undefined;
	return { width, height, format: 'tiff' };
}
