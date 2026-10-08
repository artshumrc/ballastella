import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	renderedAnnotationLayers,
	waitForPaintedAnnotations,
	ZUIDERZEE_GEOJSON
} from './support/annotations.js';
import { asJson } from './support/published-site.js';
import { writeStoredFiles } from './support/stored-file.js';
import {
	backUpWorkspace,
	closeWorkspaceDialog,
	createFolderWorkspace,
	downloadedBytes,
	editWorkspace,
	expectNoRemote,
	expectRemoteNamed,
	expectWorkspaceNamed,
	installFolderPicker,
	readRemoteRelationship,
	restoreBackup,
	restoreFrom,
	seedRemoteRelationship,
	emptyBrowserStorage,
	everyPathInBrowserStorage,
	unpackDownload,
	HUB
} from './support/workspace.js';

const projectJson = (name: string, withLabel = false): string =>
	asJson({
		formatVersion: 1,
		name,
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				name: 'The 1625 plan',
				visible: true,
				order: 0,
				kind: 'map',
				opacity: 0.8,
				imageId: 'amsterdam-1625'
			},
			...(withLabel
				? [
						{
							id: 'l2',
							name: 'Names on the water',
							visible: true,
							order: 1,
							kind: 'annotation',
							geojsonRef: 'annotations/warehouses.geojson'
						}
					]
				: [])
		],
		baseMap: null
	});

const workspaceFiles = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson('Amsterdam 1625', true),
	'amsterdam-1625/annotations/warehouses.geojson': ZUIDERZEE_GEOJSON,
	'the-canal-ring/project.json': projectJson('The Canal Ring'),
	'the-canal-ring/annotations/bridges.geojson': '{"type":"FeatureCollection","features":[]}',
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	'index.html': '<!doctype html><title>a stale site</title>',
	'ballastella-site.json': '{"projects":[]}',
	'_app/immutable/chunks/abc123.js': 'export{}'
});

const expectOnlyTheWork = (paths: string[], workspace: string) => {
	const at = (path: string) => `${workspace}/${path}`;
	for (const path of [
		'amsterdam-1625/project.json',
		'the-canal-ring/project.json',
		'alignments/amsterdam-1625.json'
	]) {
		expect(paths).toContain(at(path));
	}
	expect(paths.filter((path) => path.startsWith(at('images/amsterdam-1625/')))).toHaveLength(2);
	expect(paths).not.toContain(at('index.html'));
	expect(paths).not.toContain(at('ballastella-site.json'));
	expect(paths.filter((path) => path.startsWith(at('_app/')))).toEqual([]);
};

const expectNoWorkspaceAdded = async (page: Page) => {
	await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
	const roots = new Set((await everyPathInBrowserStorage(page)).map((path) => path.split('/')[0]));
	expect([...roots]).toEqual([DEFAULT_WORKSPACE]);
};

test.describe('backing up and restoring a Workspace', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await writeStoredFiles(page, workspaceFiles(), DEFAULT_WORKSPACE);
		await page.reload();
	});

	test('backs up the work and not the site, then restores it as a new unbound Workspace that draws', async ({
		page
	}) => {
		await seedRemoteRelationship(page, { owner: 'ada', repository: 'atlas' });
		await page.reload();
		await expectRemoteNamed(page, 'ada/atlas');

		const download = await backUpWorkspace(page);
		expect(download.suggestedFilename()).toBe(`${DEFAULT_WORKSPACE}.tar`);
		const names = (await unpackDownload(download)).map((entry) => entry.header.name);
		expect(names[0]).toBe(`${DEFAULT_WORKSPACE}/`);
		expectOnlyTheWork(names, DEFAULT_WORKSPACE);
		await expect(page.getByTestId('transfer-outcome')).toContainText(`${DEFAULT_WORKSPACE}.tar`);

		await restoreBackup(page, await downloadedBytes(download));
		await expect(page.getByTestId('transfer-outcome')).toContainText('not been touched');

		const restoredName = `${DEFAULT_WORKSPACE} (2)`;
		await expectWorkspaceNamed(page, restoredName);
		const paths = await everyPathInBrowserStorage(page);
		for (const path of Object.keys(workspaceFiles())) {
			expect(paths).toContain(`${DEFAULT_WORKSPACE}/${path}`);
		}
		expectOnlyTheWork(paths, restoredName);
		expect(await readRemoteRelationship(page, restoredName)).toBeNull();
		await expectNoRemote(page);
		await expect(page.getByRole('heading', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'The Canal Ring' })).toBeVisible();

		await closeWorkspaceDialog(page);
		await routeBaseMapArchive(page);
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForPaintedAnnotations(page, ['label']);
		expect(await renderedAnnotationLayers(page)).toMatchObject({
			label: ['ballastella-layer-l2-label']
		});
	});

	test('refuses a file that is not a backup, and one from a newer version, creating no Workspace', async ({
		page
	}) => {
		const backup = await downloadedBytes(backUpWorkspace(page));
		await closeWorkspaceDialog(page);

		await editWorkspace(page, DEFAULT_WORKSPACE);
		await page.getByTestId('restore-file').setInputFiles({
			name: 'holiday.jpg',
			mimeType: 'image/jpeg',
			buffer: Buffer.from('this is a photograph, not a Workspace')
		});
		const problem = page.getByTestId('transfer-problem');
		await expect(problem).toBeVisible();
		await expect(problem).toContainText('Nothing has been restored');
		await expectNoWorkspaceAdded(page);

		const tampered = Buffer.from(
			backup
				.toString('latin1')
				.replace('"formatVersion": 1', '"formatVersion":99')
				.padEnd(backup.length, '\0'),
			'latin1'
		);
		await restoreFrom(page, tampered, 'from-the-future.tar');
		await expect(problem).toContainText('newer version', { timeout: 30_000 });
		await expect(problem).toContainText('ballastella');
		await expect(problem).toContainText('Nothing has been restored');
		await expectNoWorkspaceAdded(page);
	});
});

test('backing up a folder Workspace produces an archive that restores', async ({ page }) => {
	const FOLDER = "Dave's maps, 1625";
	const LEGAL = 'Dave s maps 1625';
	await installFolderPicker(page, FOLDER);
	await page.goto(HUB);
	await emptyBrowserStorage(page, { dropDatabase: true });
	await page.reload();
	await writeStoredFiles(page, workspaceFiles(), FOLDER);
	await createFolderWorkspace(page, FOLDER);

	const download = await backUpWorkspace(page);
	expect(download.suggestedFilename()).toBe(`${LEGAL}.tar`);
	const entries = await unpackDownload(download);
	expect(entries[0]?.header.name).toBe(`${LEGAL}/`);
	expect(entries[0]?.header.pax?.['BALLASTELLA.workspace']).toBe(FOLDER);
	expect(entries.every((entry) => entry.header.name.startsWith(`${LEGAL}/`))).toBe(true);
	await expect(page.getByTestId('transfer-outcome')).toContainText(LEGAL);

	await restoreBackup(page, await downloadedBytes(download), `${LEGAL}.tar`);

	await expectWorkspaceNamed(page, LEGAL);
	const paths = await everyPathInBrowserStorage(page);
	expect(paths).toContain(`${LEGAL}/amsterdam-1625/project.json`);
	expect(paths).toContain(`${LEGAL}/the-canal-ring/project.json`);
	for (const path of Object.keys(workspaceFiles())) {
		expect(paths).toContain(`${FOLDER}/${path}`);
	}
	await expect(page.getByRole('heading', { name: 'Amsterdam 1625' })).toBeVisible();
});
