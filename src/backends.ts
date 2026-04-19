import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  BrowserQuickPickItem,
  buildBrowserItems,
  compareFileEntries,
  createFileEntry,
  FileEntry,
  FolderQuickPickItem,
  isMaxBufferError,
  ROOT_FOLDER_LABEL,
  WorkspaceFolderIndex
} from "./browser";

const DEFAULT_EVERYTHING_COMMAND = "es.exe";
const EXEC_FILE = promisify(execFile);
const EVERYTHING_MAX_BUFFER = 64 * 1024 * 1024;

export type SearchBackendMode = "auto" | "everything" | "native";

export type SearchBackendResolution = {
  readonly backend: SearchBackend;
  readonly workspaceIndex: WorkspaceIndex;
  readonly warningMessage?: string;
};

export interface SearchBackend {
  ensureReady(): Promise<void>;
  getBrowserItems(
    parent: FolderQuickPickItem | undefined,
    isMultiRoot: boolean,
    query?: string
  ): Promise<BrowserQuickPickItem[]>;
}

export async function resolveSearchBackend(
  configuredMode: SearchBackendMode,
  everythingPath: string | undefined,
  workspaceIndex: WorkspaceIndex | undefined
): Promise<SearchBackendResolution> {
  if (configuredMode !== "native") {
    const everythingBackend = await EverythingBackend.create(everythingPath);
    if (everythingBackend) {
      return {
        backend: everythingBackend,
        workspaceIndex: workspaceIndex ?? new WorkspaceIndex()
      };
    }

    if (configuredMode === "everything") {
      const nativeIndex = workspaceIndex ?? new WorkspaceIndex();
      return {
        backend: nativeIndex,
        workspaceIndex: nativeIndex,
        warningMessage: "Quopen could not use Everything. Falling back to the native workspace index."
      };
    }
  }

  const nativeIndex = workspaceIndex ?? new WorkspaceIndex();
  return {
    backend: nativeIndex,
    workspaceIndex: nativeIndex
  };
}

export class WorkspaceIndex implements SearchBackend {
  private readonly workspaceIndexes = new Map<string, WorkspaceFolderIndex>();
  private buildPromise: Promise<void> | undefined;
  private initialized = false;

  async ensureReady(): Promise<void> {
    // Build the full workspace map lazily, then reuse it until the workspace changes.
    if (!this.buildPromise) {
      this.buildPromise = this.rebuild();
    }

    await this.buildPromise;
  }

  invalidate(): void {
    // Any workspace folder change can invalidate the cached native index.
    this.initialized = false;
    this.buildPromise = undefined;
    this.workspaceIndexes.clear();
  }

  async getBrowserItems(
    parent: FolderQuickPickItem | undefined,
    isMultiRoot: boolean,
    query?: string
  ): Promise<BrowserQuickPickItem[]> {
    // When a folder is selected, show only its descendants; otherwise show the top level.
    const folderItems = parent
      ? this.getDescendantFolderItems(parent)
      : this.getAllFolderItems(isMultiRoot);
    const fileEntries = parent
      ? this.getDescendantFileEntries(parent)
      : this.getAllFileEntries();
    const items = buildBrowserItems(folderItems, fileEntries, isMultiRoot);
    return query ? items.filter((item) => item.description?.toLowerCase().includes(query.toLowerCase()) ?? false) : items;
  }

  applyCreate(uris: readonly vscode.Uri[]): void {
    if (!this.initialized) {
      return;
    }

    for (const uri of uris) {
      this.upsertUri(uri);
    }
  }

  applyDelete(uris: readonly vscode.Uri[]): void {
    if (!this.initialized) {
      return;
    }

    for (const uri of uris) {
      this.removeUri(uri);
    }
  }

  applyRename(files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[]): void {
    if (!this.initialized) {
      return;
    }

    for (const file of files) {
      this.removeUri(file.oldUri);
      this.upsertUri(file.newUri);
    }
  }

