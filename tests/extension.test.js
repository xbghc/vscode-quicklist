'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');
const { makeHarness } = require('./helpers/harness');

const keys = (h) => h.provider.items.map((entry) => entry.uri);

test('manifest contributes one Quicklist view and only a plus button in its title', () => {
  assert.equal(manifest.name, 'quicklist');
  assert.equal(manifest.displayName, 'Quicklist');
  assert.equal(manifest.publisher, 'xbghc');
  assert.deepEqual(manifest.contributes.views, { explorer: [{ id: 'quicklist', name: 'Quicklist' }] });
  const menu = manifest.contributes.menus['view/title'];
  assert.equal(menu.filter((item) => item.group.startsWith('navigation')).length, 1);
  assert.equal(menu[0].command, 'quicklist.addCurrentFile');
  assert.ok(menu.every((item) => item.when === 'view == quicklist'));
  assert.equal(manifest.contributes.menus['view/item/context'].length, 1);
  assert.equal(manifest.contributes.viewsContainers, undefined);
  assert.equal(manifest.contributes.configuration, undefined);
  assert.equal(manifest.dependencies, undefined);
});

test('all contributed commands are registered and context-only commands stay out of the palette', () => {
  const h = makeHarness();
  for (const command of manifest.contributes.commands) assert.ok(h.commands.has(command.command));
  assert.deepEqual(manifest.contributes.menus.commandPalette, [
    { command: 'quicklist.addFromExplorer', when: 'false' },
    { command: 'quicklist.remove', when: 'false' },
  ]);
  h.dispose();
  assert.equal(h.commands.size, 0);
});

test('plus adds the active saved file silently and preserves insertion order', async () => {
  const h = makeHarness();
  const first = h.resource('/project/z.ts');
  const second = h.resource('/project/a.ts');
  for (const uri of [first, second, first]) { h.active(uri); await h.call('addCurrentFile'); }
  assert.deepEqual(keys(h), [first.toString(), second.toString()]);
  assert.equal(h.writes, 2);
  assert.deepEqual([h.info, h.warnings, h.errors], [[], [], []]);
});

test('workspace state restores the list after a new activation', async () => {
  const h = makeHarness();
  await h.call('addFromExplorer', h.resource('/project/src/a.ts'));
  const restored = makeHarness({ state: h.state });
  assert.deepEqual(restored.api.getItems(), h.api.getItems());
});

test('different workspaces keep separate persistent lists', async () => {
  const a = makeHarness({ roots: ['file:///alpha'] });
  const b = makeHarness({ roots: ['file:///beta'] });
  await a.call('addFromExplorer', a.resource('/alpha/a.ts'));
  await b.call('addFromExplorer', b.resource('/beta/b.ts'));
  assert.equal(a.provider.items.length, 1);
  assert.equal(b.provider.items.length, 1);
  assert.notDeepEqual(keys(a), keys(b));
});

test('no active editor and an untitled editor give guidance without adding an entry', async () => {
  const h = makeHarness();
  await h.call('addCurrentFile');
  h.active(new h.vscode.Uri('untitled', '/Untitled-1'), true);
  await h.call('addCurrentFile');
  assert.equal(h.info.length, 2);
  assert.equal(h.provider.items.length, 0);
  assert.equal(h.writes, 0);
});

test('an empty workspace and external files are rejected', async () => {
  const empty = makeHarness({ roots: [] });
  await empty.call('addFromExplorer', empty.resource('/elsewhere/a.ts'));
  assert.equal(empty.provider.items.length, 0);
  assert.match(empty.warnings[0], /outside the workspace/);
  const h = makeHarness();
  await h.call('addFromExplorer', h.resource('/project-other/a.ts'));
  assert.equal(h.provider.items.length, 0);
});

test('unavailable and unknown resource types are skipped without storing placeholders', async () => {
  const h = makeHarness();
  const missing = new h.vscode.Uri('file', '/project/missing.ts');
  const unknown = h.resource('/project/unknown', 0);
  const result = await h.provider.addMany([missing, unknown, null]);
  assert.equal(result.unavailable, 3);
  assert.equal(h.writes, 0);
});

