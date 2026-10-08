export type GitHubApp = {
	readonly brokerOrigin: string;
	readonly clientId: string;
	readonly appSlug: string;
};

export const GITHUB_APP: GitHubApp = {
	brokerOrigin: 'https://github-broker.darthcrimson.org',
	clientId: 'Iv23liRxexPEW2AKFG12',
	appSlug: 'aws-lambda-broker'
};

export const isGitHubAppConfigured = (app: GitHubApp): boolean =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '' && app.appSlug.trim() !== '';
