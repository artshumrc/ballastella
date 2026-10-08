export const canonicalServiceUri = (uri: string): string =>
	uri
		.trim()
		.replace(/\/info\.json$/, '')
		.replace(/\/$/, '');
