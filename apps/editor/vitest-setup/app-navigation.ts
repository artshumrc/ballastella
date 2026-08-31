// SvelteKit's `$app/navigation`, for the `editor-dom` project, which does not run under SvelteKit.
//
// SvelteKit generates this module at build time; `ProjectHub` reaches it to open a Project from its
// row. Navigation itself is not reproduced here — jsdom has nowhere to go — so a component test may
// assert that the control exists and is named, and nothing about where it lands. Where a Project row
// actually takes the user is `e2e/`'s claim, against a real router.
export const goto = async (): Promise<void> => undefined;
