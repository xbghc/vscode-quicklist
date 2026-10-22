'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./helpers/harness');

const key = (item) => item.type === 'group' ? `group:${item.id}` : item.uri;
const lastState = (h) => h.messages.filter((message) => message.type === 'state').at(-1);

test('an inline draft survives view loading and cancellation never persists a placeholder', async () => {
  const h = makeHarness();
  await h.call('newFolder');
  const token = h.presenter.editing.token;
  assert.equal(h.writes, 0);
  await h.message({ type: 'ready' });
  assert.equal(lastState(h).editing.token, token);
  assert.deepEqual(lastState(h).items, []);
  await h.cancel();
  assert.equal(lastState(h).editing, undefined);
  assert.equal(h.writes, 0);
  await h.message({ type: 'submitEdit', token, value: 'Late message' });
  assert.equal(h.writes, 0);
  assert.equal(h.inputOptions.length, 0);
});

test('inline validation and write failures keep the entered name available for correction', async () => {
  const h = makeHarness();
  await h.message({ type: 'ready' });
  await h.provider.createGroup('Work');
  await h.call('newFolder');
  await h.edit(' work ');
  assert.match(lastState(h).editing.error, /already exists/);
  assert.equal(lastState(h).editing.value, ' work ');
  assert.equal(h.writes, 1);
  h.failNextWrite = true;
  await h.edit('中文文件夹');
  assert.match(lastState(h).editing.error, /Storage write failed/);
  assert.equal(lastState(h).editing.value, '中文文件夹');
  assert.equal(h.writes, 1);
  await h.edit('中文文件夹');
  assert.equal(lastState(h).editing, undefined);
  assert.equal(h.provider.items[1].name, '中文文件夹');
});

test('duplicate submissions create one folder and nested context actions resolve stored identities', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Parent');
  await h.call('newFolder', { quicklistItem: { id: group.id, type: 'group' } });
  await Promise.all([h.edit('Child'), h.edit('Child')]);
  const child = h.provider.getChildren(group)[0];
  assert.equal(child.name, 'Child');
  assert.equal(h.writes, 2);
  await h.message({ type: 'action', action: 'renameFolder', key: key(child) });
  assert.equal(h.presenter.editing.value, 'Child');
  await h.edit('Renamed');
  assert.equal(h.provider.getChildren(group)[0].id, child.id);
  assert.equal(h.provider.getChildren(group)[0].name, 'Renamed');
});

test('stale rename targets and stale edit tokens never create replacement folders', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Parent');
  await h.call('renameFolder', group);
  const token = h.presenter.editing.token;
  await h.call('newFolder');
  await h.message({ type: 'submitEdit', token, value: 'Stale' });
  assert.equal(h.writes, 1);
  await h.call('renameFolder', group);
  await h.provider.removeGroup(group.id);
  await h.edit('Renamed');
  assert.match(h.presenter.editing.error, /no longer exists/);
  assert.deepEqual(h.provider.items, []);
});

test('webview renders text through messages and restricts local resources and commands', async () => {
  const h = makeHarness();
  await h.provider.createGroup('<img src=x onerror=alert(1)>');
  await h.message({ type: 'ready' });
  assert.equal(lastState(h).items[0].label, '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(h.view.webview.html, /<img/);
  assert.match(h.view.webview.html, /default-src 'none'/);
  assert.equal(h.view.webview.options.localResourceRoots[0].path, '/extension/media');
  await h.message({ type: 'action', action: 'workbench.action.closeWindow' });
  await h.message({ type: 'action', action: 'open', key: 'file:///outside/secret' });
  assert.deepEqual(h.executed, []);
});

test('dragging reorders siblings, moves subtrees, and persists the resulting hierarchy', async () => {
  const h = makeHarness();
  await h.provider.addMany(['a', 'b', 'c'].map((name) => h.resource(`/project/${name}.ts`)));
  const [a, b, c] = h.provider.items;
  await h.message({ type: 'drop', keys: [c.uri], target: a.uri, position: 'before' });
  assert.deepEqual(h.provider.getChildren().map(key), [c.uri, a.uri, b.uri]);
  await h.message({ type: 'drop', keys: [c.uri], target: b.uri, position: 'after' });
  assert.deepEqual(h.provider.getChildren().map(key), [a.uri, b.uri, c.uri]);
  const group = await h.provider.createGroup('Work');
  const nested = await h.provider.createGroup('Nested', group.id);
  await h.message({ type: 'drop', keys: [a.uri, c.uri], target: key(nested), position: 'inside' });
  assert.deepEqual(h.provider.getChildren(nested).map(key), [a.uri, c.uri]);
  await h.provider.drop([group], b, 'before');
  assert.deepEqual(h.provider.getChildren().map(key), [key(group), b.uri]);
  assert.deepEqual(h.provider.getChildren(nested).map(key), [a.uri, c.uri]);
  await h.message({ type: 'drop', keys: [a.uri], position: 'inside' });
  assert.deepEqual(h.provider.getChildren().map(key), [key(group), b.uri, a.uri]);
  assert.deepEqual(makeHarness({ state: h.state }).api.getItems(), h.api.getItems());
});

test('moving a selection with its ancestor keeps descendants in the subtree', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  const child = await h.provider.createGroup('Child', a.id);
  const b = await h.provider.createGroup('B');
  await h.provider.drop([a, child], b, 'inside');
  assert.equal(h.provider.getParent(a).id, b.id);
  assert.equal(h.provider.getParent(child).id, a.id);
});

