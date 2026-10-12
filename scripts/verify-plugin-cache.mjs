import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../plugin/', import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PACKAGED_FILES = Object.freeze([
  '.codex-plugin/plugin.json', '.mcp.json',
  'src/mcp-server.mjs', 'src/protocol.mjs', 'src/relay-client.mjs',
  'src/live-mirror.mjs', 'src/chat-post-status.mjs', 'ui/conversation-panel.html',
  'skills/codex-link/SKILL.md',
]);

async function inspectFile(root, relativeFile) {
  try {
    const filePath = path.join(root, relativeFile);
    const info = await stat(filePath);
    if (!info.isFile()) return { status: 'not_a_file' };
    if (info.size > MAX_FILE_BYTES) return { status: 'too_large' };
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_FILE_BYTES) return { status: 'too_large' };
    return { status: 'present', bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function manifestInfo(file) {
  if (file.status !== 'present') return { correctName: false, version: null };
  try {
    const value = JSON.parse(file.bytes.toString('utf8'));
    const version = typeof value.version === 'string' && value.version.length <= 64
      && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) ? value.version : null;
    // Never echo arbitrary manifest values, configuration contents or paths.
    return { correctName: value.name === 'codex-link', version };
  } catch {
    return { correctName: false, version: null };
  }
}

export async function verifyPluginCache(cachedRoot, { sourceRoot = SOURCE_ROOT } = {}) {
  if (typeof cachedRoot !== 'string' || !path.isAbsolute(cachedRoot)) {
    throw new Error('An absolute installed-cache path is required.');
  }
  const normalized = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (normalized(cachedRoot) === normalized(sourceRoot)) {
    throw new Error('Choose the installed copy, not the source plugin directory.');
  }
  const files = [];
  let expectedManifest;
  let cachedManifest;
  for (const relativeFile of PACKAGED_FILES) {
    const expected = await inspectFile(sourceRoot, relativeFile);
    if (expected.status !== 'present') throw new Error('The source plugin package is incomplete or unreadable.');
    const cached = await inspectFile(cachedRoot, relativeFile);
    if (relativeFile === '.codex-plugin/plugin.json') {
      expectedManifest = manifestInfo(expected);
      cachedManifest = manifestInfo(cached);
    }
    files.push({ file: relativeFile, cachedStatus: cached.status,
      matches: cached.status === 'present' && expected.digest === cached.digest });
  }
  if (!expectedManifest.correctName || !expectedManifest.version) {
    throw new Error('The source Codex Link manifest is invalid.');
  }
  return {
    ok: cachedManifest.correctName && expectedManifest.version === cachedManifest.version
      && files.every(file => file.matches),
    scope: 'Packaged files only. Verify the active MCP version separately.',
    expectedVersion: expectedManifest.version,
    cachedVersion: cachedManifest.version,
    cachedNameMatches: cachedManifest.correctName,
    files,
  };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/verify-plugin-cache.mjs --cached-root "ABSOLUTE_INSTALLED_PATH"\n'
    + `Read-only: checks ${PACKAGED_FILES.length} packaged files, without printing contents or private paths.\n`
    + 'A match does not establish which files the running MCP loaded.\n';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage);
  } else if (args.length !== 2 || args[0] !== '--cached-root') {
    process.stderr.write(usage);
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyPluginCache(args[1]);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      // Errors may contain private paths; never serialize an OS exception.
      process.stderr.write('Cache check could not complete. Verify the target path and source package.\n');
      process.exitCode = 2;
    }
  }
}
