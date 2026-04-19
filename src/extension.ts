import * as path from "path";
import * as vscode from "vscode";
import { FolderQuickPickItem } from "./browser";
import { BrowserSession, createStartFolderFromUri } from "./browserSession";
import {
  EverythingBackend,
  SearchBackend,
  SearchBackendMode,
  resolveSearchBackend,
  WorkspaceIndex
} from "./backends";

const OPEN_COMMAND = "quopen.open";
const OPEN_FROM_ACTIVE_FILE_COMMAND = "quopen.openFromActiveFile";
const BROWSER_UP_COMMAND = "quopen.browser.up";
const BROWSER_NARROW_SELECTION_COMMAND = "quopen.browser.narrowSelection";
const BROWSER_DELETE_WORD_LEFT_COMMAND = "quopen.browser.deleteWordLeft";
const BROWSER_DELETE_CHARACTER_LEFT_COMMAND = "quopen.browser.deleteCharacterLeft";

let workspaceIndex: WorkspaceIndex | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let statusBarRefreshNonce = 0;
let activeBrowserSession: BrowserSession | undefined;
let cachedEffectiveBackendMode: {
  readonly key: string;
  readonly mode: "everything" | "native";
} | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Keep the extension lightweight: create the workspace index once.
  workspaceIndex = new WorkspaceIndex();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = OPEN_COMMAND;
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, async () => {
      await openByFolder();
    }),
    vscode.commands.registerCommand(OPEN_FROM_ACTIVE_FILE_COMMAND, async () => {
      await openFromActiveFile();
    }),
    vscode.commands.registerCommand(BROWSER_UP_COMMAND, async () => {
      await activeBrowserSession?.goUp();
    }),
    vscode.commands.registerCommand(BROWSER_NARROW_SELECTION_COMMAND, async () => {
      await activeBrowserSession?.narrowSelection();
    }),
    vscode.commands.registerCommand(BROWSER_DELETE_WORD_LEFT_COMMAND, async () => {
      activeBrowserSession?.deleteWordLeft();
    }),
    vscode.commands.registerCommand(BROWSER_DELETE_CHARACTER_LEFT_COMMAND, async () => {
      activeBrowserSession?.deleteCharacterLeft();
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
      void refreshStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("quopen.searchBackend") || event.affectsConfiguration("quopen.everythingPath")) {
        void refreshStatusBar();
      }
    })
  );

  void refreshStatusBar();
}

export function deactivate(): void {
  workspaceIndex = undefined;
  void setBrowserActive(false);
  activeBrowserSession?.dispose();
  activeBrowserSession = undefined;
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

async function openByFolder(startFolder?: FolderQuickPickItem): Promise<void> {
  // Quopen only works when there is at least one workspace folder to browse.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage("Quopen needs an open workspace.");
    return;
  }

  const resolution = await resolveSearchBackend(
    vscode.workspace.getConfiguration("quopen").get<SearchBackendMode>("searchBackend", "auto"),
    vscode.workspace.getConfiguration("quopen").get<string>("everythingPath"),
    workspaceIndex
  );
  workspaceIndex = resolution.workspaceIndex;
  if (resolution.warningMessage) {
    void vscode.window.showWarningMessage(resolution.warningMessage);
  }

  const backend = resolution.backend;
  const session = new BrowserSession(backend, workspaceFolders, setBrowserActive, startFolder);
  activeBrowserSession?.dispose();
  activeBrowserSession = session;
  try {
    await session.start();
  } catch (error) {
    session.dispose();
    throw error;
  }
}

async function openFromActiveFile(): Promise<void> {
  const activeFileUri = getActiveFileUri();
  if (!activeFileUri) {
    void vscode.window.showWarningMessage("Quopen needs an active file to start from.");
    return;
  }

  const startFolder = createStartFolderFromUri(activeFileUri);
  if (!startFolder) {
    void vscode.window.showWarningMessage("Quopen could not determine the active file's folder.");
    return;
  }

  await openByFolder(startFolder);
}

async function refreshStatusBar(): Promise<void> {
  const item = statusBarItem;
  if (!item) {
    return;
  }

  const nonce = ++statusBarRefreshNonce;
  const config = vscode.workspace.getConfiguration("quopen");
  const configuredMode = config.get<SearchBackendMode>("searchBackend", "auto");
  const everythingPath = config.get<string>("everythingPath");
  const effectiveMode = await resolveEffectiveBackendModeCached(configuredMode, everythingPath);

  if (nonce !== statusBarRefreshNonce || !statusBarItem) {
    return;
  }

  item.text = `Quopen: ${effectiveMode === "everything" ? "Everything" : "Native"}`;
  item.tooltip = effectiveMode === "everything"
    ? `Quopen is using the Everything backend.\nConfigured mode: ${configuredMode}.`
    : `Quopen is using the native workspace index.\nConfigured mode: ${configuredMode}.`;
  item.show();
}

async function resolveEffectiveBackendModeCached(
  configuredMode: SearchBackendMode,
  everythingPath: string | undefined
): Promise<"everything" | "native"> {
  const cacheKey = `${configuredMode}|${everythingPath ?? ""}`;
  if (cachedEffectiveBackendMode?.key === cacheKey) {
    return cachedEffectiveBackendMode.mode;
  }

  const mode = await resolveEffectiveBackendMode(configuredMode, everythingPath);
  cachedEffectiveBackendMode = {
    key: cacheKey,
    mode
  };
  return mode;
}

async function resolveEffectiveBackendMode(
  configuredMode: SearchBackendMode,
  everythingPath: string | undefined
): Promise<"everything" | "native"> {
  if (configuredMode === "native") {
    return "native";
  }

  const everythingBackend = await EverythingBackend.create(everythingPath);

  return everythingBackend ? "everything" : "native";
}

async function setBrowserActive(isActive: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "quopen.browserVisible", isActive);
}

function getActiveFileUri(): vscode.Uri | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri && editorUri.scheme === "file") {
    return editorUri;
  }

  const tabUri = getTabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
  if (tabUri) {
    return tabUri;
  }

  for (const group of vscode.window.tabGroups.all) {
    const groupTabUri = getTabUri(group.activeTab);
    if (groupTabUri) {
      return groupTabUri;
    }
  }

  return undefined;
}

function getTabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  if (!tab) {
    return undefined;
  }

  const input = tab.input as {
    readonly uri?: vscode.Uri;
    readonly modified?: { readonly uri?: vscode.Uri };
    readonly original?: { readonly uri?: vscode.Uri };
  };

  if (input.uri?.scheme === "file") {
    return input.uri;
  }

  if (input.modified?.uri?.scheme === "file") {
    return input.modified.uri;
  }

  if (input.original?.uri?.scheme === "file") {
    return input.original.uri;
  }

  return undefined;
}
