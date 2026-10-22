'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

const itemKey = (item) => item.type === 'group' ? `group:${item.id}` : item.uri;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Stable TreeView APIs do not expose editable rows. Keep the model and commands
// in the extension host; the sidebar webview only renders and requests actions.
class QuicklistView {
  constructor(vscode, provider, extensionUri, addWithFeedback) {
    Object.assign(this, { vscode, provider, extensionUri, addWithFeedback });
    this.generation = 0;
    this.disposables = [provider.onDidChangeTreeData(() => { void this.refresh(); })];
  }

  dispose() {
    this.generation++;
    this.view = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposeView();
  }

  disposeView() {
    for (const disposable of this.viewDisposables || []) disposable.dispose();
    this.viewDisposables = [];
    this.ready = false;
  }

  resolveWebviewView(view) {
    this.disposeView();
    this.view = view;
    const { webview } = view;
    const media = this.vscode.Uri.joinPath(this.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomUUID();
    const resource = (name) => escapeHtml(webview.asWebviewUri(this.vscode.Uri.joinPath(media, name)));
    webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('quicklist.css')}"><title>Quicklist</title></head>
<body><main id="tree" role="tree" aria-label="Quicklist" aria-multiselectable="true" tabindex="0"></main>
<p id="empty"></p><div id="root-drop" aria-label="Move to Quicklist root">Quicklist (root)</div>
<p id="drag-help">Hold Shift while dragging from Explorer.</p>
<div id="status" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${resource('quicklist.js')}"></script></body></html>`;
    this.viewDisposables.push(
      webview.onDidReceiveMessage((message) => this.receive(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.provider.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.generation++;
          this.disposeView();
        }
      })
    );
  }

  async refresh() {
    if (!this.ready || !this.view) return;
    const view = this.view;
    const generation = ++this.generation;
    const items = await Promise.all(this.provider.items.map(async (entry) => {
      const item = await this.provider.getTreeItem(entry);
      const label = entry.type === 'group' ? entry.name : path.posix.basename(this.vscode.Uri.parse(entry.uri).path);
      return { ...entry, key: itemKey(entry), label, description: item.description,
        tooltip: item.tooltip, icon: item.iconPath?.id };
    }));
    if (generation !== this.generation || view !== this.view) return;
    await view.webview.postMessage({ type: 'state', items, editing: this.editing,
      hasWorkspace: Boolean(this.vscode.workspace.workspaceFolders?.length) });
  }

  async editFolder({ id, parentId, value = '' }) {
    this.provider._requireGroup(this.provider.items, parentId);
    this.editing = { token: randomUUID(), id, parentId, value };
    await this.vscode.commands.executeCommand('quicklist.focus');
    this.view?.show(false);
    await this.refresh();
  }

  find(key) {
    return this.provider.items.find((item) => itemKey(item) === key);
  }

  async receive(message) {
    if (!message || typeof message !== 'object') return;
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          await this.refresh();
          break;
        case 'cancelEdit':
          if (message.token !== this.editing?.token || this.submitting) return;
          this.editing = undefined;
          await this.refresh();
          break;
        case 'submitEdit': {
          const edit = this.editing;
          if (!edit || message.token !== edit.token || this.submitting || typeof message.value !== 'string') return;
          this.submitting = true;
          delete edit.error;
          try {
            let item;
            if (edit.id) {
              item = this.find(`group:${edit.id}`);
              if (!item) throw new Error('This Quicklist folder no longer exists.');
              await this.provider.renameGroup(edit.id, message.value);
            } else {
              item = await this.provider.createGroup(message.value, edit.parentId);
            }
            if (this.editing === edit) this.editing = undefined;
            await this.refresh();
            await this.view?.webview.postMessage({ type: 'reveal', key: itemKey(item) });
          } catch (error) {
            if (this.editing === edit) {
              edit.value = message.value;
              edit.error = error.message || String(error);
              await this.refresh();
            }
          } finally {
            this.submitting = false;
          }
          break;
        }
        case 'action': {
          // Never execute arbitrary command names supplied by webview content.
          if (!['open', 'remove', 'newFolder', 'renameFolder', 'addCurrentFile', 'moveToFolder', 'removeFolder'].includes(message.action)) return;
          const item = this.find(message.key);
          if (message.key && !item) return;
          await this.vscode.commands.executeCommand(`quicklist.${message.action}`, item);
          break;
        }
        case 'drop': {
          const target = message.target ? this.find(message.target) : undefined;
          if (message.target && !target) throw new Error('The drop destination no longer exists.');
          if (Array.isArray(message.keys)) {
            const entries = message.keys.map((key) => this.find(key)).filter(Boolean);
            await this.provider.drop(entries, target, message.position);
          } else if (Array.isArray(message.uris)) {
            const uris = message.uris.map((value) => {
              try { return typeof value === 'string' ? this.vscode.Uri.parse(value, true) : undefined; }
              catch { return undefined; }
            });
            await this.addWithFeedback(this.provider, uris, undefined, { target, position: message.position });
          }
          await this.view?.webview.postMessage({ type: 'dropped', target: message.target, position: message.position });
          break;
        }
      }
    } catch (error) {
      const text = `Could not update Quicklist: ${error.message || String(error)}`;
      await this.view?.webview.postMessage({ type: 'error', text });
      void this.vscode.window.showErrorMessage(text);
    }
  }
}

module.exports = { QuicklistView };
