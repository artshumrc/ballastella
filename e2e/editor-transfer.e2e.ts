import {
	hashesUnder,
	waitForOpeningView,
	waitForPaintedAnnotations,
	waitForStack,
	ZUIDERZEE_GEOJSON
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openProjectSettings } from './support/project-screen.js';
import { asJson } from './support/published-site.js';
import { writeStoredFiles } from './support/stored-file.js';
import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';
import {
	createWorkspace,
	backUpWorkspace,
	closeWorkspaceDialog,
	everyByteOf,
	openWorkspaceMenu,
	switchToWorkspace,
	emptyWorkspace,
	unpackDownload
} from './support/workspace.js';

async function emptyEverything(page: Page): Promise<void> {
	await emptyWorkspace(page);
	await page.evaluate(() => {
		localStorage.removeItem('ballastella.workspace');
		localStorage.removeItem('ballastella.own-workspace');
		localStorage.removeItem('ballastella.own-folder');
	});
}

const shared = (path: string) => path.startsWith('images/') || path.startsWith('alignments/');
const inProject = (directory: string, path: string) =>
	shared(path) ? path : `${directory}/${path}`;

const seedProject = (page: Page, directory: string, files: Record<string, string>) =>
	writeStoredFiles(
		page,
		Object.fromEntries(
			Object.entries(files).map(([path, text]) => [inProject(directory, path), text])
		)
	);

const WAREHOUSES_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			id: '11111111-1111-4111-8111-111111111111',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				title: 'The west quay',
				description: 'Bonded warehouses, still standing in 1625.',
				'marker-size': 'large',
				'marker-color': '#cc0000'
			}
		}
	]
});

const IMPORT_PROVENANCE = [
	{
		kind: 'github',
		owner: 'ada',
		repository: 'atlas',
		branch: 'main',
		directory: 'amsterdam-1625',
		commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
		observedAt: '2026-08-01T10:00:00.000Z',
		evidence: 'inherited'
	},
	{
		kind: 'project-bundle',
		filename: 'amsterdam-1625.project.tar',
		projectName: 'Amsterdam 1625',
		observedAt: '2026-08-22T09:30:00.000Z',
		evidence: 'observed'
	}
];

const projectJson = (overrides: Record<string, unknown> = {}) =>
	asJson({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				kind: 'annotation',
				name: 'Warehouses',
				visible: true,
				order: 0,
				geojsonRef: 'annotations/warehouses.geojson',
				defaultStyle: {}
			},
			{
				id: 'l2',
				kind: 'map',
				name: 'The 1625 plan',
				visible: true,
				order: 1,
				opacity: 1,
				imageId: 'amsterdam-1625'
			}
		],
		baseMap: null,
		...overrides
	});

const projectFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
	'project.json': projectJson(),
	'annotations/warehouses.geojson': WAREHOUSES_GEOJSON,
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...overrides
});

const transferStatus = (page: Page) => page.locator('[data-transfer]');

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyEverything(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

async function exportProject(page: Page, project: string) {
	await page.getByRole('button', { name: `Edit ${project}` }).click();
	const download = page.waitForEvent('download');
	await page
		.getByRole('dialog', { name: 'Edit Project' })
		.getByRole('button', { name: 'Export Project' })
		.click();
	return download;
}

const textOf = (entries: Awaited<ReturnType<typeof unpackDownload>>, name: string) =>
	new TextDecoder().decode(entries.find((entry) => entry.header.name === name)!.data!);

test.describe('exporting a Project as a bundle', () => {
	test('downloads a tar of only that Project, named for its folder, and announces it', async ({
		page
	}) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await seedProject(page, 'the-canal-ring', {
			'project.json': projectJson({ name: 'The Canal Ring', layers: [] }),
			'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
			'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
		});
		await page.reload();

		const saved = await exportProject(page, 'Amsterdam 1625');
		expect(saved.suggestedFilename()).toBe('amsterdam-1625.project.tar');
		const entries = await unpackDownload(saved);
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			Object.keys(projectFiles()).sort()
		);
		expect(textOf(entries, 'project.json')).toBe(projectJson());
		await expect(transferStatus(page)).toHaveText(/Exported Amsterdam 1625: 5 files\./);
	});

	test('exports a Project this build refuses to open (ADR-0010)', async ({ page }) => {
		await seedProject(page, 'from-the-future', {
			'project.json': '{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		});
		await page.reload();
		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();

		const entries = await unpackDownload(exportProject(page, 'from-the-future'));

		expect(textOf(entries, 'project.json')).toBe(
			'{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		);
	});

	test('says so when an export fails, rather than blanking the status line', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		await page.evaluate(async () => {
			const root = await workspaceRoot();
			await root.removeEntry('amsterdam-1625', { recursive: true });
		});
		await page.getByRole('button', { name: 'Edit Amsterdam 1625' }).click();
		await page
			.getByRole('dialog', { name: 'Edit Project' })
			.getByRole('button', { name: 'Export Project' })
			.click();
		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('project.json');
	});
});

test.describe('merely opening a Project leaves its files unchanged', () => {
	test('merely opening a Project with a Label leaves every Project file hash-identical', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await seedProject(
			page,
			'amsterdam-1625',
			projectFiles({
				'annotations/warehouses.geojson': ZUIDERZEE_GEOJSON,
				'project.json': projectJson({ importProvenance: IMPORT_PROVENANCE })
			})
		);
		await page.reload();
		const before = await hashesUnder(page, '');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForOpeningView(page);
		await waitForStack(page);
		await waitForPaintedAnnotations(page, ['label']);

		const settings = await openProjectSettings(page);
		const history = settings.getByTestId('import-provenance');
		await expect(history).toContainText('read-only record of the transfers');
		await expect(history).toContainText('does not say who made the work');

		const entries = history.getByTestId('provenance-entry');
		await expect(entries).toHaveCount(2);
		await expect(entries.nth(0)).toHaveAttribute('data-provenance-evidence', 'inherited');
		await expect(entries.nth(0)).toContainText('ada/atlas');
		await expect(entries.nth(0)).toContainText('9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312');
		await expect(entries.nth(0)).toContainText('not checked here');
		await expect(entries.nth(1)).toHaveAttribute('data-provenance-evidence', 'observed');
		await expect(entries.nth(1)).toContainText('amsterdam-1625.project.tar');
		await expect(entries.nth(1)).toContainText('Seen by Ballastella');
		await expect(history.getByRole('textbox')).toHaveCount(0);
		await expect(history.getByRole('button')).toHaveCount(0);
		await expect(settings.getByTestId('project-name-input')).toBeVisible();

		await page.waitForTimeout(600);

		expect(await hashesUnder(page, '')).toEqual(before);
	});
});

