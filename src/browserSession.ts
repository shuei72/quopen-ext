import * as path from "path";
import * as vscode from "vscode";
import { BrowserQuickPickItem, FolderQuickPickItem, ROOT_FOLDER_LABEL } from "./browser";
import { SearchBackend } from "./backends";

export class BrowserSession {
  private readonly quickPick = vscode.window.createQuickPick<BrowserQuickPickItem>();
  private readonly isMultiRoot: boolean;
  private currentFolder: FolderQuickPickItem | undefined;
  private currentItems: BrowserQuickPickItem[] = [];
  private visibleItems: BrowserQuickPickItem[] = [];
  private renderNonce = 0;
  private disposed = false;
  private suppressValueChange = false;

  constructor(
    private readonly backend: SearchBackend,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    private readonly setBrowserActive: (isActive: boolean) => Promise<void>,
    startFolder?: FolderQuickPickItem
  ) {
    this.isMultiRoot = workspaceFolders.length > 1;
    this.currentFolder = startFolder;
  }

  async start(): Promise<void> {
    await this.backend.ensureReady();
    if (this.disposed) {
      return;
    }

    this.updateTitle();
    this.quickPick.matchOnDescription = false;
    this.quickPick.matchOnDetail = false;
    this.quickPick.canSelectMany = false;
    this.quickPick.ignoreFocusOut = false;

    this.quickPick.onDidAccept(() => {
      void this.acceptSelection();
    });
    this.quickPick.onDidChangeValue((value) => {
      if (this.suppressValueChange) {
        return;
      }
      void this.refreshItems(value);
    });
    this.quickPick.onDidChangeActive((items) => {
      this.syncFocusedSelection(items[0]);
    });
    this.quickPick.onDidHide(() => {
      this.dispose();
    });

    await this.setBrowserActive(true);
    this.quickPick.show();
    await this.refreshItems("");
  }

  async goUp(): Promise<void> {
    if (this.disposed || !this.currentFolder) {
      return;
    }

    const parentFolder = getParentFolder(this.currentFolder);
    if (parentFolder === undefined && this.currentFolder.folderPath === ROOT_FOLDER_LABEL) {
      return;
    }

    this.currentFolder = parentFolder;
    this.updateTitle();
    await this.refreshItems(this.quickPick.value);
  }

  async narrowSelection(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const selectedItem = this.quickPick.activeItems[0];
    if (!selectedItem) {
      return;
    }

    this.currentFolder = selectedItem.itemKind === "folder"
      ? createFolderQuickPickItem(
        selectedItem.workspaceFolder,
        selectedItem.relativePath,
        selectedItem.description
      )
      : createFolderQuickPickItem(
        selectedItem.workspaceFolder,
        getFolderPathFromFilePath(selectedItem.relativePath),
        selectedItem.description
      );
    this.updateTitle();
    this.clearQuery();
    await this.refreshItems("");
  }

  deleteWordLeft(): void {
    if (this.disposed) {
      return;
    }

    const nextValue = removeTrailingWord(this.quickPick.value);
    if (nextValue === this.quickPick.value) {
      return;
    }

    this.quickPick.value = nextValue;
  }

  deleteCharacterLeft(): void {
    if (this.disposed) {
      return;
    }

    const nextValue = removeTrailingCharacter(this.quickPick.value);
    if (nextValue === this.quickPick.value) {
      return;
    }

    this.quickPick.value = nextValue;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.quickPick.hide();
    this.quickPick.dispose();
    void this.setBrowserActive(false);
  }

  private async acceptSelection(): Promise<void> {
    const selectedItem = this.quickPick.activeItems[0];
    if (!selectedItem || this.disposed) {
      return;
    }

    if (selectedItem.itemKind === "file" && selectedItem.uri) {
      const uri = selectedItem.uri;
      this.dispose();
      await vscode.window.showTextDocument(uri);
      return;
    }

    this.currentFolder = createFolderQuickPickItem(
      selectedItem.workspaceFolder,
      selectedItem.relativePath,
      selectedItem.description
    );
    this.updateTitle();
    this.clearQuery();
    await this.refreshItems("");
  }

