// The e2e port pair, shared by `playwright.config.ts` (which binds it) and `scripts/e2e.mjs` (which
// frees it). One copy, because a runner and a server disagreeing about the port under test is the
// exact failure the derivation exists to prevent.

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * A stable port pair in the IANA ephemeral-safe range 20000–39998, unique per checkout path.
 *
 * Derived rather than fixed so parallel checkouts cannot collide, and stable rather than random so a
 * debugger, a proxy, or a CI log can name it. `BALLASTELLA_E2E_PORT` overrides it.
 */
export const basePort = (() => {
	const override = Number(process.env.BALLASTELLA_E2E_PORT);
	if (Number.isInteger(override) && override > 1023 && override < 65535) return override;
	const digest = createHash('sha256').update(repoRoot).digest();
	// Even, so `basePort + 1` cannot collide with a neighbouring checkout's `basePort`.
	return 20000 + (digest.readUInt32BE(0) % 10000) * 2;
})();

export const editorPort = basePort;
export const viewerPort = basePort + 1;
