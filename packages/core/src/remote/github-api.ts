// The two GitHub hosts this epic talks to.
//
// A leaf of their own rather than constants inside `fake-github.ts`, because the publish engine
// needs the API origin and a fixture must never be something production code imports.

/** GitHub's data plane. It answers `access-control-allow-origin: *`, which is why ADR-0031 holds. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** Where a public repository's bytes are read from, unauthenticated, by Clone and Review. */
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';
