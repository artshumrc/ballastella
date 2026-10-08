/** Way back to Ballastella for the nav bar. Module singleton: bar sits outside page context. Null is ordinary (folder publish, no editor recorded). */
type ReturnLink = {
	/** Absolute address on another origin. */
	readonly href: string;
	readonly label: string;
};

class ReturnLinkSlot {
	current = $state.raw<ReturnLink | null>(null);
}

export const returnLink = new ReturnLinkSlot();
