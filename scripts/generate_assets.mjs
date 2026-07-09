#!/usr/bin/env node
/**
 * Replicate asset generator for the chessboard realism pass.
 *
 * Usage:
 *   export REPLICATE_API_TOKEN=r8_...        (never commit this)
 *   node scripts/generate_assets.mjs         (generates everything in ASSETS)
 *   node scripts/generate_assets.mjs walnut  (only jobs whose name includes "walnut")
 *
 * Outputs land in assets/generated/<name>/.
 *
 * NOTE for the Claude Code session: pick the current best texture model on
 * replicate.com/explore and set MODEL below (model landscape shifts monthly).
 * Prompts are written for seamless top-down material albedos: keep
 * "seamless tileable texture, top-down, flat even lighting, no shadows,
 * no vignette" in every prompt or the tiles will not wrap.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) {
  console.error('Set REPLICATE_API_TOKEN first (do not hardcode it).');
  process.exit(1);
}

// Model slug. Default is openai/gpt-image-2 (runs on Replicate's proxied
// OpenAI billing, no BYO key needed) for its strong prompt adherence on
// flat/seamless/no-shadow instructions. Set REPLICATE_MODEL to override,
// e.g. "black-forest-labs/flux-1.1-pro" as a fallback.
const MODEL = process.env.REPLICATE_MODEL || 'openai/gpt-image-2';
const IS_GPT_IMAGE = MODEL.startsWith('openai/gpt-image');

const COMMON =
  'seamless tileable texture, top-down orthographic, flat even studio lighting, ' +
  'no shadows, no vignette, no text, photographic, 4k detail';

const ASSETS = [
  {
    name: 'walnut-dark-squares',
    prompt: `dark american walnut wood veneer, fine straight grain, oiled satin finish, deep umber brown, ${COMMON}`,
    numberOfImages: 2,
  },
  {
    name: 'maple-light-squares',
    prompt: `pale hard maple wood veneer, subtle fine grain, satin finish, warm cream tan, ${COMMON}`,
    numberOfImages: 2,
  },
  {
    name: 'walnut-frame',
    prompt: `rift sawn walnut board, long continuous straight grain, satin oiled finish, ${COMMON}`,
    numberOfImages: 2,
  },
  {
    name: 'oak-table',
    prompt: `aged oak table top, wide planks, visible pore structure, matte waxed finish, warm mid brown, ${COMMON}`,
    numberOfImages: 2,
  },
  {
    name: 'green-baize',
    prompt: `fine wool baize felt fabric, deep bottle green, tight even nap, ${COMMON}`,
  },
  {
    name: 'boxwood-pieces',
    // NOTE: an earlier phrasing ("turned wood grain ... chess piece surface")
    // made the model render an array of turned discs instead of a flat
    // material; keep this phrased as a flat macro wood surface.
    prompt: `polished boxwood wood surface, flat macro close-up of solid wood, fine subtle grain with faint concentric arcs, warm pale ochre yellow, smooth satin lacquered finish, ${COMMON}`,
  },
  {
    name: 'ebony-pieces',
    prompt: `polished ebony wood, very dark brown-black, subtle fine grain striations, satin lacquered finish, ${COMMON}`,
  },
];

const API = 'https://api.replicate.com/v1';

async function createPrediction(job) {
  const input = IS_GPT_IMAGE
    ? {
        prompt: job.prompt,
        aspect_ratio: '1024x1024',
        quality: 'high',
        output_format: 'png',
        background: 'opaque',
        number_of_images: job.numberOfImages || 1,
        // openai_api_key intentionally omitted: Replicate proxies billing.
      }
    : {
        prompt: job.prompt,
        aspect_ratio: '1:1',
        output_format: 'png',
        width: 1024,
        height: 1024,
      };
  const res = await fetch(`${API}/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=10',
    },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`create failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function poll(prediction) {
  let p = prediction;
  while (p.status === 'starting' || p.status === 'processing') {
    await new Promise(r => setTimeout(r, 2500));
    const res = await fetch(`${API}/predictions/${p.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`poll failed ${res.status}`);
    p = await res.json();
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (p.status !== 'succeeded') throw new Error(`prediction ${p.status}: ${JSON.stringify(p.error)}`);
  return p;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function runJob(job) {
  const dir = path.join('assets', 'generated', job.name);
  await mkdir(dir, { recursive: true });
  const p = await poll(await createPrediction(job));
  const outputs = Array.isArray(p.output) ? p.output : [p.output];
  let i = 0;
  const saved = [];
  for (const url of outputs) {
    const dest = path.join(dir, `albedo${outputs.length > 1 ? '_' + i++ : ''}.png`);
    await download(url, dest);
    console.log(`  saved ${dest}`);
    saved.push(dest);
  }
  await writeFile(path.join(dir, 'prompt.txt'), job.prompt + '\n');
  return saved;
}

async function run() {
  const filter = process.argv[2] || '';
  const jobs = ASSETS.filter(a => a.name.includes(filter));
  if (!jobs.length) {
    console.error(`No jobs match "${filter}". Available: ${ASSETS.map(a => a.name).join(', ')}`);
    process.exit(1);
  }
  const results = { succeeded: [], failed: [] };
  for (const job of jobs) {
    console.log(`\n[${job.name}] generating with ${MODEL}`);
    try {
      const saved = await runJob(job);
      results.succeeded.push({ name: job.name, files: saved });
    } catch (e1) {
      console.error(`  [${job.name}] attempt 1 failed: ${e1.message}. Retrying once...`);
      try {
        const saved = await runJob(job);
        results.succeeded.push({ name: job.name, files: saved });
      } catch (e2) {
        console.error(`  [${job.name}] attempt 2 failed: ${e2.message}. Giving up on this job.`);
        results.failed.push({ name: job.name, error: e2.message });
      }
    }
  }
  console.log('\n=== Summary ===');
  console.log(`Succeeded (${results.succeeded.length}): ${results.succeeded.map(r => r.name).join(', ') || 'none'}`);
  console.log(`Failed (${results.failed.length}): ${results.failed.map(r => r.name).join(', ') || 'none'}`);
  for (const f of results.failed) console.log(`  - ${f.name}: ${f.error}`);
  console.log(
    '\nNext: derive normal + roughness maps from each albedo\n' +
    '(e.g. with sharp: high-pass -> normal, inverted luminance -> roughness),\n' +
    'then wire the maps into applyTheme() per CLAUDE.md section 3.'
  );
  if (results.failed.length) process.exitCode = 1;
}

run().catch(e => { console.error(e); process.exit(1); });
