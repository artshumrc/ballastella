declare global {
	function workspaceRoot(): Promise<FileSystemDirectoryHandle>;

	function workspaceRootIfAny(): Promise<FileSystemDirectoryHandle | null>;
}

export {};
