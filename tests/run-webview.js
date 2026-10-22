'use strict';

// Exercise the real sidebar DOM and extension-host message handlers in Chromium
// without adding runtime or test dependencies. CI supplies Google Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeHarness } = require('./helpers/harness');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'quicklist-webview-'));
  const h = makeHarness();
  let browser;
  let socket;
  let server;
  try {
    browser = spawn(process.env.QUICKLIST_BROWSER || 'chromium', [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${temp}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser startup timed out.')), 20000);
      let stderr = '';
      browser.once('error', (error) => { clearTimeout(timeout); reject(error); });
      browser.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Browser exited: ${code}\n${stderr}`)); });
      browser.stderr.on('data', (data) => {
        stderr += data;
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
    socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
      } else if (message.method === 'Runtime.bindingCalled') {
        void h.message(JSON.parse(message.params.payload)).catch((error) => errors.push(error.message));
      } else if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(message.params.entry.text);
      }
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(`Timed out: ${predicate.toString()}`);
    };
    h.view.webview.postMessage = async (message) => {
      h.messages.push(message);
      await evaluate(`window.postMessage(${JSON.stringify(message)}, '*')`);
      return true;
    };
    server = http.createServer(async (request, response) => {
      if (request.url === '/') {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const nonce = /nonce="([^"]+)"/.exec(h.view.webview.html)[1];
        const bootstrap = `<script nonce="${nonce}">
          let state; window.acquireVsCodeApi = () => ({ getState: () => state,
            setState: value => { state = value; }, postMessage: value => window.quicklistMessage(JSON.stringify(value)) });
          </script>`;
        const html = h.view.webview.html.replaceAll('file:///extension/media', `${origin}/media`)
          .replaceAll('https://webview.test', origin).replace('<script nonce=', `${bootstrap}<script nonce=`);
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(html);
      } else if (['/media/quicklist.js', '/media/quicklist.css'].includes(request.url)) {
        response.writeHead(200, { 'Content-Type': request.url.endsWith('.js') ? 'text/javascript' : 'text/css' });
        response.end(await fs.readFile(path.join(__dirname, '..', request.url)));
      } else { response.writeHead(204); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Runtime.addBinding', { name: 'quicklistMessage' });
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 600, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait(() => evaluate(`document.getElementById('empty')?.textContent.includes('Drag files')`));
    const enterName = async (name, options = '') => {
      await evaluate(`(() => { const input = document.querySelector('input'); input.value = ${JSON.stringify(name)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ${options} })); })()`);
    };
    const readyInput = () => wait(() => evaluate(`document.activeElement?.tagName === 'INPUT'`));
    const waitRows = (count) => wait(() => evaluate(`document.querySelectorAll('.node').length === ${count}`));

    await h.call('newFolder');
    await readyInput();
    await enterName('中文文件夹', 'isComposing: true');
    assert.equal(h.writes, 0, 'IME confirmation must not submit the draft.');
    await enterName('中文文件夹');
    await waitRows(1);
    const group = h.provider.items[0];
    assert.equal(group.name, '中文文件夹');
    await evaluate(`document.querySelector('.node').focus(); document.querySelector('.node').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
    assert.equal(await evaluate(`document.activeElement?.dataset.key`), `group:${group.id}`);
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-expanded')`), 'false');
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-expanded')`), 'true');
    await h.call('newFolder', group);
    await readyInput();
    await evaluate(`document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(() => !h.presenter.editing);
    assert.equal(h.writes, 1);
    await h.call('newFolder');
    await readyInput();
    await enterName('中文文件夹');
    assert.match(await evaluate(`document.getElementById('name-error').textContent`), /already exists/);
    assert.equal(h.writes, 1);
    await enterName('Second');
    await waitRows(2);
    await evaluate(`document.querySelector('.node').focus(); document.querySelector('.node').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
    await readyInput();
    await enterName('Renamed');
    await wait(() => h.provider.items[0].name === 'Renamed');
    console.log('PASS: inline input, IME, Enter, Escape, duplicate validation, and keyboard rename');

    const uris = ['a', 'b', 'c'].map((name) => h.resource(`/project/${name}.ts`));
    await h.provider.addMany(uris);
    await waitRows(5);
    const drag = async (source, target, fraction, external, fullList) => {
      await evaluate(`(() => {
        const transfer = new DataTransfer();
        const row = key => [...document.querySelectorAll('.row')].find(row => row.dataset.key === key);
        ${external ? `transfer.setData('ResourceURLs', ${JSON.stringify(JSON.stringify(external))});` :
          `row(${JSON.stringify(source)}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));`}
        ${fullList ? `transfer.setData('application/vnd.code.uri-list', ${JSON.stringify(fullList.join('\r\n'))});
          transfer.setData('text/uri-list', ${JSON.stringify(fullList[0])});` : ''}
        const destination = row(${JSON.stringify(target)}) || document.getElementById('root-drop');
        const rect = destination.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: rect.left + 50, clientY: rect.top + rect.height * ${fraction} };
        destination.dispatchEvent(new DragEvent('dragover', options));
        destination.dispatchEvent(new DragEvent('drop', options));
      })()`);
    };
    const [a, b, c] = uris.map(String);
    await drag(c, a, 0.1);
    await wait(() => h.provider.getChildren().at(-3).uri === c);
    await wait(() => evaluate(`document.querySelectorAll('.row')[2].dataset.key === ${JSON.stringify(c)}`));
    await drag(c, b, 0.9);
    await wait(() => h.provider.getChildren().at(-1).uri === c);
    await drag(a, `group:${group.id}`, 0.5);
    await wait(() => h.provider.getChildren(group).length === 1);
    await waitRows(5);
    await drag(a, undefined, 0.5);
    await wait(() => h.provider.getChildren(group).length === 0);
    const external = h.resource('/project/external #中文.ts');
    await drag(undefined, `group:${group.id}`, 0.5, [external.toString()]);
    await wait(() => h.provider.getChildren(group).length === 1);
    assert.equal(h.provider.getChildren(group)[0].uri, external.toString());
    await waitRows(6);
    const folders = [h.resource('/project/components', 2), h.resource('/project/lib', 2)];
    const additional = h.resource('/project/additional.ts');
    await drag(undefined, `group:${group.id}`, 0.5, [additional.toString()], [...folders, additional].map(String));
    await wait(() => h.provider.getChildren(group).length === 4);
    assert.deepEqual(h.provider.getChildren(group).map(item => item.uri), [external, ...folders, additional].map(String));
    await waitRows(9);
    assert.deepEqual(errors, [], 'The sidebar must not raise JavaScript or CSP errors.');
    assert.deepEqual(h.errors, []);
    console.log('PASS: drag reorder, move into folders, move to root, and complete Explorer file/folder import');
  } finally {
    h.dispose();
    socket?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill('SIGKILL');
      await exited;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
