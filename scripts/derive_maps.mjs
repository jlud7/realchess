#!/usr/bin/env node
/**
 * Derives PBR maps (albedo/normal/roughness) from the raw Replicate albedo
 * renders in assets/generated/<name>/albedo*.png, writing the final maps to
 * assets/textures/<name>/.
 *
 * Pipeline per material:
 *   1. Load the chosen albedo*.png (see CHOSEN below when a job produced
 *      several candidates), resize to 1024x1024.
 *   2. Seam-blend pass: roll the image 50%/50% with wraparound so the
 *      original tile edges land on a "+" cross through the center, then
 *      soften just that ~64px-wide cross with a locally blurred fill,
 *      cross-faded in with a feathered (smoothstep) mask. This hides the
 *      hard seam without touching the rest of the texture.
 *   3. albedo.jpg: the seam-blended image, quality 88.
 *   4. normal.png: luminance -> high-pass (subtract a sigma~8 gaussian
 *      blur, giving a zero-mean height field) -> Sobel gradients (wrapped
 *      at the edges, since the source now tiles) -> tangent-space normal
 *      (128,128,255 neutral), strength tuned per material so wood pore /
 *      felt nap reads without looking embossed.
 *   5. roughness.jpg: inverted luminance of the same seam-blended image,
 *      contrast-normalized then remapped into a per-material [min,max]
 *      range (see ROUGHNESS_RANGE).
 *   6. tile_check.jpg: the seam-blended albedo tiled 2x2, dropped next to
 *      the raw generation in assets/generated/<name>/ for a quick human
 *      seam check.
 *
 * Usage: node scripts/derive_maps.mjs [nameFilter]
 */

import sharp from 'sharp';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SIZE = 1024;
const GEN_DIR = path.join('assets', 'generated');
const OUT_DIR = path.join('assets', 'textures');

// When a job generated multiple candidates (albedo_0.png, albedo_1.png, ...)
// pick the index judged best for seamlessness / lack of artifacts. Index 0
// is the default when unspecified or when only one candidate exists.
const CHOSEN = {
  'walnut-dark-squares': 0, // fine even straight grain, best for per-square veneer
  'maple-light-squares': 1, // subtler figure, lowest wrap-seam error
  'walnut-frame': 0, // finer long grain, lower wrap-seam error
  'oak-table': 0, // candidate 1 has a plank joint right on the wrap edge
};

// Roughness target range [min, max] in 0..1, per material family.
const ROUGHNESS_RANGE = {
  'walnut-dark-squares': [0.35, 0.65],
  'maple-light-squares': [0.35, 0.65],
  'walnut-frame': [0.35, 0.65],
  'oak-table': [0.4, 0.7], // waxed matte oak, slightly rougher than satin veneer
  'green-baize': [0.8, 0.95],
  'boxwood-pieces': [0.25, 0.5],
  'ebony-pieces': [0.25, 0.5],
};
const DEFAULT_ROUGHNESS_RANGE = [0.4, 0.7];

// Normal map strength per material family (higher = more pronounced bump).
const NORMAL_STRENGTH = {
  'walnut-dark-squares': 1.4,
  'maple-light-squares': 1.2,
  'walnut-frame': 1.4,
  'oak-table': 1.8, // more pronounced pore structure
  'green-baize': 0.9, // fine felt nap, subtle
  'boxwood-pieces': 0.6, // lacquered, should read mostly smooth
  'ebony-pieces': 0.6,
};
const DEFAULT_NORMAL_STRENGTH = 1.2;

const HIGHPASS_SIGMA = 8;
const SEAM_BAND = 64; // feather half-width in px around the center cross

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

async function loadRGB(file) {
  const { data, info } = await sharp(file)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels };
}

// Even out low-frequency illumination gradients (soft vignettes / lighting
// drift in the AI renders) so the tile repeats without blocky luminance
// patches. Per channel: subtract (largeBlur - channelMean) scaled by
// FLATTEN_STRENGTH. Grain (high frequency) is untouched.
const FLATTEN_SIGMA = 80;
const FLATTEN_STRENGTH = 0.85;