test('a multi-folder selection follows the visible drag order instead of global storage order', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  const b = await h.provider.createGroup('B');
  const second = h.resource('/project/second.ts');
  const first = h.resource('/project/first.ts');
  await h.provider.addMany([second], b.id);
  await h.provider.addMany([first], a.id);
  const entries = [first, second].map((uri) => h.provider.items.find((item) => item.uri === uri.toString()));
  await h.provider.drop(entries, undefined, 'inside');
  assert.deepEqual(h.provider.getChildren().slice(-2).map(key), [first.toString(), second.toString()]);
});

test('cycles, colliding folder names, invalid targets, and failed writes reject drops atomically', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  const child = await h.provider.createGroup('Child', a.id);
  const b = await h.provider.createGroup('B');
  await h.provider.createGroup('A', b.id);
  await h.provider.addMany([h.resource('/project/a.ts')]);
  const file = h.provider.items.at(-1);
  const before = h.api.getItems();
  for (const [entries, target, position, error] of [
    [[a], child, 'inside', /subfolders/],
    [[a, file], b, 'inside', /already exists/],
    [[a], file, 'inside', /Quicklist folder/],
    [[a], { type: 'group', id: 'absent' }, 'before', /no longer exists/],
    [[a], b, 'invalid', /Invalid drop position/],
  ]) {
    await assert.rejects(h.provider.drop(entries, target, position), error);
    assert.deepEqual(h.api.getItems(), before);
  }
  h.failNextWrite = true;
  await h.message({ type: 'drop', keys: [file.uri], target: key(b), position: 'inside' });
  assert.deepEqual(h.api.getItems(), before);
  assert.match(h.errors[0], /Storage write failed/);
  await h.provider.drop([file], b, 'inside');
  assert.equal(h.provider.getParent(file).id, b.id);
});

test('Explorer drops add files and folders at the target, reject outsiders, and keep duplicates in place', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Work');
  const anchor = h.resource('/project/anchor.ts');
  await h.provider.addMany([anchor], group.id);
  const a = h.resource('/project/a #中文.ts');
  const folder = h.resource('/project/src', 2);
  const outside = h.resource('/outside/other.ts');
  await h.message({ type: 'drop', uris: [a, folder, outside].map(String), target: anchor.toString(), position: 'before' });
  assert.deepEqual(h.provider.getChildren(group).map(key), [a.toString(), folder.toString(), anchor.toString()]);
  assert.match(h.warnings[0], /outside the workspace/);
  const writes = h.writes;
  await h.message({ type: 'drop', uris: [a.toString()], position: 'inside' });
  assert.equal(h.writes, writes);
  assert.equal(h.provider.getParent(h.provider.items.find((item) => item.uri === a.toString())).id, group.id);
  assert.equal(h.existing.size, 4);
});

test('remote Explorer drops preserve the URI and a failed write adds nothing', async () => {
  const h = makeHarness({ roots: ['vscode-remote://ssh-remote+host/project'] });
  const uri = h.resource('vscode-remote://ssh-remote+host/project/a%20%23.ts');
  h.failNextWrite = true;
  await h.message({ type: 'drop', uris: [uri.toString()], position: 'inside' });
  assert.deepEqual(h.api.getItems(), []);
  await h.message({ type: 'drop', uris: [uri.toString()], position: 'inside' });
  assert.equal(h.api.getItems()[0].uri, uri.toString());
});