test('a dirty but already saved file can be added', async () => {
  const h = makeHarness();
  h.active(h.resource('/project/dirty.ts'));
  h.vscode.window.activeTextEditor.document.isDirty = true;
  await h.call('addCurrentFile');
  assert.equal(h.provider.items.length, 1);
});

test('Explorer multi-selection adds files and folders in the supplied order', async () => {
  const h = makeHarness();
  const file = h.resource('/project/a.ts');
  const folder = h.resource('/project/components', 2);
  await h.call('addFromExplorer', file, [folder, file]);
  assert.deepEqual(h.provider.items.map((entry) => entry.type), ['folder', 'file']);
  assert.deepEqual(keys(h), [folder.toString(), file.toString()]);
});

test('right-clicking an unselected resource does not add a stale selection', async () => {
  const h = makeHarness();
  const selected = h.resource('/project/selected.ts');
  const clicked = h.resource('/project/clicked.ts');
  await h.call('addFromExplorer', clicked, [selected]);
  assert.deepEqual(keys(h), [clicked.toString()]);
});

test('missing context-menu arguments and missing remove arguments are harmless', async () => {
  const h = makeHarness();
  await h.call('addFromExplorer');
  await h.call('remove');
  await h.call('open', { uri: 'not a URI', type: 'file' });
  assert.equal(h.writes, 0);
  assert.equal(h.errors.length, 0);
});

test('successful and duplicate targets do not hide warnings about skipped targets', async () => {
  const h = makeHarness();
  const file = h.resource('/project/a.ts');
  const outside = h.resource('/external/b.ts');
  const missing = new h.vscode.Uri('file', '/project/missing.ts');
  await h.call('addFromExplorer', file, [file, file, outside, missing]);
  assert.equal(h.provider.items.length, 1);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /1 outside the workspace/);
  assert.match(h.warnings[0], /1 unavailable or unsupported/);
});

test('folder shortcuts are leaf items, not nested file trees', async () => {
  const h = makeHarness();
  await h.call('addFromExplorer', h.resource('/project/src/components', 2));
  const entry = h.provider.items[0];
  const item = await h.provider.getTreeItem(entry);
  assert.equal(item.collapsibleState, 0);
  assert.equal(item.iconPath.id, 'folder');
  assert.equal(item.contextValue, 'quicklistEntry');
  assert.equal(item.description, 'src');
  assert.deepEqual(h.provider.getChildren(entry), []);
  assert.equal(h.provider.getParent(entry), undefined);
});

test('files open in the editor and folders reveal in the native Explorer', async () => {
  const h = makeHarness();
  await h.provider.addMany([h.resource('/project/a.ts'), h.resource('/project/src', 2)]);
  for (const entry of h.provider.items) await h.call('open', entry);
  assert.deepEqual(h.executed.map(([command]) => command), ['vscode.open', 'revealInExplorer']);
});

test('inline removal only changes workspace storage and never deletes a resource', async () => {
  const h = makeHarness();
  const file = h.resource('/project/a.ts');
  await h.call('addFromExplorer', file);
  await h.call('remove', h.provider.items[0]);
  assert.equal(h.provider.items.length, 0);
  assert.ok(h.existing.has(file.toString()));
});

test('multi-root workspaces share a list with root-qualified descriptions', async () => {
  const h = makeHarness({ roots: ['file:///alpha', 'file:///beta'] });
  await h.provider.addMany([h.resource('/alpha/src/a.ts'), h.resource('/beta/src/a.ts')]);
  const items = await Promise.all(h.provider.items.map((entry) => h.provider.getTreeItem(entry)));
  assert.deepEqual(items.map((item) => item.description), ['alpha/src', 'beta/src']);
});

test('remote URI scheme and authority survive persistence and navigation', async () => {
  const h = makeHarness({ roots: ['vscode-remote://ssh-remote+host/project'] });
  const uri = h.resource('vscode-remote://ssh-remote+host/project/file%20%231.ts');
  await h.call('addFromExplorer', uri);
  const entry = h.provider.items[0];
  const item = await h.provider.getTreeItem(entry);
  assert.equal(item.resourceUri.scheme, 'vscode-remote');
  assert.equal(item.resourceUri.authority, 'ssh-remote+host');
  assert.equal(item.resourceUri.path, '/project/file #1.ts');
  await h.call('open', entry);
  assert.equal(h.executed[0][1].toString(), uri.toString());
});

