// Check staged Git blobs, including newly added files. Never print matched secrets.
import { execFileSync } from 'node:child_process';

const allowed = new Set([
  '.gitignore', '.github/workflows/ci.yml', 'package.json',
  'README.md', 'PRIVACY.md', 'config.example.json',
  'index.ts', 'extension.ts', 'controller.ts', 'backend.ts', 'audio.ts',
  'config.ts', 'processes.ts', 'pipeline.ts', 'voices.ts',
  'tests/audio.test.mjs', 'tests/controller.test.mjs', 'tests/pipeline-voices.test.mjs',
  'tools/voices.mjs', 'tools/smoke.mjs', 'tools/test-reload.py', 'tools/check-privacy.mjs',
]);
const checks = [
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API credential', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential assignment', /["']?(?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i],
  ['personal home path', /\/(?:home|Users)\/[A-Za-z0-9_.-]+\//],
  ['private mounted filesystem', /\/run\/media\//],
];
const git = (...args) => execFileSync('git', args, { maxBuffer: 8 * 1024 * 1024 });
const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
if (!entries.length) throw new Error('No staged/tracked files. Stage the intended code before checking.');
const failures = [];
for (const entry of entries) {
  const tab = entry.indexOf('\t');
  const [mode, , stage] = entry.slice(0, tab).split(' ');
  const path = entry.slice(tab + 1);
  if (!allowed.has(path)) { failures.push(`${path}: not on the publication allowlist`); continue; }
  if (!['100644', '100755'].includes(mode) || stage !== '0') { failures.push(`${path}: symlink, submodule or unresolved index entry`); continue; }
  const bytes = git('show', `:${path}`);
  if (bytes.length > 200 * 1024 || bytes.includes(0)) { failures.push(`${path}: oversized or binary data`); continue; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { failures.push(`${path}: not UTF-8 text`); continue; }
  for (const [label, pattern] of checks) if (pattern.test(text)) failures.push(`${path}: possible ${label}`);
}
if (failures.length) {
  console.error('Publication privacy check FAILED:\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication privacy check passed: ${entries.length} allowlisted text files; no flagged patterns. Manual review still required.`);
}
