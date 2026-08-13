// The DOM matchers for the `editor-dom` project — `toBeInTheDocument`, `toHaveTextContent`,
// `toHaveFocus`, `toHaveAttribute`, `toHaveAccessibleName`.
//
// Vitest's browser mode registers an equivalent set for you and Node does not, so this is the one
// line of setup that move cost. Nothing here mounts a component: the whole surface is assertions
// about an element the test already has.

import '@testing-library/jest-dom/vitest';
