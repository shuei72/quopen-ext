import * as vscode from "vscode";
import { BrowserQuickPickItem, FolderQuickPickItem } from "./browser";
import {
  EverythingBackend,
  OutputLogger,
  SearchBackend,
  SearchBackendMode,
  WorkspaceIndex
} from "./backends";

const OPEN_COMMAND = "quopen.open";

let workspaceIndex: WorkspaceIndex | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Keep the extension lightweight: create the shared logger and workspace index once.
  const logger = createLogger();
  workspaceIndex = new WorkspaceIndex(logger);

  context.subscriptions.push(
    outputChannel!,
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
  // Quopen only works when there is at least one workspace folder to browse.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage("Quopen needs an open workspace.");
    return;
  }

  const backend = await resolveSearchBackend();
  await backend.ensureReady();

  let currentFolder: FolderQuickPickItem | undefined;

  while (true) {
    // Each round narrows the search space based on the folder the user picked last.
    const items = await backend.getBrowserItems(currentFolder, workspaceFolders.length > 1);
    if (items.length === 0) {
      const message = currentFolder
        ? "No files or folders were found in the selected folder."
        : "No workspace files were found for Quopen.";
      void vscode.window.showInformationMessage(message);
      return;
    }

    const selectedItem = await pickBrowserItem(items, currentFolder);
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

  // Prefer Everything on Windows when available, otherwise fall back to the built-in index.
  if (mode !== "native") {
    const everythingBackend = await EverythingBackend.create(
      config.get<string>("everythingPath"),
      createLogger()
    );
    if (everythingBackend) {
      logInfo(`Using Everything backend (${everythingBackend.executablePath}).`);
      return everythingBackend;
    }

    logInfo("Everything backend unavailable. Falling back to native workspace index.");
    if (mode === "everything") {
      void vscode.window.showWarningMessage("Quopen could not use Everything. Falling back to the native workspace index.");
    }
  }

  const index = workspaceIndex ?? new WorkspaceIndex(createLogger());
  workspaceIndex = index;
  logInfo("Using native workspace index backend.");
  return index;
}

function createLogger(): OutputLogger {
  // Route status messages to the Quopen output channel so backend decisions stay visible.
  outputChannel ??= vscode.window.createOutputChannel("Quopen");
  return {
    info(message) {
      outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
    },
    warning(message) {
      outputChannel?.appendLine(`[${new Date().toISOString()}] WARNING: ${message}`);
    }
  };
}

function logInfo(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function pickBrowserItem(
  items: BrowserQuickPickItem[],
  currentFolder: FolderQuickPickItem | undefined
): Thenable<BrowserQuickPickItem | undefined> {
  // Show the current folder in the picker prompt so users can keep track of the drill-down level.
  return vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: false,
    placeHolder: currentFolder
      ? `Choose a file or folder in ${currentFolder.label}`
      : "Choose a file or folder"
  });
}
