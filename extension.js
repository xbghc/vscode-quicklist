'use strict';

// Adapted from leandrosilva/vscode-favorites-explorer (MIT, 2026).
// Original copyright and permission terms are retained in LICENSE.
const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STATE_KEY = 'quicklist.items';

/** @typedef {{ uri: string, type: 'file' | 'folder', parentId?: string }} Entry */
/** @typedef {{ id: string, type: 'group', name: string, parentId?: string }} Group */

function withParent(item, value) {
  if (typeof value.parentId === 'string' && value.parentId) item.parentId = value.parentId;
  return item;
}

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
    return isResourceUri(uri) ? withParent({ uri: uri.toString(), type: value.type }, value) : undefined;
  } catch {
    return undefined;
  }
}

function parseItem(value) {
  if (value?.type !== 'group') return parseEntry(value);
  if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' ||
      !value.name.trim() || value.name.trim().length > 100 || /[\r\n]/.test(value.name)) return undefined;
  return withParent({ id: value.id, type: 'group', name: value.name.trim() }, value);
}

function sameItem(a, b) {
  return a?.type === 'group' ? b?.type === 'group' && a.id === b.id :
    Boolean(a?.uri && b?.type !== 'group' && a.uri === b?.uri);
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
    register('quicklist.addCurrentFile', async (group) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.isUntitled) {
        void vscode.window.showInformationMessage('Open a saved workspace file to add it to Quicklist.');
        return;
      }
      return addWithFeedback(provider, [editor.document.uri], group?.type === 'group' ? group.id : undefined);
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
      if (entry?.type === 'group') return provider.removeGroup(entry.id);
      if (entry && typeof entry.uri === 'string') return provider.remove(entry.uri);
      return undefined;
    }),
    register('quicklist.newFolder', async (parent) => {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showInformationMessage('Open a folder or workspace to create a Quicklist folder.');
        return;
      }
      const parentId = parent?.type === 'group' ? parent.id : undefined;
      const name = await vscode.window.showInputBox({
        title: 'New Quicklist Folder', prompt: 'Name this folder for organizing shortcuts.',
        validateInput: (value) => provider.validateGroupName(value, parentId),
      });
      if (name === undefined) return;
      const group = await provider.createGroup(name, parentId);
      await view.reveal(group, { select: true, focus: true, expand: true });
    }),
    register('quicklist.renameFolder', async (group) => {
      const current = provider.items.find((item) => item.type === 'group' && sameItem(item, group));
      if (!current) return;
      const name = await vscode.window.showInputBox({
        title: 'Rename Quicklist Folder', value: current.name,
        validateInput: (value) => provider.validateGroupName(value, current.parentId, current.id),
      });
      if (name !== undefined) return provider.renameGroup(current.id, name);
    }),
    register('quicklist.moveToFolder', async (entry) => {
      const current = provider.items.find((item) => sameItem(item, entry));
      if (!current) return;
      const target = await vscode.window.showQuickPick(provider.moveTargets(current), {
        title: 'Move to Quicklist Folder', placeHolder: 'Choose a destination folder',
      });
      if (target) return provider.move(current, target.parentId);
    }),
    register('quicklist.removeFolder', (group) => {
      if (group?.type === 'group') return provider.removeGroup(group.id);
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

async function addWithFeedback(provider, uris, parentId) {
  const result = await provider.addMany(uris, parentId);
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

  /** @returns {(Entry | Group)[]} New objects prevent consumers from mutating stored state. */
  get items() {
    const saved = this.workspaceState.get(STATE_KEY, []);
    if (!Array.isArray(saved)) return [];
    const seen = new Set();
    const items = [];
    for (const value of saved) {
      const entry = parseItem(value);
      const key = entry?.type === 'group' ? `group:${entry.id}` : `resource:${entry?.uri}`;
      if (entry && !seen.has(key)) {
        seen.add(key);
        items.push(entry);
      }
    }
    // Old flat lists need no migration. Recover orphaned or cyclic records at
    // the root so corrupt folder metadata never hides an existing shortcut.
    const groups = new Map(items.filter((item) => item.type === 'group').map((item) => [item.id, item]));
    for (const item of items) {
      const ancestors = new Set(item.type === 'group' ? [item.id] : []);
      let parentId = item.parentId;
      while (parentId) {
        if (!groups.has(parentId) || ancestors.has(parentId)) {
          delete item.parentId;
          break;
        }
        ancestors.add(parentId);
        parentId = groups.get(parentId).parentId;
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

  addMany(uris, parentId) {
    const targets = Array.isArray(uris) ? uris.slice() : [];
    return this._enqueue(async () => {
      const result = { added: 0, duplicates: 0, outside: 0, unavailable: 0 };
      const next = this.items;
      this._requireGroup(next, parentId);
      const known = new Set(next.filter((entry) => entry.type !== 'group').map((entry) => entry.uri));
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
          next.push(withParent({ uri: key, type }, { parentId }));
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

  _requireGroup(items, id) {
    if (id !== undefined && !items.some((item) => item.type === 'group' && item.id === id)) {
      throw new Error('This Quicklist folder no longer exists.');
    }
  }

  validateGroupName(name, parentId, exceptId, items = this.items) {
    if (typeof name !== 'string' || !name.trim()) return 'Enter a folder name.';
    if (name.trim().length > 100 || /[\r\n]/.test(name)) return 'Use a single line of 100 characters or fewer.';
    if (items.some((item) => item.type === 'group' && item.id !== exceptId &&
        item.parentId === parentId && item.name.toLowerCase() === name.trim().toLowerCase())) {
      return 'A folder with this name already exists here.';
    }
    return undefined;
  }

  createGroup(name, parentId) {
    return this._enqueue(async () => {
      const next = this.items;
      this._requireGroup(next, parentId);
      const error = this.validateGroupName(name, parentId, undefined, next);
      if (error) throw new Error(error);
      const group = withParent({ id: randomUUID(), type: 'group', name: name.trim() }, { parentId });
      next.push(group);
      await this._save(next);
      return { ...group };
    });
  }

  renameGroup(id, name) {
    return this._enqueue(async () => {
      const next = this.items;
      const group = next.find((item) => item.type === 'group' && item.id === id);
      if (!group) return;
      const error = this.validateGroupName(name, group.parentId, id, next);
      if (error) throw new Error(error);
      if (group.name === name.trim()) return;
      group.name = name.trim();
      await this._save(next);
    });
  }

  _isDescendant(items, parentId, id) {
    while (parentId) {
      if (parentId === id) return true;
      parentId = items.find((item) => item.type === 'group' && item.id === parentId)?.parentId;
    }
    return false;
  }

  moveTargets(entry) {
    const items = this.items;
    const targets = [{ label: 'Quicklist (root)', parentId: undefined }];
    const visit = (parentId, prefix = '') => {
      for (const group of items.filter((item) => item.type === 'group' && item.parentId === parentId)) {
        if (sameItem(group, entry)) continue;
        const label = prefix + group.name;
        targets.push({ label, parentId: group.id });
        visit(group.id, `${label} / `);
      }
    };
    visit(undefined);
    return targets.filter((target) => target.parentId !== entry.parentId &&
      (entry.type !== 'group' || !this.validateGroupName(entry.name, target.parentId, entry.id, items)));
  }

  move(entry, parentId) {
    return this._enqueue(async () => {
      const next = this.items;
      const current = next.find((item) => sameItem(item, entry));
      if (!current) return;
      this._requireGroup(next, parentId);
      if (current.type === 'group') {
        if (this._isDescendant(next, parentId, current.id)) {
          throw new Error('A folder cannot be moved into itself or one of its subfolders.');
        }
        const error = this.validateGroupName(current.name, parentId, current.id, next);
        if (error) throw new Error(error);
      }
      if (current.parentId === parentId) return;
      delete current.parentId;
      withParent(current, { parentId });
      await this._save(next);
    });
  }

  removeGroup(id) {
    return this._enqueue(async () => {
      const previous = this.items;
      const group = previous.find((item) => item.type === 'group' && item.id === id);
      if (!group) return;
      const next = previous.filter((item) => item !== group);
      for (const item of next.filter((item) => item.parentId === id)) {
        delete item.parentId;
        withParent(item, group);
        // Promoted folders keep their contents and get a unique sibling name.
        if (item.type === 'group') {
          const base = item.name;
          let suffix = 2;
          while (this.validateGroupName(item.name, item.parentId, item.id, next)) {
            const ending = ` (${suffix++})`;
            item.name = base.slice(0, 100 - ending.length) + ending;
          }
        }
      }
      await this._save(next);
    });
  }

  getChildren(element) {
    if (element && element.type !== 'group') return [];
    const items = this.items;
    if (element && !items.some((item) => sameItem(item, element))) return [];
    return items.filter((item) => item.parentId === element?.id);
  }

  getParent(element) {
    const items = this.items;
    const current = items.find((item) => sameItem(item, element));
    return items.find((item) => item.type === 'group' && item.id === current?.parentId);
  }

  async getTreeItem(entry) {
    if (entry.type === 'group') {
      const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${entry.id}`;
      item.contextValue = 'quicklistGroup';
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = `${entry.name} — Quicklist folder`;
      return item;
    }
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