  private async rebuild(): Promise<void> {
    // Rebuild the workspace snapshot from scratch so the native backend stays consistent.
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const nextIndexes = new Map<string, WorkspaceFolderIndex>();

    const collected = await Promise.all(
      workspaceFolders.map(async (workspaceFolder) => {
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, "**/*"));
        const folders = new Map<string, FileEntry[]>();

        for (const uri of uris) {
          const entry = createFileEntry(workspaceFolder, uri);
          if (!entry) {
            continue;
          }

          const folderEntries = folders.get(entry.folderPath) ?? [];
          folderEntries.push(entry);
          folders.set(entry.folderPath, folderEntries);
        }

        for (const folderEntries of folders.values()) {
          folderEntries.sort(compareFileEntries);
        }

        return {
          key: workspaceFolder.uri.toString(),
          index: {
            workspaceFolder,
            folders
          } satisfies WorkspaceFolderIndex
        };
      })
    );

    for (const item of collected) {
      nextIndexes.set(item.key, item.index);
    }

    this.workspaceIndexes.clear();
    for (const [key, value] of nextIndexes) {
      this.workspaceIndexes.set(key, value);
    }

    this.initialized = true;
    this.buildPromise = undefined;
  }

  private upsertUri(uri: vscode.Uri): void {
    // Incremental file events update only the affected workspace bucket.
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }

    const entry = createFileEntry(workspaceFolder, uri);
    if (!entry) {
      return;
    }

    const workspaceIndexEntry = this.getOrCreateWorkspaceIndex(workspaceFolder);
    const folderEntries = workspaceIndexEntry.folders.get(entry.folderPath) ?? [];
    const existingIndex = folderEntries.findIndex(
      (candidate) => candidate.uri.toString() === entry.uri.toString()
    );

    if (existingIndex >= 0) {
      folderEntries[existingIndex] = entry;
    } else {
      folderEntries.push(entry);
    }

    folderEntries.sort(compareFileEntries);
    workspaceIndexEntry.folders.set(entry.folderPath, folderEntries);
  }

  private removeUri(uri: vscode.Uri): void {
    // Remove the file from its folder bucket and drop the bucket if it becomes empty.
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }

    const workspaceIndexEntry = this.workspaceIndexes.get(workspaceFolder.uri.toString());
    if (!workspaceIndexEntry) {
      return;
    }

    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
    const parsedPath = path.posix.parse(relativePath);
    const folderPath = parsedPath.dir || ROOT_FOLDER_LABEL;
    const folderEntries = workspaceIndexEntry.folders.get(folderPath);

    if (!folderEntries) {
      return;
    }

    const nextEntries = folderEntries.filter((entry) => entry.uri.toString() !== uri.toString());
    if (nextEntries.length === 0) {
      workspaceIndexEntry.folders.delete(folderPath);
      return;
    }

    workspaceIndexEntry.folders.set(folderPath, nextEntries);
  }

  private getOrCreateWorkspaceIndex(workspaceFolder: vscode.WorkspaceFolder): WorkspaceFolderIndex {
    const key = workspaceFolder.uri.toString();
    const existing = this.workspaceIndexes.get(key);
    if (existing) {
      return existing;
    }

    const created: WorkspaceFolderIndex = {
      workspaceFolder,
      folders: new Map<string, FileEntry[]>()
    };
    this.workspaceIndexes.set(key, created);
    return created;
  }

  private getAllFolderItems(isMultiRoot: boolean): FolderQuickPickItem[] {
    // Flatten the cached index into quick pick folder entries.
    const folderItems: FolderQuickPickItem[] = [];

    for (const workspaceIndexEntry of this.workspaceIndexes.values()) {
      for (const folderPath of workspaceIndexEntry.folders.keys()) {
        folderItems.push({
          label: folderPath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : path.posix.basename(folderPath),
          description: isMultiRoot ? workspaceIndexEntry.workspaceFolder.name : undefined,
          workspaceFolder: workspaceIndexEntry.workspaceFolder,
          folderPath,
          folderKey: `${workspaceIndexEntry.workspaceFolder.uri.toString()}::${folderPath}`
        });
      }
    }

    return folderItems;
  }

  private getAllFileEntries(): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const workspaceIndexEntry of this.workspaceIndexes.values()) {
      for (const folderEntries of workspaceIndexEntry.folders.values()) {
        entries.push(...folderEntries);
      }
    }
    return entries.sort(compareFileEntries);
  }

  private getDescendantFolderItems(parent: FolderQuickPickItem): FolderQuickPickItem[] {
    // Only keep subfolders below the selected folder path.
    const workspaceIndexEntry = this.workspaceIndexes.get(parent.workspaceFolder.uri.toString());
    if (!workspaceIndexEntry) {
      return [];
    }

    const descendantFolders: FolderQuickPickItem[] = [];
    const parentPrefix = parent.folderPath === ROOT_FOLDER_LABEL ? "" : `${parent.folderPath}/`;

    for (const folderPath of workspaceIndexEntry.folders.keys()) {
      if (folderPath === ROOT_FOLDER_LABEL || folderPath === parent.folderPath) {
        continue;
      }
      if (parent.folderPath !== ROOT_FOLDER_LABEL && !folderPath.startsWith(parentPrefix)) {
        continue;
      }

      descendantFolders.push({
        label: path.posix.basename(folderPath),
        description: parent.description,
        workspaceFolder: parent.workspaceFolder,
        folderPath,
        folderKey: `${parent.workspaceFolder.uri.toString()}::${folderPath}`
      });
    }

    return descendantFolders.sort((left, right) => left.folderPath.localeCompare(right.folderPath));
  }

  private getDescendantFileEntries(parent: FolderQuickPickItem): FileEntry[] {
    // The file list is filtered separately so the picker can show folders and files together.
    const workspaceIndexEntry = this.workspaceIndexes.get(parent.workspaceFolder.uri.toString());
    if (!workspaceIndexEntry) {
      return [];
    }

    const parentPrefix = parent.folderPath === ROOT_FOLDER_LABEL ? "" : `${parent.folderPath}/`;
    const entries: FileEntry[] = [];

    for (const [folderPath, folderEntries] of workspaceIndexEntry.folders.entries()) {
      if (parent.folderPath === ROOT_FOLDER_LABEL) {
        entries.push(...folderEntries);
        continue;
      }

      if (folderPath === parent.folderPath || folderPath.startsWith(parentPrefix)) {
        entries.push(...folderEntries);
      }
    }

    return entries.sort(compareFileEntries);
  }
}