async function flattenIllumination(data, width, height, channels) {
  const { data: blurred } = await sharp(Buffer.from(data), { raw: { width, height, channels } })
    .blur(FLATTEN_SIGMA)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = width * height;
  const mean = new Float64Array(channels);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) mean[c] += blurred[i * channels + c];
  for (let c = 0; c < channels; c++) mean[c] /= n;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const c = i % channels;
    out[i] = clamp(Math.round(data[i] - FLATTEN_STRENGTH * (blurred[i] - mean[c])), 0, 255);
  }
  return out;
}

// Roll (wrap-around shift) an interleaved RGB buffer by (dx, dy).
function roll(data, width, height, channels, dx, dy) {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const sy = (y + dy + height) % height;
    for (let x = 0; x < width; x++) {
      const sx = (x + dx + width) % width;
      const srcIdx = (sy * width + sx) * channels;
      const dstIdx = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) out[dstIdx + c] = data[srcIdx + c];
    }
  }
  return out;
}

// Seam-blend: shift 50%/50% with wrap so the original tile edges land on a
// "+" cross through the center, then cross-fade the ORIGINAL (unshifted)
// image back in over a feathered band straddling that cross. The original
// is perfectly continuous exactly where the shifted copy has its seam (its
// own seam sits at the outer border, where the shifted copy is continuous
// and the blend weight is 0), so the band is filled with real texture and
// the result wraps in both axes with no hard edge anywhere.
function seamBlend(data, width, height, channels) {
  const shifted = roll(data, width, height, channels, width / 2, height / 2);

  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8Array(shifted.length);
  for (let y = 0; y < height; y++) {
    const distY = Math.min(Math.abs(y - cy), height - Math.abs(y - cy));
    for (let x = 0; x < width; x++) {
      const distX = Math.min(Math.abs(x - cx), width - Math.abs(x - cx));
      // Weight is highest exactly on the cross, feathering to 0 over SEAM_BAND px.
      const wX = 1 - smoothstep(0, SEAM_BAND, distX);
      const wY = 1 - smoothstep(0, SEAM_BAND, distY);
      const w = Math.max(wX, wY);
      const idx = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) {
        out[idx + c] = Math.round(shifted[idx + c] * (1 - w) + data[idx + c] * w);
      }
    }
  }
  return out;
}

function luminance(data, width, height, channels) {
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += channels) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return lum;
}

async function blurLuminance(lum, width, height, sigma) {
  const u8 = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) u8[i] = clamp(Math.round(lum[i]), 0, 255);
  const { data } = await sharp(Buffer.from(u8), { raw: { width, height, channels: 1 } })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(lum.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  return out;
}

function sobel(height2d, width, height) {
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const at = (x, y) => height2d[((y + height) % height) * width + ((x + width) % width)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
      const ml = at(x - 1, y), mr = at(x + 1, y);
      const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
      gx[y * width + x] = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      gy[y * width + x] = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
    }
  }
  return { gx, gy };
}

async function makeNormalMap(albedoData, width, height, channels, strength) {
  const lum = luminance(albedoData, width, height, channels);
  const blurred = await blurLuminance(lum, width, height, HIGHPASS_SIGMA);
  const heightField = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) heightField[i] = lum[i] - blurred[i]; // zero-mean high-pass

  const { gx, gy } = sobel(heightField, width, height);
  // Sobel kernel sum of one-sided weights is 4; normalize to per-pixel slope, then apply strength.
  const k = strength / (4 * 255);
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const nx = -gx[i] * k;
    const ny = -gy[i] * k;
    const nz = 1;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    out[i * 3] = clamp(Math.round((nx / len * 0.5 + 0.5) * 255), 0, 255);
    out[i * 3 + 1] = clamp(Math.round((ny / len * 0.5 + 0.5) * 255), 0, 255);
    out[i * 3 + 2] = clamp(Math.round((nz / len * 0.5 + 0.5) * 255), 0, 255);
  }
  return sharp(Buffer.from(out), { raw: { width, height, channels: 3 } }).png();
}