test.describe('an Import that did not finish', () => {
	const OWN = {
		'project.json': projectJson({ name: 'My own Amsterdam', layers: [] }),
		'annotations/quays.geojson': WAREHOUSES_GEOJSON,
		'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
		'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
	};

	const PROVISIONAL: Record<string, string> = {
		'project.json': projectJson({ name: 'Boston 1775', layers: [] }),
		'annotations/wharves.geojson': WAREHOUSES_GEOJSON,
		'images/img-imported/info.json': '{"width":1024,"height":1024}',
		'alignments/img-imported.json': '{"type":"Annotation","id":"img-imported"}'
	};

	const PROVISIONAL_PATHS = [
		'alignments/img-imported.json',
		'boston-1775/annotations/wharves.geojson',
		'boston-1775/project.json',
		'images/img-imported/info.json'
	];

	const plantMarker = (page: Page, marker: string) =>
		writeStoredFiles(page, { 'import.json': marker });

	const markerFor = (state: 'writing' | 'committed') =>
		JSON.stringify({
			formatVersion: 1,
			transaction: 'e2e-import',
			state,
			project: 'boston-1775/project.json',
			paths: PROVISIONAL_PATHS,
			startedAt: '2026-08-22T10:00:00.000Z'
		});

	const plantProvisional = (page: Page) => seedProject(page, 'boston-1775', PROVISIONAL);

	test('is swept, finished, or keeps the Workspace shut — before anything can list it', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', OWN);

		await plantProvisional(page);
		await plantMarker(page, markerFor('writing'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		const entries = await unpackDownload(backUpWorkspace(page));
		await closeWorkspaceDialog(page);
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			[
				`${DEFAULT_WORKSPACE}/`,
				...Object.keys(OWN).map(
					(path) => `${DEFAULT_WORKSPACE}/${inProject('my-own-amsterdam', path)}`
				)
			].sort()
		);
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual(
			Object.fromEntries(
				Object.entries(OWN).map(([path, text]) => [inProject('my-own-amsterdam', path), text])
			)
		);

		await createWorkspace(page, 'Elsewhere');
		await openWorkspaceMenu(page);
		await page.getByRole('button', { name: `Delete ${DEFAULT_WORKSPACE}` }).click();
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			`It holds ${Object.keys(OWN).length} files,`
		);
		await page.getByRole('button', { name: 'Keep it' }).click();
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await plantProvisional(page);
		await plantMarker(page, markerFor('committed'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByTestId('map-image')).toHaveCount(2);
		expect(Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE))).not.toContain('import.json');

		await plantMarker(page, 'half a jso');
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		await expect(page.getByTestId('connect-to-github')).toHaveCount(0);
		await expect(page.getByTestId('back-up-workspace')).toHaveCount(0);
		await expect(page.getByTestId('unrecovered-import')).not.toContainText('import.json');
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toMatchObject({
			'import.json': 'half a jso'
		});
	});
});
