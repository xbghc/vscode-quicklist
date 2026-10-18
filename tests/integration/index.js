'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('The expected editor state was not reached.');
}

async function run() {
  const extension = vscode.extensions.getExtension('xbghc.quicklist');
  assert.ok(extension, 'Quicklist must be discovered by the extension host.');
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri;
  const first = vscode.Uri.joinPath(root, 'first #.txt');
  const second = vscode.Uri.joinPath(root, 'second.txt');
  const folder = vscode.Uri.joinPath(root, 'components');
  const phase = process.env.QUICKLIST_TEST_PHASE;
  const keys = () => api.getItems().map((entry) => entry.uri);
  const command = (name, ...args) => vscode.commands.executeCommand(`quicklist.${name}`, ...args);

  await command('focus');
  if (phase === 'restart') {
    assert.deepEqual(keys(), [first.toString(), folder.toString()], 'The list must survive a process restart.');
    await command('open', api.getItems()[0]);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === first.toString());
    console.log('PASS: workspace persistence across a real VS Code restart');
    return;
  }

  assert.deepEqual(keys(), [], 'A new workspace must start with an empty list.');
  await vscode.workspace.fs.createDirectory(folder);
  await vscode.workspace.fs.writeFile(first, Buffer.from('First file\n'));
  const document = await vscode.workspace.openTextDocument(first);
  await vscode.window.showTextDocument(document);
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === first.toString());
  await command('addCurrentFile');
  await command('addCurrentFile');
  assert.deepEqual(keys(), [first.toString()], 'The plus command must add once and ignore duplicates.');

  if (phase === 'other-workspace') {
    console.log('PASS: independent list in another workspace using the same VS Code profile');
    return;
  }

  await vscode.workspace.fs.writeFile(second, Buffer.from('Second file\n'));
  await command('addFromExplorer', folder, [folder, second]);
  assert.deepEqual(keys(), [first.toString(), folder.toString(), second.toString()]);
  assert.deepEqual(api.getItems().map((entry) => entry.type), ['file', 'folder', 'file']);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('revealInExplorer'), 'The native Explorer reveal command must exist.');
  await command('open', api.getItems()[1]);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await command('open', api.getItems()[0]);
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === first.toString());

  await command('remove', api.getItems()[2]);
  assert.deepEqual(keys(), [first.toString(), folder.toString()]);
  assert.ok((await vscode.workspace.fs.stat(second)).type & vscode.FileType.File,
    'Removing a shortcut must not remove the underlying file.');
  await command('refresh');
  console.log('PASS: activation, view creation, adding, deduplication, navigation, and non-destructive removal');
}

module.exports = { run };
