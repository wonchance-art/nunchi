import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pacScript } from '../src/capture.mjs';

const route = (script, url) => new Function(`${script}; return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(new URL(url).hostname)});`)();

test('PAC: the app and local hosts go direct, fonts allowed, everything else goes nowhere', () => {
  const pac = pacScript({ appHost: 'preview.example.test', proxyServer: null });
  assert.equal(route(pac, 'https://preview.example.test/dashboard'), 'DIRECT');
  assert.equal(route(pac, 'http://localhost:3000/'), 'DIRECT');
  assert.equal(route(pac, 'http://127.0.0.1:5173/'), 'DIRECT');
  assert.equal(route(pac, 'https://fonts.gstatic.com/s/x.woff2'), 'DIRECT');
  for (const u of ['https://www.google.com/', 'http://clients2.google.com/update', 'https://www.google-analytics.com/collect', 'https://api.stripe.com/v1']) {
    assert.equal(route(pac, u), 'PROXY 127.0.0.1:9', u);
  }
});

test('PAC: behind a proxy, only font hosts use it', () => {
  const pac = pacScript({ appHost: 'localhost', proxyServer: 'http://127.0.0.1:44905' });
  assert.equal(route(pac, 'https://fonts.googleapis.com/css2?family=Lora'), 'PROXY 127.0.0.1:44905');
  assert.equal(route(pac, 'http://localhost:3000/'), 'DIRECT');
  assert.equal(route(pac, 'https://www.google.com/'), 'PROXY 127.0.0.1:9');
});
