export const KIND_STYLE = {
	map: {
		tint: 'bg-accent',
		ink: 'text-accent-content',
		toggle: 'toggle-accent',
		range: 'range-accent',
		btn: 'btn-accent',
		btnWhenChecked: 'has-[:checked]:btn-accent'
	},
	annotation: {
		tint: 'bg-info',
		ink: 'text-info-content',
		toggle: 'toggle-info',
		range: 'range-info',
		btn: 'btn-info',
		btnWhenChecked: 'has-[:checked]:btn-info'
	},
	foreign: {
		tint: 'bg-base-content/5',
		ink: 'text-base-content/70',
		toggle: '',
		range: '',
		btn: '',
		btnWhenChecked: ''
	}
} as const;
