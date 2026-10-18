'use strict';

// Adapted from leandrosilva/vscode-favorites-explorer (MIT, 2026).
// Original copyright and permission terms are retained in LICENSE.
const vscode = require('vscode');
const path = require('node:path');

const STATE_KEY = 'quicklist.items';

/** @typedef {{ uri: string, type: 'file' | 'folder' }} Entry */

function isResourceUri(uri) {
  return Boolean(uri && typeof uri.scheme === 'string' && uri.scheme &&
    uri.scheme !== 'untitled' && typeof uri.path === 'string' &&
    uri.path.startsWith('/') && !uri.query && !uri.fragment);
}

function parseEntry(value) {
  if (!value || typeof value.uri !== 'string' ||
      (value.type !== 'file' && value.type !== 'folder')) return undefined;
  try {
    const uri = vscode.Uri.parse(value.uri, true);
    return isResourceUri(uri) ? { uri: uri.toString(), type: value.type } : undefined;
  } catch {
    return undefined;
  }
}

function resourceType(stat) {
  if (stat.type & vscode.FileType.Directory) return 'folder';
  if (stat.type & vscode.FileType.File) return 'file';
  return undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function activate(context) {
  const provider = new QuicklistProvider(context.workspaceState);
  const view = vscode.window.createTreeView('quicklist', { treeDataProvider: provider });

  // Catch write failures at the command boundary, including inline removal.
  const register = (name, handler) => vscode.commands.registerCommand(name, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update Quicklist: ${errorMessage(error)}`);
      return undefined;
    }
  });

  context.subscriptions.push(
    provider,
    view,
    register('quicklist.addCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.isUntitled) {
        void vscode.window.showInformationMessage('Open a saved workspace file to add it to Quicklist.');
        return;
      }
      return addWithFeedback(provider, [editor.document.uri]);
    }),
    register('quicklist.addFromExplorer', (uri, selectedUris) => {
      // Ignore a stale multi-selection when its right-click target is not selected.
      const selected = Array.isArray(selectedUris) && selectedUris.length &&
        (!uri || selectedUris.some((value) => isResourceUri(value) &&
          value.toString() === uri.toString()));
      const targets = selected ? selectedUris.slice() : uri ? [uri] : [];
      return targets.length ? addWithFeedback(provider, targets) : undefined;
    }),
    register('quicklist.remove', (entry) => {
      if (entry && typeof entry.uri === 'string') return provider.remove(entry.uri);
      return undefined;
    }),
    register('quicklist.refresh', () => provider.refresh()),
    register('quicklist.open', async (value) => {
      const entry = parseEntry(value);
      if (!entry) return;
      const uri = vscode.Uri.parse(entry.uri);
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        void vscode.window.showWarningMessage('This shortcut is outside the current workspace.');
        provider.refresh();
        return;
      }
      try {
        const type = resourceType(await vscode.workspace.fs.stat(uri));
        if (!type) throw new Error('The resource is not a file or folder.');
        await vscode.commands.executeCommand(type === 'folder' ? 'revealInExplorer' : 'vscode.open', uri);
      } catch (error) {
        void vscode.window.showWarningMessage(`Unable to open ${uri.path}: ${errorMessage(error)}`);
        provider.refresh();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => provider.refresh()),
    vscode.workspace.onDidDeleteFiles(() => provider.refresh()),
    vscode.workspace.onDidRenameFiles(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) provider.refresh();
    }),
    view.onDidChangeVisibility((event) => {
      if (event.visible) provider.refresh();
    })
  );

  // A read-only snapshot is also useful to extension-host integration tests.
  return Object.freeze({ getItems: () => provider.items });
}

async function addWithFeedback(provider, uris) {
  const result = await provider.addMany(uris);
  // Keep successful additions and duplicates silent, but report skipped targets
  // even when other members of a multi-selection were added successfully.
  const skipped = [];
  if (result.outside) skipped.push(`${result.outside} outside the workspace`);
  if (result.unavailable) skipped.push(`${result.unavailable} unavailable or unsupported`);
  if (skipped.length) {
    void vscode.window.showWarningMessage(`Quicklist skipped ${skipped.join('; ')}.`);
  }
  return result;
}

class QuicklistProvider {
  constructor(workspaceState) {
    this.workspaceState = workspaceState;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._pendingWrite = Promise.resolve();
    this._disposed = false;
  }

  dispose() {
    this._disposed = true;
    this._onDidChangeTreeData.dispose();
  }

  /** @returns {Entry[]} New objects prevent consumers from mutating stored state. */
  get items() {
    const saved = this.workspaceState.get(STATE_KEY, []);
    if (!Array.isArray(saved)) return [];
    const seen = new Set();
    const items = [];
    for (const value of saved) {
      const entry = parseEntry(value);
      if (entry && !seen.has(entry.uri)) {
        seen.add(entry.uri);
        items.push(entry);
      }
    }
    return items;
  }

  refresh() {
    if (!this._disposed) this._onDidChangeTreeData.fire();
  }

  // Queue validation as well as persistence: a slow remote stat must not let a
  // later click overtake an earlier one. A failed write must not poison the queue.
  _enqueue(operation) {
    const pending = this._pendingWrite.then(operation);
    this._pendingWrite = pending.catch(() => {});
    return pending;
  }

  async _save(items) {
    await this.workspaceState.update(STATE_KEY, items);
    this.refresh();
  }

  addMany(uris) {
    const targets = Array.isArray(uris) ? uris.slice() : [];
    return this._enqueue(async () => {
      const result = { added: 0, duplicates: 0, outside: 0, unavailable: 0 };
      const next = this.items;
      const known = new Set(next.map((entry) => entry.uri));
      for (const uri of targets) {
        if (!isResourceUri(uri)) {
          result.unavailable++;
          continue;
        }
        if (!vscode.workspace.getWorkspaceFolder(uri)) {
          result.outside++;
          continue;
        }
        const key = uri.toString();
        if (known.has(key)) {
          result.duplicates++;
          continue;
        }
        try {
          const type = resourceType(await vscode.workspace.fs.stat(uri));
          if (!type) {
            result.unavailable++;
            continue;
          }
          next.push({ uri: key, type });
          known.add(key);
          result.added++;
        } catch {
          result.unavailable++;
        }
      }
      if (result.added) await this._save(next);
      return result;
    });
  }

  remove(uriString) {
    return this._enqueue(async () => {
      const previous = this.items;
      const next = previous.filter((entry) => entry.uri !== uriString);
      if (next.length !== previous.length) await this._save(next);
    });
  }

  getChildren(element) {
    return element ? [] : this.items;
  }

  getParent() {
    return undefined;
  }

  async getTreeItem(entry) {
    const uri = vscode.Uri.parse(entry.uri);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = entry.uri;
    item.resourceUri = uri;
    item.contextValue = 'quicklistEntry';
    item.tooltip = uri.toString(true);
    const multiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
    const relative = vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
    const parent = path.posix.dirname(relative);
    if (parent !== '.') item.description = parent;
    item.iconPath = entry.type === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.command = {
      command: 'quicklist.open',
      title: entry.type === 'folder' ? 'Reveal in Explorer' : 'Open File',
      arguments: [entry],
    };

    let status;
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      status = 'outside workspace';
    } else {
      try {
        const type = resourceType(await vscode.workspace.fs.stat(uri));
        if (!type) status = 'unsupported';
        else item.iconPath = type === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      } catch (error) {
        status = error?.code === 'FileNotFound' ? 'missing' : 'unavailable';
      }
    }
    if (status) {
      item.iconPath = new vscode.ThemeIcon('warning');
      item.description = item.description ? `${item.description} - ${status}` : status;
    }
    return item;
  }
}

module.exports = { activate, QuicklistProvider, STATE_KEY };
