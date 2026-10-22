'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./helpers/harness');

test('new-folder command creates, reveals, and restores a folder alongside existing shortcuts', async () => {
  const h = makeHarness();
  const file = h.resource('/project/a.ts');
  await h.call('addFromExplorer', file);
  await h.call('newFolder');
  assert.equal(h.writes, 1, 'A draft must not create a folder in storage.');
  await h.edit('  Work  ');
  const [entry, group] = h.provider.getChildren();
  assert.equal(entry.uri, file.toString());
  assert.equal(group.name, 'Work');
  const item = await h.provider.getTreeItem(group);
  assert.equal(item.label, 'Work');
  assert.equal(item.collapsibleState, h.vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(item.contextValue, 'quicklistGroup');
  assert.equal(item.command, undefined);
  assert.deepEqual(h.messages.at(-1), { type: 'reveal', key: `group:${group.id}` });
  assert.equal(h.inputOptions.length, 0);
  assert.deepEqual(makeHarness({ state: h.state }).api.getItems(), h.api.getItems());
});

test('nested folders accept an active file and preserve its editor navigation', async () => {
  const h = makeHarness();
  await h.call('newFolder');
  await h.edit('Work');
  const group = h.provider.items[0];
  await h.call('newFolder', group);
  await h.edit('Frontend');
  const child = h.provider.getChildren(group)[0];
  const uri = h.resource('/project/src/a.ts');
  h.active(uri);
  await h.call('addCurrentFile', child);
  const entry = h.provider.getChildren(child)[0];
  assert.equal(entry.uri, uri.toString());
  assert.deepEqual(h.provider.getChildren(), [group]);
  assert.deepEqual(h.provider.getParent(child), group);
  assert.deepEqual(h.provider.getParent(entry), child);
  await h.call('open', entry);
  assert.equal(h.executed.at(-1)[0], 'vscode.open');
  assert.equal(h.executed.at(-1)[1].toString(), uri.toString());
  const restored = makeHarness({ state: h.state });
  assert.deepEqual(restored.provider.getChildren(child), [entry]);
  // Adding a URI again does not duplicate it or silently change its folder.
  await h.call('addFromExplorer', uri);
  assert.deepEqual(h.provider.getChildren(child), [entry]);
});

test('moving files and real folder shortcuts into and out of groups preserves resource identity', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Work');
  await h.provider.addMany([h.resource('/project/a.ts'), h.resource('/project/src', 2)]);
  const resources = h.provider.items.filter((entry) => entry.uri);
  for (const entry of resources) {
    h.picks.push((items) => items.find((target) => target.parentId === group.id));
    await h.call('moveToFolder', entry);
  }
  assert.deepEqual(h.provider.getChildren(), [group]);
  assert.deepEqual(h.provider.getChildren(group).map((entry) => entry.uri), resources.map((entry) => entry.uri));
  await h.call('open', h.provider.getChildren(group)[1]);
  assert.equal(h.executed.at(-1)[0], 'revealInExplorer');
  h.picks.push((items) => items.find((target) => target.parentId === undefined));
  await h.call('moveToFolder', resources[0]);
  assert.equal(h.provider.getChildren()[1].uri, resources[0].uri);
  assert.equal(h.provider.getParent(resources[0]), undefined);
  assert.equal(h.existing.size, 2);
});

test('moving a group moves its subtree and excludes itself and descendants as destinations', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  const b = await h.provider.createGroup('B', a.id);
  const c = await h.provider.createGroup('C', b.id);
  const destination = await h.provider.createGroup('Destination');
  await h.provider.addMany([h.resource('/project/a.ts')], c.id);
  assert.deepEqual(h.provider.moveTargets(a).map((target) => target.parentId), [destination.id]);
  assert.ok(h.provider.moveTargets(destination).some((target) => target.label === 'A / B / C'));
  await assert.rejects(h.provider.move(a, c.id), /subfolders/);
  await assert.rejects(h.provider.move(a, a.id), /itself/);
  await h.provider.move(a, destination.id);
  assert.deepEqual(h.provider.getChildren(), [destination]);
  assert.equal(h.provider.getParent(a).id, destination.id);
  assert.equal(h.provider.getParent(b).id, a.id);
  assert.equal(h.provider.getChildren(c)[0].uri, 'file:///project/a.ts');
});

