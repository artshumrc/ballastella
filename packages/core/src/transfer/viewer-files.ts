export const PUBLISHED_SITE_RECORD_NAME = 'ballastella-site.json';
export const PUBLISHED_APP_DIRECTORY = '_app/';
export const JEKYLL_OFF_MARKER = '.nojekyll';

export const VIEWER_FILE_PATHS: readonly string[] = [
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	JEKYLL_OFF_MARKER,
	'base-map/',
	'index.html',
	'robots.txt'
];

export const isViewerFile = (relativePath: string): boolean =>
	VIEWER_FILE_PATHS.some((path) =>
		path.endsWith('/') ? relativePath.startsWith(path) : relativePath === path
	);

export const claimedByPublishedSite = (name: string): boolean =>
	VIEWER_FILE_PATHS.some((path) => (path.endsWith('/') ? path.slice(0, -1) : path) === name);

export const carriesPublishedSite = (paths: Iterable<string>): boolean => {
	for (const path of paths) if (path === PUBLISHED_SITE_RECORD_NAME) return true;
	return false;
};

interface ShareLinksEvidence {
	readonly workspace: boolean;
	readonly remote: boolean;
	readonly withdrawing: boolean;
}

export const observedShareLinks = (evidence: ShareLinksEvidence): boolean =>
	!evidence.withdrawing && (evidence.workspace || evidence.remote);
