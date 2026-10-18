'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRelease } = require('../tools/release');

test('a plain version tag selects the stable channel', () => {
  assert.deepEqual(resolveRelease('v0.1.0', '0.1.0'), { tag: 'v0.1.0', prerelease: false });
});

test('a suffix selects pre-release without changing the Marketplace version', () => {
  for (const suffix of ['alpha.1', 'rc.2', '0', 'preview-build.3']) {
    const tag = `v0.1.0-${suffix}`;
    assert.deepEqual(resolveRelease(tag, '0.1.0'), { tag, prerelease: true });
  }
});

test('tags cannot release a different package version', () => {
  for (const tag of ['v0.2.0', 'v0.2.0-alpha.1']) {
    assert.throws(() => resolveRelease(tag, '0.1.0'), /does not match/);
  }
  assert.throws(() => resolveRelease('v0.1.0-alpha.1', '0.1.0-alpha.1'), /does not match/);
});

test('malformed tags and shell or Actions-output injection are rejected', () => {
  for (const tag of [
    undefined, '', '0.1.0', 'v0.1', 'v01.1.0', 'v0.01.0', 'v0.1.00',
    'v0.1.0-', 'v0.1.0-alpha..1', 'v0.1.0-alpha.01', 'v0.1.0+build.1',
    ' v0.1.0', 'v0.1.0 ', 'v0.1.0\n', 'v0.1.0\nprerelease=true',
    'v0.1.0-$(echo injected)', 'v0.1.0-`echo injected`', 'v0.1.0;exit 0',
  ]) {
    assert.throws(() => resolveRelease(tag, '0.1.0'), /Use a release tag/, String(tag));
  }
});
