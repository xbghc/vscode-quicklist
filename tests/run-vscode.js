'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function launchSession(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-64000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 120000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) {
        reject(new Error(`VS Code ${timedOut ? 'timed out' : `exited with code ${code}`}\n${output}`));
      } else {
        resolve();
      }
    });
  });
}

async function main() {
  let runner;
  try {
    runner = require('@vscode/test-electron');
  } catch {
    throw new Error('Install the integration-test runner with: npm run test:setup');
  }
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quicklist-tests-'));
  try {
    const alpha = path.join(data, 'alpha');
    const beta = path.join(data, 'beta');
    const driver = path.join(data, 'test-driver');
    await Promise.all([alpha, beta, driver].map((directory) => fs.mkdir(directory)));
    const vscodeExecutablePath = await runner.downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');

    // VS Code deliberately uses in-memory storage with --extensionTestsPath.
    // Run the same assertions from a temporary development extension instead,
    // so normal editor shutdown flushes the real workspace storage database.
    // The driver is outside the source tree and is never included in the VSIX.
    await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({
      name: 'quicklist-test-driver', publisher: 'quicklist-tests', version: '0.0.1',
      engines: { vscode: '^1.85.0' }, main: './extension.js',
      activationEvents: ['*'], extensionDependencies: ['xbghc.quicklist'],
    }));
    await fs.writeFile(path.join(driver, 'extension.js'), `
'use strict';
const vscode = require('vscode');
module.exports.activate = async () => {
  let result;
  try {
    await require(process.env.QUICKLIST_TEST_MODULE).run();
    result = { passed: true };
  } catch (error) {
    result = { passed: false, error: error.stack || String(error) };
  }
  require('node:fs').writeFileSync(process.env.QUICKLIST_TEST_RESULT, JSON.stringify(result));
  setTimeout(() => {
    void vscode.commands.executeCommand('workbench.action.quit').then(undefined, console.error);
  }, 0);
};
`);

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VSCODE_IPC_HOOK_CLI;
    for (const phase of ['initial', 'restart', 'other-workspace']) {
      const resultPath = path.join(data, `${phase}.json`);
      console.log(`Running Quicklist extension-host tests: ${phase}`);
      await launchSession(vscodeExecutablePath, [
        phase === 'other-workspace' ? beta : alpha,
        `--extensionDevelopmentPath=${root}`,
        `--extensionDevelopmentPath=${driver}`,
        '--disable-extensions', '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', '--log=error',
        `--user-data-dir=${path.join(data, 'user-data')}`,
        `--extensions-dir=${path.join(data, 'extensions')}`,
      ], {
        ...environment,
        QUICKLIST_TEST_PHASE: phase,
        QUICKLIST_TEST_MODULE: path.join(__dirname, 'integration', 'index.js'),
        QUICKLIST_TEST_RESULT: resultPath,
      });
      let result;
      try {
        result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      } catch (error) {
        throw new Error(`The ${phase} test session produced no valid result: ${error.message}`);
      }
      if (!result.passed) throw new Error(result.error || `The ${phase} test session failed.`);
      console.log(`PASS: ${phase}`);
    }
  } finally {
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
