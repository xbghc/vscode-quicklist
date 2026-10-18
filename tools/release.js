'use strict';

const fs = require('node:fs');

function resolveRelease(tag, version) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag || '');
  if (!match || match[0] !== tag || match[2]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error('Use a release tag such as v0.1.0 or v0.1.0-alpha.1.');
  }
  if (match[1] !== version) {
    throw new Error(`Tag ${tag} does not match package.json version ${version}.`);
  }
  return { tag, prerelease: Boolean(match[2]) };
}

if (require.main === module) {
  try {
    const { version } = require('../package.json');
    const release = resolveRelease(process.env.RELEASE_TAG, version);
    const output = `tag=${release.tag}\nprerelease=${release.prerelease}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveRelease };
