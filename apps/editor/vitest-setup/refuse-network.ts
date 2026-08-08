// The editor's Node unit project joins the same fence every other suite is behind (ticket 06).
//
// **One implementation, imported, and not a fourth copy.** `packages/core/vitest-setup/refuse-network.ts`
// is the fence and its own header is where the rule and its two limits are written down; core now
// exports it as `@ballastella/core/test-fence` so a new vitest project costs a `setupFiles` line
// rather than 250 duplicated ones. The one deliberate copy in this repository is
// `e2e/support/network-fence.ts`, and that one is explained at its site: the workspace tsconfig
// covers only `e2e/`, so the browser suite genuinely cannot reach into a package.
//
// Importing it for its side effect is the whole of installing it: the module wraps `fetch`,
// `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` and `node:http`/`node:https`
// at import time, and honours `BALLASTELLA_NETWORK_TESTS=1` for the one deliberate live check.
import '@ballastella/core/test-fence';

export { refusedNetworkMessage } from '@ballastella/core/test-fence';
