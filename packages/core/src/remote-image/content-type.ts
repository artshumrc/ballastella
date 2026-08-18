/**
 * Whether a `content-type` names an image file.
 *
 * Its own module because both sides of the plain-image path ask it: the IIIF reader, to recognise
 * that a pasted address is an image rather than a description, and the download itself. Keeping it
 * beside either one would make the two modules import each other in a circle.
 *
 * **A response's declared type and nothing else.** Sniffing the first bytes would catch a host that
 * serves a JPEG as `application/octet-stream`, and it would mean reading the body of every document
 * that was supposed to be JSON before deciding what it was. A host that misdeclares its images is
 * refused with "that is not JSON" — a worse message than it could be, and still a refusal rather
 * than a wrong map.
 */
export const isImageContentType = (contentType: string): boolean =>
	/^\s*image\//i.test(contentType);