export class EverythingBackend implements SearchBackend {
  private constructor(
    readonly executablePath: string
  ) {}

  static async create(
    configuredPath: string | undefined
  ): Promise<EverythingBackend | undefined> {
    // On Windows, probe the configured path first and then the default Everything command.
    if (process.platform !== "win32") {
      return undefined;
    }

    const candidates = [configuredPath?.trim(), DEFAULT_EVERYTHING_COMMAND].filter(
      (candidate): candidate is string => Boolean(candidate)
    );

    for (const candidate of candidates) {
      try {
        await EXEC_FILE(candidate, ["-n", "1"], {
          windowsHide: true,
          maxBuffer: EVERYTHING_MAX_BUFFER
        });
        return new EverythingBackend(candidate);
      } catch {
        continue;
      }
    }

    return undefined;
  }

  async ensureReady(): Promise<void> {}

  async getBrowserItems(
    parent: FolderQuickPickItem | undefined,
    isMultiRoot: boolean,
    query?: string
  ): Promise<BrowserQuickPickItem[]> {
    // Everything returns file paths, so we rebuild the visible folder/file items from them.
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const items: BrowserQuickPickItem[] = [];

    if (!parent) {
      for (const workspaceFolder of workspaceFolders) {
        if (workspaceFolder.uri.scheme !== "file") {
          continue;
        }

      const filePaths = await this.searchWorkspaceFilePaths(workspaceFolder.uri.fsPath, query);
        for (const filePath of filePaths) {
          const item = this.createEverythingItem(workspaceFolder, filePath, isMultiRoot);
          if (!item) {
            continue;
          }
          items.push(item);
        }
      }
    } else {
      if (parent.workspaceFolder.uri.scheme !== "file") {
        return [];
      }

      const descendantFilePaths = await this.searchWorkspaceFilePaths(
        this.resolveWorkspacePath(parent.workspaceFolder, parent.folderPath),
        query
      );
      for (const filePath of descendantFilePaths) {
        const item = this.createEverythingItem(parent.workspaceFolder, filePath, false);
        if (!item) {
          continue;
        }
        items.push(item);
      }
    }

    return items;
  }

