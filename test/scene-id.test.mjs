import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneSlug, sceneId } from '../src/capture.mjs';

test('scene names: one-to-one, from the route template, safe on every file system', () => {
  const routes = ['/', '/root', '/a/b', '/a_b', '/a~b', '/About', '/about', '/con', '/c%41', '/posts/[id]', '/posts/$postId', '/p.', '/日本', '/a b', '/a:b'];
  const slugs = routes.map(sceneSlug);
  assert.equal(new Set(slugs).size, routes.length, slugs.join(' '));
  assert.equal(new Set(slugs.map(s => s.toLowerCase())).size, routes.length, 'no collisions on case-insensitive disks');
  for (const s of slugs) {
    assert.ok(!/[<>:"/\\|?*\s]/.test(s), `unsafe character in ${s}`);
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s), `Windows device name ${s}`);
    assert.ok(!s.endsWith('.'), s);
  }
  assert.equal(sceneSlug('/'), '~');
  assert.equal(sceneSlug('/app/tasks/[id]'), 'app~tasks~[id]');
  assert.equal(sceneId('/app/tasks/[id]', 'signed-in', 'error', 'm'), 'app~tasks~[id].signed-in.error.m');
});
