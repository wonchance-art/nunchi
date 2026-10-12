// Recorded login (spec §2.1): the user signs in once with a test account in a real browser
// window; nunchi saves the browser state (cookies + local storage) for signed-in scenes.
// Works with any auth (Supabase, Clerk, Auth.js, Firebase, custom). The file holds live tokens:
// it is written owner-only and is git-ignored by `.nunchi/.gitignore`.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';

const PRODUCTION_HINT = /^(www\.)?[a-z0-9-]+\.(com|io|app|co|net|org|ai|dev)$/i;

export function loginWarnings(url) {
  const host = new URL(url).hostname;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.local)$/.test(host) || /(^|\.)(preview|staging|dev|test)[.-]/.test(host) || /\.vercel\.app$|\.netlify\.app$|\.pages\.dev$/.test(host);
  return !local && PRODUCTION_HINT.test(host)
    ? [`${host} looks like a production address. Use a test account on a local or preview server: nunchi will visit every screen.`]
    : [];
}

export async function login({ url, out, browserPath, waitForEnter = true }) {
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  let browser;
  try {
    // A normal window with normal networking: sign-in may go through Google, GitHub or email links.
    browser = await chromium.launch({ headless: false, executablePath: browserPath || process.env.NUNCHI_BROWSER || undefined, ...(proxyServer ? { proxy: { server: proxyServer, bypass: 'localhost,127.0.0.1,::1' } } : {}) });
  } catch (e) {
    throw Object.assign(new Error(`could not open a browser window (${String(e.message).split('\n')[0]}). ` +
      'Run `nunchi login` on a machine with a display, or install Chromium with `npx playwright@1.63.0 install chromium`.'), { code: 'NO_BROWSER' });
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  if (waitForEnter) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => {
      rl.question('Sign in with a TEST account in the window, then press Enter here to save the login… ', () => resolve());
      page.on('close', resolve);
    });
    rl.close();
  }
  mkdirSync(dirname(out), { recursive: true });
  await ctx.storageState({ path: out });
  chmodSync(out, 0o600);
  await browser.close();
  return out;
}