  private async searchWorkspaceFilePaths(
    workspacePath: string,
    query?: string,
    limit?: number
  ): Promise<string[]> {
    const args = [
      "-p",
      "-path",
      workspacePath,
      "-sort",
      "path"
    ];

    if (query) {
      args.push(...splitSearchQuery(query));
    }

    if (limit !== undefined) {
      args.unshift("-n", String(limit));
    }

    return this.searchFilePaths(args);
  }

  private resolveWorkspacePath(
    workspaceFolder: vscode.WorkspaceFolder,
    folderPath: string
  ): string {
    return folderPath === ROOT_FOLDER_LABEL
      ? workspaceFolder.uri.fsPath
      : path.join(workspaceFolder.uri.fsPath, folderPath);
  }

  private createEverythingItem(
    workspaceFolder: vscode.WorkspaceFolder,
    absolutePath: string,
    isMultiRoot: boolean
  ): BrowserQuickPickItem | undefined {
    const normalizedAbsolutePath = path.normalize(absolutePath);
    const workspaceRelativePath = path.relative(workspaceFolder.uri.fsPath, normalizedAbsolutePath).replace(/\\/g, "/");
    if (!workspaceRelativePath || workspaceRelativePath.startsWith("..")) {
      return undefined;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(normalizedAbsolutePath);
    } catch {
      return undefined;
    }

    const isFolder = stat.isDirectory();
    const itemKind = isFolder ? "folder" : "file";
    const label = isFolder && workspaceRelativePath === ROOT_FOLDER_LABEL
      ? workspaceFolder.name
      : path.posix.basename(workspaceRelativePath);
    const description = isMultiRoot
      ? `${workspaceFolder.name} / ${workspaceRelativePath}`
      : workspaceRelativePath;

    return {
      iconPath: isFolder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File,
      resourceUri: vscode.Uri.file(normalizedAbsolutePath),
      label,
      description,
      workspaceFolder,
      relativePath: workspaceRelativePath,
      itemKind,
      uri: isFolder ? undefined : vscode.Uri.file(normalizedAbsolutePath),
      selectionKey: `${workspaceFolder.uri.toString()}::${itemKind}::${workspaceRelativePath}`
    };
  }

  private async searchFilePaths(args: readonly string[]): Promise<string[]> {
    // Wrap Everything so callers only deal with trimmed file paths.
    let stdout: string;
    try {
      const result = await EXEC_FILE(this.executablePath, args, {
        windowsHide: true,
        maxBuffer: EVERYTHING_MAX_BUFFER
      });
      stdout = result.stdout;
    } catch (error) {
      if (isMaxBufferError(error)) {
        const warningMessage =
          `Everything query output exceeded EVERYTHING_MAX_BUFFER (${EVERYTHING_MAX_BUFFER} bytes). `
          + "Consider narrowing the search scope.";
        void vscode.window.showWarningMessage(warningMessage);
      }

      throw error;
    }

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines;
  }

}

function compareAbsolutePaths(left: string, right: string): number {
  return normalizeAbsolutePath(left).localeCompare(normalizeAbsolutePath(right));
}

function normalizeAbsolutePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function splitSearchQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}