  private async refreshItems(query: string): Promise<void> {
    const token = ++this.renderNonce;
    this.quickPick.busy = true;
    this.quickPick.placeholder = this.currentFolder
      ? `Choose a file or folder in ${this.currentFolder.label}`
      : "Choose a file or folder";

    try {
      const items = await this.backend.getBrowserItems(this.currentFolder, this.isMultiRoot, query);
      if (this.disposed || token !== this.renderNonce) {
        return;
      }

      if (items.length === 0) {
        const message = this.currentFolder
          ? "No files or folders were found in the selected folder."
          : "No workspace files were found for Quopen.";
        this.dispose();
        void vscode.window.showInformationMessage(message);
        return;
      }

      this.currentItems = items;
      this.visibleItems = items;
      this.quickPick.items = items.map((item) => ({
        ...item,
        alwaysShow: true
      }));
      this.restoreFocusedSelection();
      this.updateTitle();
    } catch (error) {
      if (!this.disposed) {
        this.dispose();
        void vscode.window.showErrorMessage(`Quopen failed to load items: ${String(error)}`);
      }
      return;
    } finally {
      if (!this.disposed && token === this.renderNonce) {
        this.quickPick.busy = false;
      }
    }
  }

  private updateTitle(): void {
    this.quickPick.title = this.currentFolder
      ? `Quopen: ${formatCurrentFolderTitle(this.currentFolder, this.isMultiRoot)}`
      : "Quopen";
  }

  private restoreFocusedSelection(): void {
    const items = this.visibleItems;
    if (items.length === 0) {
      return;
    }

    const firstItem = items[0];
    this.quickPick.activeItems = [firstItem];
    this.quickPick.selectedItems = [firstItem];
  }

  private syncFocusedSelection(activeItem: BrowserQuickPickItem | undefined): void {
    if (!activeItem) {
      return;
    }
  }

  private clearQuery(): void {
    if (this.quickPick.value.length === 0) {
      return;
    }

    this.suppressValueChange = true;
    this.quickPick.value = "";
    this.suppressValueChange = false;
  }

}

export function createStartFolderFromUri(uri: vscode.Uri): FolderQuickPickItem | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder || uri.scheme !== "file") {
    return undefined;
  }

  const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..")) {
    return undefined;
  }

  const parsedPath = path.posix.parse(relativePath);
  const folderPath = parsedPath.dir || ROOT_FOLDER_LABEL;
  return createFolderQuickPickItem(workspaceFolder, folderPath);
}

function createFolderQuickPickItem(
  workspaceFolder: vscode.WorkspaceFolder,
  folderPath: string,
  description?: string
): FolderQuickPickItem {
  return {
    label: folderPath === ROOT_FOLDER_LABEL ? workspaceFolder.name : path.posix.basename(folderPath),
    description,
    workspaceFolder,
    folderPath,
    folderKey: `${workspaceFolder.uri.toString()}::${folderPath}`
  };
}

function getParentFolder(folder: FolderQuickPickItem): FolderQuickPickItem | undefined {
  if (folder.folderPath === ROOT_FOLDER_LABEL) {
    return undefined;
  }

  const parentPath = path.posix.dirname(folder.folderPath);
  return createFolderQuickPickItem(
    folder.workspaceFolder,
    parentPath === "." ? ROOT_FOLDER_LABEL : parentPath,
    folder.description
  );
}

function formatCurrentFolderTitle(folder: FolderQuickPickItem, isMultiRoot: boolean): string {
  const normalizedPath = folder.folderPath === ROOT_FOLDER_LABEL ? ROOT_FOLDER_LABEL : folder.folderPath;
  if (!isMultiRoot) {
    return normalizedPath;
  }

  return `${normalizedPath} (${folder.workspaceFolder.name})`;
}

function removeTrailingWord(value: string): string {
  const trimmed = value.replace(/\s+$/, "");
  const nextValue = trimmed.replace(/(\s+)?\S+$/, "");
  return nextValue;
}

function removeTrailingCharacter(value: string): string {
  return value.slice(0, -1);
}

function getFolderPathFromFilePath(filePath: string): string {
  const parentPath = path.posix.dirname(filePath);
  return parentPath === "." ? ROOT_FOLDER_LABEL : parentPath;
}
