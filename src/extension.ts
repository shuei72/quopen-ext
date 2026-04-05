import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const OPEN_COMMAND = "quopen.open";
const ROOT_FOLDER_LABEL = "(root)";
const DEFAULT_EVERYTHING_COMMAND = "es.exe";
const EXEC_FILE = promisify(execFile);
const EVERYTHING_MAX_BUFFER = 64 * 1024 * 1024;
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

let workspaceIndex: WorkspaceIndex | undefined;
let outputChannel: vscode.OutputChannel | undefined;

type FolderQuickPickItem = vscode.QuickPickItem & {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly folderPath: string;
  readonly folderKey: string;
};

type BrowserQuickPickItem = vscode.QuickPickItem & {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly relativePath: string;
  readonly itemKind: "folder" | "file";
  readonly uri?: vscode.Uri;
};

type FileEntry = {
  readonly uri: vscode.Uri;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly workspaceRelativePath: string;
  readonly folderPath: string;
};

type WorkspaceFolderIndex = {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly folders: Map<string, FileEntry[]>;
};

type SearchBackend = {
  ensureReady(): Promise<void>;
  getBrowserItems(parent: FolderQuickPickItem | undefined, isMultiRoot: boolean): Promise<BrowserQuickPickItem[]>;
};

type SearchBackendMode = "auto" | "everything" | "native";

export function activate(context: vscode.ExtensionContext): void {
  workspaceIndex = new WorkspaceIndex();
  outputChannel = vscode.window.createOutputChannel("Quopen");

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(OPEN_COMMAND, async () => {
      await openByFolder();
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      workspaceIndex?.applyCreate(event.files);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      workspaceIndex?.applyDelete(event.files);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      workspaceIndex?.applyRename(event.files);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      workspaceIndex?.invalidate();
    })
  );
}

export function deactivate(): void {
  workspaceIndex = undefined;
  outputChannel = undefined;
}

async function openByFolder(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage("Quopen needs an open workspace.");
    return;
  }

  const backend = await resolveSearchBackend();
  await backend.ensureReady();

  let currentFolder: FolderQuickPickItem | undefined;

  while (true) {
    const items = await backend.getBrowserItems(currentFolder, workspaceFolders.length > 1);
    if (items.length === 0) {
      const message = currentFolder
        ? "No files or folders were found in the selected folder."
        : "No workspace files were found for Quopen.";
      void vscode.window.showInformationMessage(message);
      return;
    }

    const selectedItem = await vscode.window.showQuickPick(items, {
      matchOnDescription: true,
      matchOnDetail: false,
      placeHolder: currentFolder
        ? `Choose a file or folder in ${currentFolder.label}`
        : "Choose a file or folder"
    });

    if (!selectedItem) {
      return;
    }

    if (selectedItem.itemKind === "file" && selectedItem.uri) {
      await vscode.window.showTextDocument(selectedItem.uri);
      return;
    }

    currentFolder = {
      label: selectedItem.label,
      description: selectedItem.description,
      detail: selectedItem.detail,
      workspaceFolder: selectedItem.workspaceFolder,
      folderPath: selectedItem.relativePath,
      folderKey: `${selectedItem.workspaceFolder.uri.toString()}::${selectedItem.relativePath}`
    };
  }
}

async function resolveSearchBackend(): Promise<SearchBackend> {
  const config = vscode.workspace.getConfiguration("quopen");
  const mode = config.get<SearchBackendMode>("searchBackend", "auto");
  logInfo(`Resolving search backend (mode=${mode}).`);

  if (mode !== "native") {
    const everythingBackend = await EverythingBackend.create(config.get<string>("everythingPath"));
    if (everythingBackend) {
      logInfo(`Using Everything backend (${everythingBackend.executablePath}).`);
      return everythingBackend;
    }

    logInfo("Everything backend unavailable. Falling back to native workspace index.");
    if (mode === "everything") {
      void vscode.window.showWarningMessage("Quopen could not use Everything. Falling back to the native workspace index.");
    }
  }

  const index = workspaceIndex ?? new WorkspaceIndex();
  workspaceIndex = index;
  logInfo("Using native workspace index backend.");
  return index;
}

