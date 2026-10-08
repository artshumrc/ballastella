export type WayBack = {
	readonly label: string;
	readonly project: string;
	readonly testid?: string;
};

export type Breadcrumb = {
	readonly label: string;
	readonly destination?: { readonly project?: string };
	readonly testid?: string;
	readonly action?: {
		readonly label: string;
		readonly testid?: string;
		readonly onClick: () => void;
	};
};

class PageChrome {
	#owner = '';
	heading = $state('');
	back = $state.raw<WayBack | null>(null);
	breadcrumbs = $state.raw<readonly Breadcrumb[]>([]);

	show(heading: string, back: WayBack | null = null): void {
		this.#owner = heading;
		this.heading = heading;
		this.back = back;
		this.breadcrumbs = [];
	}

	showBreadcrumbs(owner: string, breadcrumbs: readonly Breadcrumb[]): void {
		this.#owner = owner;
		this.heading = '';
		this.back = null;
		this.breadcrumbs = breadcrumbs;
	}

	clear(owner: string): void {
		if (this.#owner !== owner) return;
		this.#owner = '';
		this.heading = '';
		this.back = null;
		this.breadcrumbs = [];
	}
}

export const pageChrome = new PageChrome();
