#!/usr/bin/env node
/*
 * Reusable Playwright screenshot / smoke-test harness for index.html.
 *
 * Serves the repo root over plain HTTP, loads the page in headless
 * Chromium, waits for the WebGL canvas to render, optionally toggles the
 * room/environment button, captures a screenshot, and runs a minimal smoke
 * test (zero console errors + non-uniform canvas pixels).
 *
 * Usage:
 *   node scripts/screenshot.mjs --out /path/to/shot.png [--env dark] [--port 8791] [--wait 3000]
 *
 * Playwright itself is not a local dependency of this repo (another agent
 * owns package.json in this task). It is resolved from the globally
 * installed copy at /opt/node22/lib/node_modules/playwright, with a
 * fallback to a plain `import('playwright')` in case a local/global
 * resolution works in some other environment.
 *
 * Sandbox note: this environment routes outbound HTTPS through a local
 * MITM-tunneling agent proxy. Headless Chromium's TLS handshake to the
 * three.js CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net) gets reset partway
 * through by that proxy chain (curl/node fetch to the same URLs succeed
 * fine, so the content itself is reachable — only Chromium's own TLS stack
 * trips something in the intercepting layer, most likely bot/automation
 * fingerprinting). To keep the harness working without touching the
 * page's real CDN URLs, requests to those two hosts are relayed through
 * Node's own fetch (which tunnels through the proxy successfully) via
 * Playwright route interception, instead of disabling TLS verification or
 * bypassing the proxy.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const GLOBAL_PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROMIUM_EXECUTABLE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CDN_RELAY_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Fall back to the globally installed copy (this repo does not
    // declare playwright as a dependency).
    return await import(GLOBAL_PLAYWRIGHT);
  }
}

function parseArgs(argv) {
  const out = {
    out: null,
    env: null,        // 'light' | 'dark' | null (leave default)
    port: 8791,
    wait: 3000,
    width: 1280,
    height: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--env') out.env = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--wait') out.wait = Number(argv[++i]);
    else if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
  }
  if (!out.out) {
    console.error('Usage: node scripts/screenshot.mjs --out <path.png> [--env light|dark] [--port 8791] [--wait 3000]');
    process.exit(1);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function startServer(root, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = path.join(root, urlPath);
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function launchChromium(chromium, extraArgs) {
  const opts = {
    headless: true,
    args: extraArgs,
  };
  if (fs.existsSync(CHROMIUM_EXECUTABLE)) {
    opts.executablePath = CHROMIUM_EXECUTABLE;
  }
  return chromium.launch(opts);
}

/**
 * Relay requests to the three.js CDN hosts through Node's own fetch (which
 * successfully tunnels through the sandbox's agent proxy) instead of
 * letting Chromium's network stack make the TLS connection directly (see
 * the module-level comment for why).
 */
async function installCdnRelay(page) {
  process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';
  for (const host of CDN_RELAY_HOSTS) {
    await page.route(`https://${host}/**`, async (route) => {
      const req = route.request();
      try {
        const resp = await fetch(req.url(), { method: req.method() });
        const buf = Buffer.from(await resp.arrayBuffer());
        const headers = {};
        resp.headers.forEach((v, k) => {
          if (k.toLowerCase() === 'content-encoding') return; // already decoded
          headers[k] = v;
        });
        await route.fulfill({ status: resp.status, headers, body: buf });
      } catch (e) {
        console.error(`CDN relay failed for ${req.url()}:`, e.message);
        await route.abort('failed');
      }
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = await loadPlaywright();

  const server = await startServer(REPO_ROOT, args.port);
  const url = `http://127.0.0.1:${args.port}/index.html`;

  let browser;
  let usedFallbackArgs = false;
  let attempt;
  try {
    attempt = await runAttempt(chromium, url, args, []);
    if (!attempt.canvasNonUniform) {
      console.error('Canvas looked uniform/black, retrying with swiftshader flags...');
      usedFallbackArgs = true;
      attempt = await runAttempt(chromium, url, args, ['--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader']);
    }
  } finally {
    server.close();
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, attempt.screenshotBuffer);

  const result = {
    out: args.out,
    consoleErrors: attempt.consoleErrors,
    pageErrors: attempt.pageErrors,
    canvasNonUniform: attempt.canvasNonUniform,
    usedFallbackArgs,
  };
  console.log(JSON.stringify(result, null, 2));

  if (attempt.consoleErrors.length || attempt.pageErrors.length) {
    process.exitCode = 2;
  }
  if (!attempt.canvasNonUniform) {
    process.exitCode = 3;
  }
}

async function runAttempt(chromium, url, args, extraChromeArgs) {
  const browser = await launchChromium(chromium, extraChromeArgs);
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
    await installCdnRelay(page);
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err));
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(args.wait);

    if (args.env) {
      await clickEnvButton(page, args.env);
      await page.waitForTimeout(600);
    }

    const canvasBox = await page.$eval('#stage', (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }).catch(() => null);

    const screenshotBuffer = await page.screenshot();
    const canvasNonUniform = await isNonUniform(screenshotBuffer, canvasBox);

    return { consoleErrors, pageErrors, canvasNonUniform, screenshotBuffer };
  } finally {
    await browser.close();
  }
}

async function clickEnvButton(page, env) {
  const sel = `#env button[data-env="${env}"]`;
  const el = await page.$(sel);
  if (el) {
    await el.click();
  } else {
    console.error(`Env button ${sel} not found; leaving default view.`);
  }
}

/**
 * Decode the screenshot with sharp (already a project dependency) and check
 * whether the canvas region has more than one distinct pixel color — a
 * cheap way to rule out an all-black / all-one-color render without relying
 * on an in-page WebGL readback (which can read back blank because the
 * drawing buffer is cleared by the compositor between frames unless
 * preserveDrawingBuffer is set).
 */
async function isNonUniform(pngBuffer, box) {
  let img = sharp(pngBuffer);
  if (box && box.width > 0 && box.height > 0) {
    img = img.extract(box);
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let first = null;
  for (let i = 0; i < data.length; i += channels * 977) {
    const px = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    if (first === null) first = px;
    else if (px !== first) return true;
  }
  return false;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