function logInfo(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logWarning(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] WARNING: ${message}`);
}

function buildBrowserItems(
  folderItems: readonly FolderQuickPickItem[],
  fileEntries: readonly FileEntry[],
  isMultiRoot: boolean
): BrowserQuickPickItem[] {
  const folders = folderItems.map<BrowserQuickPickItem>((item) => ({
    iconPath: vscode.ThemeIcon.Folder,
    resourceUri: vscode.Uri.file(
      item.folderPath === ROOT_FOLDER_LABEL
        ? item.workspaceFolder.uri.fsPath
        : path.join(item.workspaceFolder.uri.fsPath, item.folderPath)
    ),
    label: item.folderPath === ROOT_FOLDER_LABEL ? item.workspaceFolder.name : path.posix.basename(item.folderPath),
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
    (left.description ?? "").localeCompare(right.description ?? "")
    || left.label.localeCompare(right.label)
    || left.itemKind.localeCompare(right.itemKind)
  );
}

function formatPathDescription(
  workspaceFolder: vscode.WorkspaceFolder,
  relativePath: string,
  isMultiRoot: boolean
): string {
  const normalizedPath = relativePath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : relativePath;
  return isMultiRoot ? `${workspaceFolder.name} / ${normalizedPath}` : normalizedPath;
}

function createFileEntry(workspaceFolder: vscode.WorkspaceFolder, uri: vscode.Uri): FileEntry | undefined {
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

function isExcludedRelativePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_FOLDER_NAMES.has(segment));
}

function compareFileEntries(left: FileEntry, right: FileEntry): number {
  return left.workspaceFolder.name.localeCompare(right.workspaceFolder.name)
    || left.folderPath.localeCompare(right.folderPath)
    || left.workspaceRelativePath.localeCompare(right.workspaceRelativePath);
}

class WorkspaceIndex {
  private readonly workspaceIndexes = new Map<string, WorkspaceFolderIndex>();
  private buildPromise: Promise<void> | undefined;
  private initialized = false;

  async ensureReady(): Promise<void> {
    if (!this.buildPromise) {
      logInfo("Building native workspace index.");
      this.buildPromise = this.rebuild();
    }

    await this.buildPromise;
  }

  invalidate(): void {
    logInfo("Invalidating native workspace index.");
    this.initialized = false;
    this.buildPromise = undefined;
    this.workspaceIndexes.clear();
  }

  async getBrowserItems(parent: FolderQuickPickItem | undefined, isMultiRoot: boolean): Promise<BrowserQuickPickItem[]> {
    const folderItems = parent
      ? this.getDescendantFolderItems(parent)
      : this.getAllFolderItems(isMultiRoot);
    const fileEntries = parent
      ? this.getDescendantFileEntries(parent)
      : this.getAllFileEntries();
    return buildBrowserItems(folderItems, fileEntries, isMultiRoot);
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
    const existingIndex = folderEntries.findIndex((candidate) => candidate.uri.toString() === entry.uri.toString());

    if (existingIndex >= 0) {
      folderEntries[existingIndex] = entry;
    } else {
      folderEntries.push(entry);
    }

    folderEntries.sort(compareFileEntries);
    workspaceIndexEntry.folders.set(entry.folderPath, folderEntries);
  }

  private removeUri(uri: vscode.Uri): void {
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
    const folderItems: FolderQuickPickItem[] = [];

    for (const workspaceIndexEntry of this.workspaceIndexes.values()) {
      for (const folderPath of workspaceIndexEntry.folders.keys()) {
        folderItems.push({
          label: folderPath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : path.posix.basename(folderPath),
          description: isMultiRoot ? workspaceIndexEntry.workspaceFolder.name : undefined,
          detail: folderPath === ROOT_FOLDER_LABEL ? "Workspace root" : folderPath,
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
        detail: folderPath,
        workspaceFolder: parent.workspaceFolder,
        folderPath,
        folderKey: `${parent.workspaceFolder.uri.toString()}::${folderPath}`
      });
    }

    return descendantFolders.sort((left, right) => left.folderPath.localeCompare(right.folderPath));
  }

  private getDescendantFileEntries(parent: FolderQuickPickItem): FileEntry[] {
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

class EverythingBackend implements SearchBackend {
  private constructor(readonly executablePath: string) {}

  static async create(configuredPath: string | undefined): Promise<EverythingBackend | undefined> {
    if (process.platform !== "win32") {
      logInfo("Everything backend skipped because platform is not Windows.");
      return undefined;
    }

    const candidates = [configuredPath?.trim(), DEFAULT_EVERYTHING_COMMAND].filter(
      (candidate): candidate is string => Boolean(candidate)
    );

    for (const candidate of candidates) {
      try {
        await EXEC_FILE(candidate, ["-n", "1"], { windowsHide: true, maxBuffer: EVERYTHING_MAX_BUFFER });
        logInfo(`Everything backend is available via ${candidate}.`);
        return new EverythingBackend(candidate);
      } catch (error) {
        logInfo(`Everything probe failed for ${candidate}: ${formatError(error)}`);
        continue;
      }
    }

    return undefined;
  }

  async ensureReady(): Promise<void> {}

  async getBrowserItems(parent: FolderQuickPickItem | undefined, isMultiRoot: boolean): Promise<BrowserQuickPickItem[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const folderItems: FolderQuickPickItem[] = [];
    const fileEntries: FileEntry[] = [];

    if (!parent) {
      await Promise.all(workspaceFolders.map(async (workspaceFolder) => {
        if (workspaceFolder.uri.scheme !== "file") {
          return;
        }

        const filePaths = await this.searchFilePaths(["-path", workspaceFolder.uri.fsPath, "/a-d", "-sort", "path"]);
        const seenFolders = new Set<string>();

        for (const filePath of filePaths) {
          const entry = createFileEntry(workspaceFolder, vscode.Uri.file(filePath));
          if (!entry) {
            continue;
          }

          fileEntries.push(entry);

          if (!seenFolders.has(entry.folderPath)) {
            seenFolders.add(entry.folderPath);
            folderItems.push({
              label: entry.folderPath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : path.posix.basename(entry.folderPath),
              description: isMultiRoot ? workspaceFolder.name : undefined,
              detail: entry.folderPath === ROOT_FOLDER_LABEL ? "Workspace root" : entry.folderPath,
              workspaceFolder,
              folderPath: entry.folderPath,
              folderKey: `${workspaceFolder.uri.toString()}::${entry.folderPath}`
            });
          }
        }
      }));
    } else {
      if (parent.workspaceFolder.uri.scheme !== "file") {
        return [];
      }

      const parentPath = parent.folderPath === ROOT_FOLDER_LABEL
        ? parent.workspaceFolder.uri.fsPath
        : path.join(parent.workspaceFolder.uri.fsPath, parent.folderPath);
      const childFilePaths = await this.searchFilePaths(["-parent", parentPath, "/a-d", "-sort", "path"]);
      const descendantFilePaths = await this.searchFilePaths(["-path", parentPath, "/a-d", "-sort", "path"]);
      const seenFolders = new Set<string>();
      const parentPrefix = parent.folderPath === ROOT_FOLDER_LABEL ? "" : `${parent.folderPath}/`;
      for (const filePath of descendantFilePaths) {
        const entry = createFileEntry(parent.workspaceFolder, vscode.Uri.file(filePath));
        if (!entry) {
          continue;
        }

        fileEntries.push(entry);

        if (entry.folderPath !== ROOT_FOLDER_LABEL
          && entry.folderPath !== parent.folderPath
          && (parent.folderPath === ROOT_FOLDER_LABEL || entry.folderPath.startsWith(parentPrefix))
          && !seenFolders.has(entry.folderPath)) {
          seenFolders.add(entry.folderPath);
          folderItems.push({
            label: path.posix.basename(entry.folderPath),
            description: parent.description,
            detail: entry.folderPath,
            workspaceFolder: parent.workspaceFolder,
            folderPath: entry.folderPath,
            folderKey: `${parent.workspaceFolder.uri.toString()}::${entry.folderPath}`
          });
        }
      }
    }

    return buildBrowserItems(folderItems, fileEntries, isMultiRoot);
  }

  private async searchFilePaths(args: readonly string[]): Promise<string[]> {
    logInfo(`Everything query: ${args.join(" ")}`);
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
          `Everything query output exceeded EVERYTHING_MAX_BUFFER (${EVERYTHING_MAX_BUFFER} bytes). ` +
          `Consider narrowing the search scope.`;
        logWarning(`${warningMessage} Query: ${args.join(" ")}`);
        void vscode.window.showWarningMessage(warningMessage);
      }

      throw error;
    }

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMaxBufferError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}
