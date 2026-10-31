// What the relay installer decides, and that it falls back instead of failing.
//
//   node --test server/test/install-mediamtx.test.js
//
// The decisions are read from its dry-run mode; the fallback is reached by a machine that has no curl, so none of
// this needs a network or a compiler.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patches = resolve(here, '..', 'patches');
const installer = join(patches, 'install-mediamtx.sh');
const builder = join(patches, 'build-mediamtx.sh');

const run = (file, args, env = {}) => spawnSync('bash', [file, ...args], {
  env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
});

const patchId = (env = {}) => run(builder, ['--patch-id'], env).stdout.trim();

/** The decision for a machine that has `installed` as the first line of `mediamtx --version`. */
const decide = (installed, env = {}) => run(installer, [], {
  MEDIAMTX_VERSION: '1.21.0',
  MTX_ARCH: 'linux_amd64',
  INSTALL_MEDIAMTX_DRY_RUN: '1',
  INSTALLED_VERSION_OVERRIDE: installed,
  ...env,
}).stdout.trim();

describe('which patches a build has', () => {
  it('has an id that is the same every time, and changes with the interval', () => {
    assert.match(patchId(), /^\d+$/);
    assert.equal(patchId(), patchId());
    assert.notEqual(patchId(), patchId({ NACK_INTERVAL_MS: '2' }));
    assert.equal(patchId({ NACK_INTERVAL_MS: '2' }), patchId({ NACK_INTERVAL_MS: '2' }));
  });
});

describe('what it does on a machine that has...', () => {
  const id = patchId();

  it('nothing: builds the patched one (the default)', () => {
    assert.equal(decide(''), 'build-patched');
  });

  it("the published binary: builds the patched one, which is how an update reaches an old install", () => {
    assert.equal(decide('v1.21.0'), 'build-patched');
  });

  it('the patched one with these patches: leaves it alone', () => {
    assert.equal(decide(`v1.21.0-harmony.${id}`), 'keep-patched');
  });

  it('the patched one with other patches, or another version: builds again', () => {
    assert.equal(decide('v1.21.0-harmony.12345'), 'build-patched');
    assert.equal(decide(`v1.20.0-harmony.${id}`), 'build-patched');
  });

  it('and with MEDIAMTX_PATCHED=0: keeps the published one, and swaps a patched one for it', () => {
    assert.equal(decide('v1.21.0', { MEDIAMTX_PATCHED: '0' }), 'keep-release');
    assert.equal(decide(`v1.21.0-harmony.${id}`, { MEDIAMTX_PATCHED: '0' }), 'install-release');
    assert.equal(decide('v1.20.0', { MEDIAMTX_PATCHED: '0' }), 'install-release');
    assert.equal(decide('', { MEDIAMTX_PATCHED: '0' }), 'install-release');
  });

  it('refuses to run without knowing the version or the architecture', () => {
    const r = run(installer, [], { INSTALL_MEDIAMTX_DRY_RUN: '1', INSTALLED_VERSION_OVERRIDE: '' });
    assert.notEqual(r.status, 0);
  });
});

describe('when the build cannot be made', () => {
  it('says why and goes on to install the published binary', () => {
    // A bin directory with what the script needs and no curl.
    const bin = mkdtempSync(join(tmpdir(), 'harmony-nocurl-'));
    for (const tool of ['bash', 'sh', 'sed', 'cut', 'cksum', 'mktemp', 'rm', 'head', 'cat', 'dirname', 'tar', 'patch', 'sort', 'awk', 'install']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    chmodSync(bin, 0o755);
    const r = spawnSync(join(bin, 'bash'), [installer], {
      env: {
        PATH: bin,
        MEDIAMTX_VERSION: '1.21.0',
        MTX_ARCH: 'linux_amd64',
        DEST: join(bin, 'mediamtx'),
        INSTALLED_VERSION_OVERRIDE: '',
      },
      encoding: 'utf8',
    });
    assert.match(r.stderr, /curl is not installed/);
    assert.match(r.stderr, /Could not build MediaMTX with Harmony's patches/);
    assert.match(r.stderr, /Installing the published MediaMTX 1\.21\.0 instead/);
    assert.match(r.stdout, /Installing MediaMTX 1\.21\.0/, 'it went on to the published one');
  });
});
