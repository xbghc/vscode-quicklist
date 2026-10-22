'use strict';

const fs = require('node:fs');
const path = require('node:path');

function makeHarness({ state = new Map(), roots = ['file:///project'] } = {}) {
  const h = {
    state, commands: new Map(), executed: [], info: [], warnings: [], errors: [],
    existing: new Map(), events: {}, writes: 0, failNextWrite: false, statHook: undefined,
    inputs: [], picks: [], inputOptions: [], pickOptions: [], reveals: [],
  };
  class Uri {
    constructor(scheme, pathName, authority = '', query = '', fragment = '') {
      Object.assign(this, { scheme, path: pathName, authority, query, fragment });
    }
    toString(skipEncoding = false) {
      const pathname = skipEncoding ? this.path : this.path.split('/').map(encodeURIComponent).join('/');
      return `${this.scheme}://${this.authority}${pathname}` +
        (this.query ? `?${this.query}` : '') + (this.fragment ? `#${this.fragment}` : '');
    }
    static parse(value) {
      const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
      if (!match) throw new Error('Invalid URI');
      return new Uri(match[1], decodeURIComponent(match[3]), match[2] || '', match[4] || '', match[5] || '');
    }
  }
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.count = 0;
      this.disposed = false;
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(value) {
      this.count++;
      for (const listener of this.listeners) listener(value);
    }
    dispose() { this.disposed = true; this.listeners.clear(); }
  }
  const event = (name) => {
    const emitter = new EventEmitter();
    h.events[name] = emitter;
    return emitter.event;
  };
  class TreeItem {
    constructor(uri, collapsibleState) {
      this.label = typeof uri === 'string' ? uri : path.posix.basename(uri.path);
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    constructor(id) { this.id = id; }
  }
  ThemeIcon.File = new ThemeIcon('file');
  ThemeIcon.Folder = new ThemeIcon('folder');
  const workspaceFolders = roots.map((value) => {
    const uri = Uri.parse(value);
    return { uri, name: path.posix.basename(uri.path) };
  });
  const getWorkspaceFolder = (uri) => workspaceFolders.filter(({ uri: root }) =>
    root.scheme === uri.scheme && root.authority === uri.authority &&
    (uri.path === root.path || uri.path.startsWith(root.path.replace(/\/$/, '') + '/'))
  ).sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
  h.vscode = {
    Uri, EventEmitter, TreeItem, ThemeIcon,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    commands: {
      registerCommand(name, handler) {
        h.commands.set(name, handler);
        return { dispose: () => h.commands.delete(name) };
      },
      async executeCommand(name, ...args) {
        h.executed.push([name, ...args]);
        if (h.commands.has(name)) return h.commands.get(name)(...args);
      },
    },
    window: {
      activeTextEditor: undefined,
      createTreeView(id, options) {
        h.view = { id, provider: options.treeDataProvider,
          reveal: async (entry, options) => { h.reveals.push([entry, options]); },
          onDidChangeVisibility: event('viewVisibility'), dispose() {} };
        return h.view;
      },
      showInformationMessage: (text) => { h.info.push(text); return Promise.resolve(); },
      showWarningMessage: (text) => { h.warnings.push(text); return Promise.resolve(); },
      showErrorMessage: (text) => { h.errors.push(text); return Promise.resolve(); },
      showInputBox: async (options) => { h.inputOptions.push(options); return h.inputs.shift(); },
      showQuickPick: async (items, options) => {
        h.pickOptions.push({ items, options });
        const pick = h.picks.shift();
        return typeof pick === 'function' ? pick(items) : pick;
      },
      onDidChangeWindowState: event('windowState'),
    },
    workspace: {
      workspaceFolders, getWorkspaceFolder,
      asRelativePath(uri, includeRoot) {
        const root = getWorkspaceFolder(uri);
        if (!root) return uri.path;
        const relative = uri.path.slice(root.uri.path.length).replace(/^\//, '');
        return includeRoot ? `${root.name}/${relative}` : relative || root.name;
      },
      fs: {
        async stat(uri) {
          if (h.statHook) await h.statHook(uri);
          const value = h.existing.get(uri.toString());
          if (value instanceof Error) throw value;
          if (value === undefined) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
          return { type: value };
        },
        async delete() { throw new Error('The extension must never delete resources.'); },
        async writeFile() { throw new Error('The extension must never write project files.'); },
      },
      onDidCreateFiles: event('create'),
      onDidDeleteFiles: event('delete'),
      onDidRenameFiles: event('rename'),
      onDidChangeWorkspaceFolders: event('workspaceFolders'),
    },
  };
  h.context = {
    subscriptions: [],
    workspaceState: {
      get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
      async update(key, value) {
        await Promise.resolve();
        if (h.failNextWrite) {
          h.failNextWrite = false;
          throw new Error('Storage write failed');
        }
        h.writes++;
        state.set(key, structuredClone(value));
      },
    },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../extension.js'), 'utf8');
  // Isolate the injected VS Code API without mutating Node's global module loader.
  new Function('require', 'module', 'exports', source)(
    (id) => id === 'vscode' ? h.vscode : require(id), module, module.exports
  );
  h.extension = module.exports;
  h.api = h.extension.activate(h.context);
  h.provider = h.view.provider;
  h.call = (name, ...args) => h.commands.get(`quicklist.${name}`)(...args);
  h.resource = (name, type = 1) => {
    const uri = name.includes('://') ? Uri.parse(name) : new Uri('file', name);
    h.existing.set(uri.toString(), type);
    return uri;
  };
  h.active = (uri, isUntitled = false) => {
    h.vscode.window.activeTextEditor = { document: { uri, isUntitled } };
  };
  h.dispose = () => h.context.subscriptions.forEach((value) => value.dispose());
  return h;
}

module.exports = { makeHarness };
