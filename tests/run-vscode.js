'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  let runner;
  try {
    runner = require('@vscode/test-electron');
  } catch {
    throw new Error('Install the integration-test runner with: npm run test:setup');
  }
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quicklist-tests-'));
  const alpha = path.join(data, 'alpha');
  const beta = path.join(data, 'beta');
  await fs.mkdir(alpha);
  await fs.mkdir(beta);
  const vscodeExecutablePath = await runner.downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
  try {
    // Reuse the profile and workspace path across two fresh VS Code processes.
    // Then open a different workspace to check that its list starts empty.
    for (const phase of ['initial', 'restart', 'other-workspace']) {
      console.log(`Running Quicklist extension-host tests: ${phase}`);
      await runner.runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(__dirname, 'integration', 'index.js'),
        extensionTestsEnv: { QUICKLIST_TEST_PHASE: phase },
        launchArgs: [
          phase === 'other-workspace' ? beta : alpha,
          '--disable-extensions', '--disable-workspace-trust',
          '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox',
          `--user-data-dir=${path.join(data, 'user-data')}`,
          `--extensions-dir=${path.join(data, 'extensions')}`,
        ],
      });
    }
  } finally {
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
