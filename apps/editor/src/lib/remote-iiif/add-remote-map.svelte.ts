import { fetchAnnotationsFromApi } from '@allmaps/stdlib';
import {
	RemoteImageResponseError,
	fetchRemoteImageFile,
	describeRemoteResource,
	findCommunityAlignments,
	imageServiceUriCrossingBoundary,
	measureTileWithImageBitmap,
	probeRemoteImageService,
	readRemoteIiifResource,
	readRemoteImageService,
	type Alignment,
	type CommunityAlignmentOffer,
	type DescribedResource,
	messageOf,
	type FetchFn,
	type MapLayer,
	type RemoteIiifResource,
	type RemoteImageService
} from '@ballastella/core';

import { readItem, writeItem } from '../browser-storage.js';
import { recordingFetch } from '../browser-test-handles.js';
import type { EditorSession } from '../editor-session.svelte.js';

const LOOKUP_KEY = 'ballastella.communityAlignmentLookup';

export class AddRemoteMap {
	readonly #session: () => EditorSession;
	url = $state('');
	step = $state<'idle' | 'reading' | 'choosing' | 'checking' | 'downloading' | 'adding'>('idle');
	error = $state('');
	notice = $state('');
	resource = $state<RemoteIiifResource | null>(null);
	described = $state<DescribedResource | null>(null);
	selectedCanvas = $state('');
	sourceUrl = $state('');
	service = $state<RemoteImageService | null>(null);
	community = $state<CommunityAlignmentOffer | null>(null);
	importIndex = $state(-1);

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	#lookup = $state(readItem('localStorage', LOOKUP_KEY) !== 'off');

	get lookupEnabled(): boolean {
		return this.#lookup;
	}

	set lookupEnabled(next: boolean) {
		this.#lookup = next;
		writeItem('localStorage', LOOKUP_KEY, next ? 'on' : 'off');
	}

	get canvases() {
		return this.described?.canvases ?? [];
	}

	get items() {
		return this.described?.items ?? [];
	}

	#fetch(): FetchFn {
		return recordingFetch(this.#session().imageServiceFetch());
	}

	reset(): void {
		this.url = '';
		this.step = 'idle';
		this.error = '';
		this.resource = null;
		this.described = null;
		this.selectedCanvas = '';
		this.sourceUrl = '';
		this.service = null;
		this.community = null;
		this.importIndex = -1;
	}

	#unchoose(): void {
		this.error = '';
		this.service = null;
		this.community = null;
		this.importIndex = -1;
	}

	async read(url: string = this.url, fromCollection = false): Promise<boolean> {
		this.#unchoose();
		this.notice = '';
		this.selectedCanvas = '';
		this.step = 'reading';

		try {
			const resource = await readRemoteIiifResource(url, { fetch: this.#fetch() });
			this.url = url;
			this.sourceUrl = fromCollection && this.sourceUrl !== '' ? this.sourceUrl : resource.url;
			this.resource = resource;
			this.described = describeRemoteResource(resource.parsed, resource.document);
			this.step = 'choosing';
			if (resource.kind === 'image') {
				await this.select(resource.parsed.uri);
			} else if (this.canvases.length === 1 && this.canvases[0]?.imageService) {
				await this.select(this.canvases[0].imageService);
			}
		} catch (cause) {
			this.step = 'idle';
			this.resource = null;
			this.described = null;
			if (cause instanceof RemoteImageResponseError) return this.#addImageFile(cause.url);
			this.error = messageOf(cause);
		}
		return false;
	}

	async #addImageFile(url: string): Promise<boolean> {
		const session = this.#session();
		if (session.ingest !== null) {
			this.step = 'idle';
			this.error =
				`That address is an image file, which Ballastella copies into this Workspace and tiles ` +
				`here — and “${session.ingestLabel}” is still being prepared. One map is prepared at a ` +
				`time, so wait for that one to finish and look this address up again.`;
			return false;
		}

		this.step = 'downloading';
		try {
			const file = await fetchRemoteImageFile(url, { fetch: this.#fetch() });
			this.reset();
			void session.ingestImage(file);
			return true;
		} catch (cause) {
			this.step = 'idle';
			this.error = messageOf(cause);
			return false;
		}
	}

	async select(selected: unknown): Promise<void> {
		this.#unchoose();
		this.step = 'checking';

		try {
			const uri = imageServiceUriCrossingBoundary(selected);
			this.selectedCanvas = this.canvases.find((canvas) => canvas.imageService === uri)?.uri ?? '';

			const service = await readRemoteImageService(uri, { fetch: this.#fetch() });
			await probeRemoteImageService(service, {
				fetch: this.#fetch(),
				measureTile: measureTileWithImageBitmap
			});
			this.service = service;
			this.step = 'choosing';

			this.community = await findCommunityAlignments({
				enabled: this.lookupEnabled,
				image: service.pane.image,
				imageId: service.imageId,
				fetchAnnotations: fetchAnnotationsFromApi
			});
			this.importIndex =
				this.community.state === 'found' && this.community.alignments.length > 0 ? 0 : -1;
		} catch (cause) {
			this.step = 'choosing';
			this.service = null;
			this.error = messageOf(cause);
		}
	}

	get communityCount(): number {
		return this.community?.state === 'found' ? this.community.alignments.length : 0;
	}

	get chosenAlignment(): Alignment | null {
		if (this.community?.state !== 'found' || this.importIndex < 0) return null;
		return this.community.alignments[this.importIndex]?.alignment ?? null;
	}

	async addSelected(): Promise<MapLayer | null> {
		const service = this.service;
		const described = this.described;
		if (!service || this.step === 'adding') return null;

		this.error = '';
		this.notice = '';
		this.step = 'adding';
		try {
			const canvasLabel = this.canvases.find(
				(canvas) => canvas.imageService === service.uri
			)?.label;
			const added = await this.#session().addReferencedMap({
				service,
				source: this.sourceUrl || described?.uri || service.uri,
				label: canvasLabel || described?.label || '',
				partOf: described?.kind === 'image' ? '' : (described?.uri ?? ''),
				canvas: this.selectedCanvas,
				rights: described?.rights ?? '',
				attribution: described?.attribution?.value ?? '',
				alignment: this.chosenAlignment
			});
			if (added === null) {
				this.error = this.#session().saveError || 'The Layer could not be written.';
				this.step = 'choosing';
				return null;
			}
			this.reset();
			if (added.keptExistingAlignment) this.notice = KEPT_EXISTING_ALIGNMENT;
			return added.layer;
		} catch (cause) {
			this.error = messageOf(cause);
			this.step = 'choosing';
			return null;
		}
	}
}

const KEPT_EXISTING_ALIGNMENT =
	'The Layer was added, but the alignment you chose to import was not written. ' +
	'This Workspace already holds an Alignment for that Map Image, and a Map Image has ' +
	'one Alignment shared by every Project that draws it — importing over it would have discarded ' +
	'the Control Points already in it. The Layer draws the Alignment that was already there.';