async function makeRoughnessMap(albedoData, width, height, channels, range) {
  const lum = luminance(albedoData, width, height, channels);
  let min = 255, max = 0;
  for (const v of lum) { if (v < min) min = v; if (v > max) max = v; }
  const spread = Math.max(max - min, 1);
  const [rMin, rMax] = range;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < lum.length; i++) {
    const norm = (lum[i] - min) / spread; // 0..1, bright = high value
    const inverted = 1 - norm; // dark wood pore / shadow = rougher
    const mapped = rMin + inverted * (rMax - rMin);
    out[i] = clamp(Math.round(mapped * 255), 0, 255);
  }
  return sharp(Buffer.from(out), { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .jpeg({ quality: 88 });
}

async function tileCheck(seamBlended, width, height, channels, dest) {
  const tileImg = sharp(Buffer.from(seamBlended), { raw: { width, height, channels } });
  const tileBuf = await tileImg.png().toBuffer();
  const canvas = sharp({
    create: { width: width * 2, height: height * 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });
  const composited = await canvas
    .composite([
      { input: tileBuf, left: 0, top: 0 },
      { input: tileBuf, left: width, top: 0 },
      { input: tileBuf, left: 0, top: height },
      { input: tileBuf, left: width, top: height },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFile(dest, composited);
}

async function findAlbedoFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter(f => /^albedo(_\d+)?\.png$/.test(f)).sort();
}

async function processJob(name) {
  const genDir = path.join(GEN_DIR, name);
  const files = await findAlbedoFiles(genDir);
  if (!files.length) {
    console.log(`[${name}] no albedo*.png found, skipping`);
    return { name, status: 'missing' };
  }
  const idx = CHOSEN[name] ?? 0;
  const chosenFile = files[idx] || files[0];
  const srcPath = path.join(genDir, chosenFile);
  console.log(`[${name}] using ${chosenFile} (of ${files.length} candidate${files.length > 1 ? 's' : ''})`);

  const { data, width, height, channels } = await loadRGB(srcPath);
  const flattened = await flattenIllumination(data, width, height, channels);
  const blended = seamBlend(flattened, width, height, channels);

  const outDir = path.join(OUT_DIR, name);
  await mkdir(outDir, { recursive: true });

  const albedoBuf = await sharp(Buffer.from(blended), { raw: { width, height, channels } })
    .jpeg({ quality: 88 })
    .toBuffer();
  await writeFile(path.join(outDir, 'albedo.jpg'), albedoBuf);

  const strength = NORMAL_STRENGTH[name] ?? DEFAULT_NORMAL_STRENGTH;
  const normalSharp = await makeNormalMap(blended, width, height, channels, strength);
  await normalSharp.toFile(path.join(outDir, 'normal.png'));

  const range = ROUGHNESS_RANGE[name] ?? DEFAULT_ROUGHNESS_RANGE;
  const roughSharp = await makeRoughnessMap(blended, width, height, channels, range);
  await roughSharp.toFile(path.join(outDir, 'roughness.jpg'));

  await tileCheck(blended, width, height, channels, path.join(genDir, 'tile_check.jpg'));

  console.log(`  wrote ${outDir}/{albedo.jpg,normal.png,roughness.jpg} + ${genDir}/tile_check.jpg`);
  return { name, status: 'ok', srcFile: chosenFile, candidates: files.length };
}

async function run() {
  const filter = process.argv[2] || '';
  let names;
  try {
    names = (await readdir(GEN_DIR)).filter(n => n.includes(filter));
  } catch {
    console.error(`Cannot read ${GEN_DIR}; run generate_assets.mjs first.`);
    process.exit(1);
  }
  const results = [];
  for (const name of names) {
    try {
      results.push(await processJob(name));
    } catch (e) {
      console.error(`[${name}] failed: ${e.stack || e.message}`);
      results.push({ name, status: 'error', error: e.message });
    }
  }
  console.log('\n=== derive_maps summary ===');
  for (const r of results) console.log(` ${r.name}: ${r.status}${r.srcFile ? ' <- ' + r.srcFile : ''}`);
}

run().catch(e => { console.error(e); process.exit(1); });
