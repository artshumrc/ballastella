// Whether a Workspace has Share Links, asked outside a Sync of evidence already in hand (ADR-0045).

import { describe, expect, it } from 'vitest';

import {
	PUBLISHED_SITE_RECORD_NAME,
	carriesPublishedSite,
	observedShareLinks
} from './viewer-files.js';

describe('a tree carrying a Published Site', () => {
	it('is the site record and nothing else', () => {
		expect(carriesPublishedSite([PUBLISHED_SITE_RECORD_NAME])).toBe(true);
		expect(
			carriesPublishedSite(['_app/immutable/entry/start.js', '.nojekyll', 'base-map/0/0/0.png'])
		).toBe(false);
	});
});

describe('the answer a surface gives outside a Sync', () => {
	it('is yes where this Workspace carries the site', () => {
		expect(observedShareLinks({ workspace: true, remote: false, withdrawing: false })).toBe(true);
	});

	// The failure this rule exists for: a get brings the source namespace only, so the machine that
	// got the Workspace holds no viewer files while the Remote it got them from serves a site.
	it('is yes where only the Remote was seen to carry it', () => {
		expect(observedShareLinks({ workspace: false, remote: true, withdrawing: false })).toBe(true);
	});

	it('is no where neither side carries it', () => {
		expect(observedShareLinks({ workspace: false, remote: false, withdrawing: false })).toBe(false);
	});

	// The Remote's copy goes on the next Sync, so between the asking and that Sync the Remote still
	// carries the viewer set — and only the recorded request tells that apart from a fresh get.
	it('is no while the author has asked for the site to come down', () => {
		expect(observedShareLinks({ workspace: false, remote: true, withdrawing: true })).toBe(false);
		expect(observedShareLinks({ workspace: true, remote: true, withdrawing: true })).toBe(false);
	});
});
