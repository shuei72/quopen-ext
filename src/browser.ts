import * as path from "path";
import * as vscode from "vscode";

export const ROOT_FOLDER_LABEL = "(root)";

const EXCLUDED_FOLDER_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  "_darcs",
  ".jj",
  ".sl",
  ".vs",
  ".vscode-test",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  ".env",
  ".tox",
  ".nox",
  ".cache",
  ".tmp",
  "node_modules",
]);

export type FolderQuickPickItem = vscode.QuickPickItem & {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly folderPath: string;
  readonly folderKey: string;
};

export type BrowserQuickPickItem = vscode.QuickPickItem & {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly relativePath: string;
  readonly itemKind: "folder" | "file";
  readonly uri?: vscode.Uri;
};

export type FileEntry = {
  readonly uri: vscode.Uri;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly workspaceRelativePath: string;
  readonly folderPath: string;
};

export type WorkspaceFolderIndex = {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly folders: Map<string, FileEntry[]>;
};

export function buildBrowserItems(
  folderItems: readonly FolderQuickPickItem[],
  fileEntries: readonly FileEntry[],
  isMultiRoot: boolean
): BrowserQuickPickItem[] {
  // Present folders first and files second, then sort by display path for stable navigation.
  const folders = folderItems.map<BrowserQuickPickItem>((item) => ({
    iconPath: vscode.ThemeIcon.Folder,
    resourceUri: vscode.Uri.file(
      item.folderPath === ROOT_FOLDER_LABEL
        ? item.workspaceFolder.uri.fsPath
        : path.join(item.workspaceFolder.uri.fsPath, item.folderPath)
    ),
    label:
      item.folderPath === ROOT_FOLDER_LABEL
        ? item.workspaceFolder.name
        : path.posix.basename(item.folderPath),
    description: formatPathDescription(item.workspaceFolder, item.folderPath, isMultiRoot),
    workspaceFolder: item.workspaceFolder,
    relativePath: item.folderPath,
    itemKind: "folder"
  }));
  const files = fileEntries.map<BrowserQuickPickItem>((entry) => ({
    iconPath: vscode.ThemeIcon.File,
    resourceUri: entry.uri,
    label: path.posix.basename(entry.workspaceRelativePath),
    description: formatPathDescription(entry.workspaceFolder, entry.workspaceRelativePath, isMultiRoot),
    workspaceFolder: entry.workspaceFolder,
    relativePath: entry.workspaceRelativePath,
    itemKind: "file",
    uri: entry.uri
  }));

  return [...folders, ...files].sort((left, right) =>
    compareItemKind(left.itemKind, right.itemKind)
      || (left.description ?? "").localeCompare(right.description ?? "")
      || left.label.localeCompare(right.label)
  );
}

export function createFileEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  uri: vscode.Uri
): FileEntry | undefined {
  // Skip non-file URIs and anything that escapes the workspace root.
  if (uri.scheme !== "file") {
    return undefined;
  }

  const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  if (!relativePath || relativePath.startsWith("..")) {
    return undefined;
  }

  const workspaceRelativePath = relativePath.replace(/\\/g, "/");
  if (isExcludedRelativePath(workspaceRelativePath)) {
    return undefined;
  }
  const parsedPath = path.posix.parse(workspaceRelativePath);
  const folderPath = parsedPath.dir || ROOT_FOLDER_LABEL;

  return {
    uri,
    workspaceFolder,
    workspaceRelativePath,
    folderPath
  };
}

export function compareFileEntries(left: FileEntry, right: FileEntry): number {
  // Keep results grouped by workspace, folder, and then file path.
  return left.workspaceFolder.name.localeCompare(right.workspaceFolder.name)
    || left.folderPath.localeCompare(right.folderPath)
    || left.workspaceRelativePath.localeCompare(right.workspaceRelativePath);
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isMaxBufferError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function formatPathDescription(
  workspaceFolder: vscode.WorkspaceFolder,
  relativePath: string,
  isMultiRoot: boolean
): string {
  // In multi-root workspaces, prefix results so the origin stays obvious.
  const normalizedPath = relativePath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : relativePath;
  return isMultiRoot ? `${workspaceFolder.name} / ${normalizedPath}` : normalizedPath;
}

function isExcludedRelativePath(relativePath: string): boolean {
  // Skip common build, cache, and dependency folders so the picker stays focused.
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_FOLDER_NAMES.has(segment));
}

function compareItemKind(left: BrowserQuickPickItem["itemKind"], right: BrowserQuickPickItem["itemKind"]): number {
  if (left === right) {
    return 0;
  }

  return left === "folder" ? -1 : 1;
}
