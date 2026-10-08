import type { StorePath } from '../store/project-store.js';

export const IMAGE_DIRECTORY = 'images';
export const imageDirectory = (imageId: string): StorePath => `${IMAGE_DIRECTORY}/${imageId}`;
export const imageInfoPath = (imageId: string): StorePath => `${imageDirectory(imageId)}/info.json`;

export const imageManifestPath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/manifest.json`;
