// The application theme.
//
// ADR-0016 requires that ONE theme signal drives both the UI and the Base Map flavor, because
// a dark interface framing a bright white map is the most obvious way a themed app looks
// unfinished. That rule is easy to state and easy to lose: the way it gets lost is a second
// `'light' | 'dark'` declared next to the map code, agreeing with the first until the day it
// does not. So the type has one home, here, and both the UI and `baseMapStyle` use it.

export type Theme = 'light' | 'dark';

export const THEMES = ['light', 'dark'] as const satisfies readonly Theme[];

export const otherTheme = (theme: Theme): Theme => (theme === 'light' ? 'dark' : 'light');
