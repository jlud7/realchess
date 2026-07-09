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

// Model slug, e.g. "black-forest-labs/flux-1.1-pro" or a dedicated
// tileable-texture model. Verify on replicate.com before running.
const MODEL = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-1.1-pro';

const COMMON =
  'seamless tileable texture, top-down orthographic, flat even studio lighting, ' +
  'no shadows, no vignette, no text, photographic, 4k detail';

const ASSETS = [
  {
    name: 'walnut-dark-squares',
    prompt: `dark american walnut wood veneer, fine straight grain, oiled satin finish, deep umber brown, ${COMMON}`,
  },
  {
    name: 'maple-light-squares',
    prompt: `pale hard maple wood veneer, subtle fine grain, satin finish, warm cream tan, ${COMMON}`,
  },
  {
    name: 'walnut-frame',
    prompt: `rift sawn walnut board, long continuous straight grain, satin oiled finish, ${COMMON}`,
  },
  {
    name: 'oak-table',
    prompt: `aged oak table top, wide planks, visible pore structure, matte waxed finish, warm mid brown, ${COMMON}`,
  },
  {
    name: 'green-baize',
    prompt: `fine wool baize felt fabric, deep bottle green, tight even nap, ${COMMON}`,
  },
];

const API = 'https://api.replicate.com/v1';

async function createPrediction(prompt) {
  const res = await fetch(`${API}/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=10',
    },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: '1:1',
        output_format: 'png',
        // width/height/other params depend on the chosen model; adjust here.
      },
    }),
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

async function run() {
  const filter = process.argv[2] || '';
  const jobs = ASSETS.filter(a => a.name.includes(filter));
  if (!jobs.length) {
    console.error(`No jobs match "${filter}". Available: ${ASSETS.map(a => a.name).join(', ')}`);
    process.exit(1);
  }
  for (const job of jobs) {
    console.log(`\n[${job.name}] generating with ${MODEL}`);
    const dir = path.join('assets', 'generated', job.name);
    await mkdir(dir, { recursive: true });
    const p = await poll(await createPrediction(job.prompt));
    const outputs = Array.isArray(p.output) ? p.output : [p.output];
    let i = 0;
    for (const url of outputs) {
      const dest = path.join(dir, `albedo${outputs.length > 1 ? '_' + i++ : ''}.png`);
      await download(url, dest);
      console.log(`  saved ${dest}`);
    }
    await writeFile(path.join(dir, 'prompt.txt'), job.prompt + '\n');
  }
  console.log(
    '\nDone. Next: derive normal + roughness maps from each albedo\n' +
    '(e.g. with sharp: high-pass -> normal, inverted luminance -> roughness),\n' +
    'then wire the maps into applyTheme() per CLAUDE.md section 3.'
  );
}

run().catch(e => { console.error(e); process.exit(1); });
