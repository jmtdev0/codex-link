import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PACKAGED_FILES, verifyPluginCache } from '../scripts/verify-plugin-cache.mjs';

const sourceRoot = fileURLToPath(new URL('../plugin/', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/verify-plugin-cache.mjs', import.meta.url));
const run = promisify(execFile);

async function fixture(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-link-cache-check-'));
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  const cachedRoot = path.join(temporaryRoot, 'installed-copy');
  t.after(async () => {
    // Delete only this test's own explicitly bounded, freshly created directory.
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(temporaryRoot), /^codex-link-cache-check-/);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  for (const relativeFile of PACKAGED_FILES) {
    await mkdir(path.dirname(path.join(cachedRoot, relativeFile)), { recursive: true });
    await copyFile(path.join(sourceRoot, relativeFile), path.join(cachedRoot, relativeFile));
  }
  return cachedRoot;
}

test('cache checker verifies all eight files without modifying or disclosing the installed copy', async t => {
  const cachedRoot = await fixture(t);
  const before = await Promise.all(PACKAGED_FILES.map(async relativeFile => ({
    bytes: await readFile(path.join(cachedRoot, relativeFile)),
    modified: (await stat(path.join(cachedRoot, relativeFile))).mtimeMs,
  })));
  const result = await verifyPluginCache(cachedRoot);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 8);
  assert.equal(result.expectedVersion, result.cachedVersion);
  assert.ok(result.files.every(file => file.matches));
  assert.match(result.scope, /active MCP version separately/);
  const output = JSON.stringify(result);
  assert.equal(output.includes(cachedRoot), false);
  assert.equal(output.includes(sourceRoot), false);
  for (const [index, relativeFile] of PACKAGED_FILES.entries()) {
    assert.deepEqual(await readFile(path.join(cachedRoot, relativeFile)), before[index].bytes);
    assert.equal((await stat(path.join(cachedRoot, relativeFile))).mtimeMs, before[index].modified);
  }
});

test('correct version metadata cannot conceal mismatched or missing runtime files', async t => {
  const cachedRoot = await fixture(t);
  await writeFile(path.join(cachedRoot, 'src/protocol.mjs'), '// Different installed bytes.\n');
  await unlink(path.join(cachedRoot, 'ui/conversation-panel.html'));
  const result = await verifyPluginCache(cachedRoot);
  assert.equal(result.ok, false);
  assert.equal(result.expectedVersion, result.cachedVersion);
  assert.equal(result.files.find(file => file.file === 'src/protocol.mjs').matches, false);
  assert.equal(result.files.find(file => file.file === 'ui/conversation-panel.html').cachedStatus, 'missing');
});

test('cache diagnostics never echo arbitrary manifest values or local configuration contents', async t => {
  const cachedRoot = await fixture(t);
  const privateCanary = 'fixture-canary-not-for-output';
  const cachedManifestPath = path.join(cachedRoot, '.codex-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(cachedManifestPath, 'utf8'));
  await writeFile(cachedManifestPath, JSON.stringify({ ...manifest, version: privateCanary, privateData: privateCanary }));
  await writeFile(path.join(cachedRoot, '.mcp.json'), JSON.stringify({ privateData: privateCanary }));
  await writeFile(path.join(cachedRoot, 'unrelated-private-file.txt'), privateCanary);
  const result = await verifyPluginCache(cachedRoot);
  assert.equal(result.ok, false);
  assert.equal(result.cachedVersion, null);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(result.files.length, 8);
});

test('cache CLI has explicit success, mismatch and invalid-input exit statuses', async t => {
  const cachedRoot = await fixture(t);
  const valid = await run(process.execPath, [scriptPath, '--cached-root', cachedRoot]);
  assert.equal(JSON.parse(valid.stdout).ok, true);
  assert.equal(valid.stderr, '');
  await writeFile(path.join(cachedRoot, 'src/protocol.mjs'), '// Different installed bytes.\n');
  await assert.rejects(run(process.execPath, [scriptPath, '--cached-root', cachedRoot]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.equal(error.stderr, '');
    return true;
  });
  await assert.rejects(run(process.execPath, [scriptPath, '--cached-root', sourceRoot]), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stderr.includes(sourceRoot), false);
    return true;
  });
  await assert.rejects(verifyPluginCache('relative/cache'), /absolute/);
});