test('identical paths on other remote hosts are outside the workspace', async () => {
  const h = makeHarness({ roots: ['vscode-remote://ssh-remote+host/project'] });
  await h.call('addFromExplorer', h.resource('vscode-remote://ssh-remote+other/project/a.ts'));
  assert.equal(h.provider.items.length, 0);
  assert.match(h.warnings[0], /outside the workspace/);
});

test('reserved characters and non-ASCII names round-trip through the stored URI', async () => {
  const h = makeHarness();
  const uri = h.resource('/project/file #%?\u00e9.ts');
  await h.call('addFromExplorer', uri);
  const entry = h.provider.items[0];
  assert.match(entry.uri, /%23/);
  assert.match(entry.uri, /%25/);
  assert.match(entry.uri, /%3F/);
  assert.equal((await h.provider.getTreeItem(entry)).resourceUri.path, uri.path);
});

test('Windows drive paths are preserved as URIs rather than converted by the host OS', async () => {
  const h = makeHarness({ roots: ['file:///c:/project'] });
  const uri = h.resource('file:///c:/project/src/a.ts');
  await h.call('addFromExplorer', uri);
  assert.equal((await h.provider.getTreeItem(h.provider.items[0])).resourceUri.path, '/c:/project/src/a.ts');
});

test('URI query and fragment resources are rejected as non-file editor references', async () => {
  const h = makeHarness();
  const a = new h.vscode.Uri('file', '/project/a.ts', '', 'revision=1');
  const b = new h.vscode.Uri('file', '/project/a.ts', '', '', 'line=4');
  assert.equal((await h.provider.addMany([a, b])).unavailable, 2);
});

test('file and folder symbolic-link bit flags are accepted', async () => {
  const h = makeHarness();
  await h.provider.addMany([h.resource('/project/link.ts', 65), h.resource('/project/link-dir', 66)]);
  assert.deepEqual(h.provider.items.map((entry) => entry.type), ['file', 'folder']);
});

test('missing shortcuts remain visible and removable, and failed navigation is handled', async () => {
  const h = makeHarness();
  const uri = h.resource('/project/missing.ts');
  await h.call('addFromExplorer', uri);
  h.existing.delete(uri.toString());
  const entry = h.provider.items[0];
  const item = await h.provider.getTreeItem(entry);
  assert.equal(item.iconPath.id, 'warning');
  assert.match(item.description, /missing/);
  await h.call('open', entry);
  assert.equal(h.executed.length, 0);
  assert.equal(h.warnings.length, 1);
  await h.call('remove', entry);
  assert.equal(h.provider.items.length, 0);
});

test('permission errors are marked unavailable, not incorrectly marked missing', async () => {
  const h = makeHarness();
  const uri = h.resource('/project/private.ts');
  await h.call('addFromExplorer', uri);
  h.existing.set(uri.toString(), Object.assign(new Error('Permission denied'), { code: 'NoPermissions' }));
  const item = await h.provider.getTreeItem(h.provider.items[0]);
  assert.match(item.description, /unavailable/);
  assert.doesNotMatch(item.description, /missing/);
});

test('removing a workspace root retains shortcuts but prevents navigating outside the workspace', async () => {
  const h = makeHarness();
  await h.call('addFromExplorer', h.resource('/project/a.ts'));
  h.vscode.workspace.workspaceFolders.length = 0;
  const entry = h.provider.items[0];
  assert.match((await h.provider.getTreeItem(entry)).description, /outside workspace/);
  await h.call('open', entry);
  assert.equal(h.executed.length, 0);
  assert.equal(h.provider.items.length, 1);
});

test('renamed files keep their original shortcut until explicitly removed', async () => {
  const h = makeHarness();
  const uri = h.resource('/project/before.ts');
  await h.call('addFromExplorer', uri);
  h.existing.delete(uri.toString());
  h.resource('/project/after.ts');
  h.events.rename.fire();
  assert.deepEqual(keys(h), [uri.toString()]);
  assert.match((await h.provider.getTreeItem(h.provider.items[0])).description, /missing/);
});

