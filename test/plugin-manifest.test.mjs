// The plugin carries no version number, so Claude Code takes the commit as its version and every commit on main is an
// update. Claude Code caches an installed plugin per version: with a fixed `version` in plugin.json or in the
// marketplace entry, `claude plugin update` says "already at the latest version" and keeps the old copy until someone
// remembers to bump it (Claude Code docs, plugins: "Versions and updates", 2026-10-16 KST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = f => JSON.parse(readFileSync(fileURLToPath(new URL(`../.claude-plugin/${f}`, import.meta.url)), 'utf8'));

// → where a manifest pins a version: 'plugin.json', 'marketplace: <plugin name>'
function pinnedVersions(plugin, marketplace) {
  const out = [];
  if (plugin && Object.hasOwn(plugin, 'version')) out.push('plugin.json');
  for (const p of marketplace?.plugins ?? []) if (p && Object.hasOwn(p, 'version')) out.push(`marketplace: ${p.name}`);
  return out;
}

test('plugin manifests: no version is pinned, so each commit on main reaches `claude plugin update`', () => {
  assert.deepEqual(pinnedVersions(read('plugin.json'), read('marketplace.json')), []);
});

test('plugin manifests: a version in plugin.json or in a marketplace entry is caught; none is not', () => {
  assert.deepEqual(pinnedVersions({ name: 'nunchi', version: '0.0.2' }, { plugins: [{ name: 'nunchi', source: './' }] }), ['plugin.json']);
  assert.deepEqual(pinnedVersions({ name: 'nunchi' }, { plugins: [{ name: 'nunchi', source: './', version: '0.0.2' }] }), ['marketplace: nunchi']);
  assert.deepEqual(pinnedVersions({ name: 'nunchi' }, { plugins: [{ name: 'nunchi', source: './' }] }), []);
});

test('validate:plugin: strict, except the one warning an unpinned version gives', async () => {
  const { blocking } = await import('../scripts/validate-plugin.mjs');
  const part = (warnings = [], errors = []) => ({ file: 'plugin.json', errors, warnings });
  const noVersion = { path: 'version', message: 'No version specified. Consider adding a version following semver (e.g., "1.0.0")' };
  const inMarket = { path: 'plugins[0] plugin.json → version', message: noVersion.message };
  assert.deepEqual(blocking({ success: true, manifest: part([inMarket]), contents: [part([noVersion])] }), [], 'the version warning alone passes');
  const other = { path: 'author', message: 'Unrecognized field' };
  assert.deepEqual(blocking({ success: true, manifest: part([inMarket]), contents: [part([noVersion, other])] }).map(b => b.path), ['author'], 'any other warning fails');
  assert.deepEqual(blocking({ success: false, manifest: part([], [{ path: 'name', message: 'Required' }]), contents: [] }).map(b => b.kind), ['error'], 'an error fails');
  assert.equal(blocking({ success: false, manifest: part(), contents: [] }).length, 1, 'a failed validation with nothing listed fails');
  assert.equal(blocking({ success: true, manifest: part([{ path: 'description', message: 'No version specified' }]) }).length, 1, 'the words alone, on another field, fail');
});