test('renaming folders trims names, preserves stable IDs, and validates sibling names', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  await h.provider.createGroup('B');
  const child = await h.provider.createGroup('B', a.id);
  await h.call('renameFolder', a);
  await h.edit('  Renamed  ');
  const renamed = h.provider.items.find((item) => item.id === a.id);
  assert.equal(renamed.name, 'Renamed');
  assert.equal(h.provider.getParent(child).name, 'Renamed');
  assert.equal((await h.provider.getTreeItem(a)).id, (await h.provider.getTreeItem(renamed)).id);
  await assert.rejects(h.provider.renameGroup(a.id, 'b'), /already exists/);
  await assert.rejects(h.provider.createGroup('  '), /Enter a folder name/);
  await assert.rejects(h.provider.createGroup('x\ny'), /single line/);
  await assert.rejects(h.provider.createGroup('x'.repeat(101)), /100 characters/);
  await assert.rejects(h.provider.createGroup('B'), /already exists/);
  assert.equal(h.inputOptions.length, 0);
});

test('moving a group rejects duplicate destination names without changing storage', async () => {
  const h = makeHarness();
  const a = await h.provider.createGroup('A');
  const b = await h.provider.createGroup('B');
  const nested = await h.provider.createGroup('A', b.id);
  const before = h.api.getItems();
  assert.ok(!h.provider.moveTargets(nested).some((target) => target.parentId === undefined));
  await assert.rejects(h.provider.move(nested, undefined), /already exists/);
  assert.deepEqual(h.api.getItems(), before);
  await h.provider.renameGroup(a.id, 'Other');
  await h.provider.move(nested, undefined);
  assert.equal(h.provider.getParent(nested), undefined);
});

test('removing a group promotes its contents and resolves sibling folder name collisions', async () => {
  const h = makeHarness();
  const parent = await h.provider.createGroup('Parent');
  const rootPeer = await h.provider.createGroup('Child');
  const child = await h.provider.createGroup('Child', parent.id);
  const grandchild = await h.provider.createGroup('Nested', child.id);
  const file = h.resource('/project/a.ts');
  await h.provider.addMany([file], parent.id);
  await h.call('removeFolder', parent);
  const promoted = h.provider.items.find((item) => item.id === child.id);
  assert.equal(promoted.name, 'Child (2)');
  assert.deepEqual(h.provider.getChildren().map((item) => item.id || item.uri),
    [rootPeer.id, child.id, file.toString()]);
  assert.deepEqual(h.provider.getParent(grandchild), promoted);
  assert.equal(h.existing.size, 1);
  await h.call('removeFolder', promoted);
  assert.equal(h.provider.getParent(grandchild), undefined);
  assert.equal(h.provider.items.filter((item) => item.uri).length, 1);
});

test('removing a nested group promotes its files into the containing group', async () => {
  const h = makeHarness();
  const parent = await h.provider.createGroup('Parent');
  const child = await h.provider.createGroup('Child', parent.id);
  const file = h.resource('/project/a.ts');
  await h.provider.addMany([file], child.id);
  await h.call('removeFolder', child);
  const entry = h.provider.getChildren(parent)[0];
  assert.equal(entry.uri, file.toString());
  assert.deepEqual(h.provider.getParent(entry), parent);
  await h.call('remove', entry);
  assert.deepEqual(h.provider.items, [parent]);
  assert.equal(h.existing.size, 1);
});