test('slow resource validation cannot reorder rapid additions', async () => {
  const h = makeHarness();
  const a = h.resource('/project/slow.ts');
  const b = h.resource('/project/fast.ts');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stats = [];
  h.statHook = async (uri) => {
    stats.push(uri.toString());
    if (uri.toString() === a.toString()) await gate;
  };
  const first = h.provider.addMany([a]);
  const second = h.provider.addMany([b]);
  await Promise.resolve();
  assert.deepEqual(stats, [a.toString()]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(keys(h), [a.toString(), b.toString()]);
});

test('rapid additions, removals, and re-additions commit in invocation order', async () => {
  const h = makeHarness();
  const a = h.resource('/project/a.ts');
  const b = h.resource('/project/b.ts');
  await Promise.all([
    h.provider.addMany([a]), h.provider.addMany([b]),
    h.provider.remove(a.toString()), h.provider.addMany([a]),
  ]);
  assert.deepEqual(keys(h), [b.toString(), a.toString()]);
});

test('a failed addition leaves persisted state unchanged and the queue recovers', async () => {
  const h = makeHarness();
  const a = h.resource('/project/a.ts');
  h.failNextWrite = true;
  await h.call('addFromExplorer', a);
  assert.equal(h.provider.items.length, 0);
  assert.match(h.errors[0], /Storage write failed/);
  await h.call('addFromExplorer', a);
  assert.deepEqual(keys(h), [a.toString()]);
});

test('a failed inline removal is reported and the shortcut is not lost', async () => {
  const h = makeHarness();
  await h.call('addFromExplorer', h.resource('/project/a.ts'));
  const entry = h.provider.items[0];
  h.failNextWrite = true;
  await h.call('remove', entry);
  assert.equal(h.provider.items.length, 1);
  assert.match(h.errors[0], /Could not update Quicklist/);
  await h.call('remove', entry);
  assert.equal(h.provider.items.length, 0);
});

test('no-op duplicate additions and absent removals do not write storage', async () => {
  const h = makeHarness();
  const a = h.resource('/project/a.ts');
  await h.provider.addMany([a, a]);
  await h.provider.addMany([a]);
  await h.provider.remove('file:///project/absent.ts');
  assert.equal(h.writes, 1);
});

test('malformed persisted records are ignored and duplicates are sanitized in memory', () => {
  const entry = { uri: 'file:///project/a.ts', type: 'file' };
  const state = new Map([['quicklist.items', [
    null, {}, { uri: 'broken', type: 'file' }, { uri: 'file:///project/x', type: 'bad' },
    { uri: 'untitled:/a', type: 'file' }, entry, entry,
  ]]]);
  const h = makeHarness({ state });
  assert.deepEqual(h.provider.items, [entry]);
  assert.equal(h.writes, 0);
  state.set('quicklist.items', {});
  assert.deepEqual(h.provider.items, []);
});

test('returned snapshots cannot mutate persisted entries', async () => {
  const h = makeHarness();
  const uri = h.resource('/project/a.ts');
  await h.call('addFromExplorer', uri);
  const snapshot = h.api.getItems();
  snapshot[0].uri = 'file:///changed';
  snapshot.push({ uri: 'file:///other', type: 'file' });
  assert.deepEqual(keys(h), [uri.toString()]);
});

test('view visibility, focus, workspace, and file-operation events refresh the list', () => {
  const h = makeHarness();
  const emitter = h.provider._onDidChangeTreeData;
  h.events.create.fire(); h.events.delete.fire(); h.events.rename.fire(); h.events.workspaceFolders.fire();
  h.events.viewVisibility.fire({ visible: true });
  h.events.windowState.fire({ focused: true });
  h.events.viewVisibility.fire({ visible: false });
  h.events.windowState.fire({ focused: false });
  assert.equal(emitter.count, 6);
  h.dispose();
  h.events.create.fire();
  h.provider.refresh();
  assert.equal(emitter.count, 6);
  assert.equal(emitter.disposed, true);
});
