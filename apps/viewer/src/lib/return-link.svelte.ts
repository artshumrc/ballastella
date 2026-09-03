/**
 * The way back to Ballastella that the current screen offers, for the site's navigation bar.
 *
 * The bar is mounted in the layout, outside `children()`, so a context provided by the page is not in
 * scope for it — the same reason the shared page-chrome slot is a module singleton and not a context.
 * The page is where the record these links are built from is read (`ballastella-site.json`), and
 * reading it a second time in the layout would cost every Reader an extra round trip to say the same
 * thing.
 *
 * `null` is the ordinary state, not a failure: a site that records no editor, and a site sent to
 * a folder rather than to a Remote, both have nothing to link to.
 */
export type ReturnLink = {
	/** An **absolute** address, on another origin entirely (ADR-0045). */
	readonly href: string;
	readonly label: string;
};

class ReturnLinkSlot {
	current = $state.raw<ReturnLink | null>(null);
}

export const returnLink = new ReturnLinkSlot();
