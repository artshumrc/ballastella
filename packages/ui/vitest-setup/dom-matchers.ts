// The DOM matchers for this package's component project — `toBeInTheDocument`, `toHaveTextContent`,
// `toHaveValue`, `toHaveAccessibleName`.
//
// Vitest's browser mode registers an equivalent set for you and Node does not. Nothing here mounts a
// component: the whole surface is assertions about an element the test already has.

import '@testing-library/jest-dom/vitest';