test('cancelling inline folder edits and no-op operations do not write storage', async () => {
  const h = makeHarness();
  await h.call('newFolder');
  await h.cancel();
  assert.equal(h.writes, 0);
  const group = await h.provider.createGroup('Work');
  await h.call('renameFolder', group);
  await h.cancel();
  await h.call('moveToFolder', group);
  await h.provider.renameGroup(group.id, ' Work ');
  await h.provider.move(group, undefined);
  await h.provider.removeGroup('absent');
  await h.call('renameFolder');
  await h.call('moveToFolder');
  assert.equal(h.writes, 1);
  const empty = makeHarness({ roots: [] });
  await empty.call('newFolder');
  assert.equal(empty.inputOptions.length, 0);
  assert.equal(empty.writes, 0);
  assert.match(empty.info[0], /Open a folder or workspace/);
});

test('queued folder mutations validate current state and recover from failed persistence', async () => {
  const h = makeHarness();
  const attempts = await Promise.allSettled([
    h.provider.createGroup('Work'), h.provider.createGroup('work'),
  ]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  const group = attempts[0].value;
  await h.provider.addMany([h.resource('/project/a.ts')]);
  const entry = h.provider.items[1];
  const before = h.api.getItems();
  for (const operation of [
    () => h.provider.renameGroup(group.id, 'Other'),
    () => h.provider.move(entry, group.id),
    () => h.provider.removeGroup(group.id),
    () => h.provider.createGroup('New'),
  ]) {
    h.failNextWrite = true;
    await assert.rejects(operation(), /Storage write failed/);
    assert.deepEqual(h.api.getItems(), before);
  }
  await h.provider.move(entry, group.id);
  assert.equal(h.provider.getChildren(group).length, 1);
});

test('stale folder destinations do not lose or redirect shortcuts', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Work');
  await h.provider.addMany([h.resource('/project/a.ts')]);
  const entry = h.provider.items[1];
  await h.provider.removeGroup(group.id);
  await assert.rejects(h.provider.move(entry, group.id), /no longer exists/);
  await assert.rejects(h.provider.createGroup('Child', group.id), /no longer exists/);
  h.active(h.resource('/project/b.ts'));
  await h.call('addCurrentFile', group);
  assert.equal(h.provider.items.length, 1);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.provider.getChildren(group), []);
});

test('legacy records and malformed folder links remain reachable without rewriting state on read', () => {
  const old = { uri: 'file:///project/old.ts', type: 'file' };
  const state = new Map([['quicklist.items', [
    old,
    { type: 'group', id: 'a', name: 'A', parentId: 'b' },
    { type: 'group', id: 'b', name: 'B', parentId: 'a' },
    { type: 'group', id: 'self', name: 'Self', parentId: 'self' },
    { uri: 'file:///project/orphan.ts', type: 'file', parentId: 'absent' },
    { type: 'group', id: 'orphan', name: 'Orphan', parentId: 'absent' },
    { type: 'group', id: 'a', name: 'Duplicate' },
    { type: 'group', id: 'invalid', name: '' },
    { type: 'group', name: 'No id' },
  ]]]);
  const h = makeHarness({ state });
  const visited = [];
  const visit = (parent) => {
    for (const item of h.provider.getChildren(parent)) {
      assert.ok(!visited.some((seen) => item.id ? seen.id === item.id : seen.uri === item.uri));
      visited.push(item);
      if (item.type === 'group') visit(item);
    }
  };
  visit();
  assert.equal(visited.length, 6);
  assert.ok(h.provider.getChildren().some((item) => item.uri === old.uri));
  assert.equal(h.writes, 0);
});

test('folder snapshots do not mutate storage and workspaces keep separate hierarchies', async () => {
  const h = makeHarness();
  const group = await h.provider.createGroup('Work');
  await h.provider.createGroup('Child', group.id);
  const snapshot = h.api.getItems();
  snapshot[0].name = 'Changed';
  snapshot[1].parentId = 'absent';
  assert.equal(h.provider.getChildren()[0].name, 'Work');
  assert.equal(h.provider.getChildren(group).length, 1);
  assert.deepEqual(makeHarness({ roots: ['file:///other'] }).provider.items, []);
});
