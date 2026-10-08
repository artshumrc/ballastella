import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const basePort = (() => {
	const override = Number(process.env.BALLASTELLA_E2E_PORT);
	if (Number.isInteger(override) && override > 1023 && override < 65535) return override;
	const digest = createHash('sha256').update(repoRoot).digest();
	return 20000 + (digest.readUInt32BE(0) % 10000) * 2;
})();

export const editorPort = basePort;
export const viewerPort = basePort + 1;
