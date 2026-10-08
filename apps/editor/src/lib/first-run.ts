import { readItem, writeItem } from './browser-storage.js';

const STORAGE_KEY = 'ballastella.visited';
let claimed = false;

export function claimFirstVisit(): boolean {
	if (claimed) return false;
	claimed = true;
	if (readItem('localStorage', STORAGE_KEY) === 'yes') return false;
	writeItem('localStorage', STORAGE_KEY, 'yes');
	return readItem('localStorage', STORAGE_KEY) === 'yes';
}
