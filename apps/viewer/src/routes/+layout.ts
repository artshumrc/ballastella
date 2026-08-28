// Keeps the workspace edge to @ballastella/core exercised by `pnpm -r build` and `pnpm check`;
// `lib/site-files.ts` is the app's real consumer of it, through `createHttpProjectStore`.
import '@ballastella/core';

// ADR-0006: the published site is a directory of static files served by any web server,
// or none. Everything prerenders.
export const prerender = true;
