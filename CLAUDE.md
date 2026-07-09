# Chessboard — Photorealism Pass

## Mission
Take `index.html` (a working, self-contained 3D chessboard) from "good stylized 3D"
to "looks like a photograph of a real board on a real table." The chess rules engine,
interaction model, themes, and UI are done and correct — do not redesign them.
This session is about rendering fidelity only.

## What already works (do not break)
- `index.html` is fully self-contained: engine, scene, UI, themes, sound.
- Chess engine (section 1 of the inline script) is perft-verified
  (startpos d1–d4 exact, Kiwipete d3 exact, EP position d4 exact). Never modify it.
- Interaction: click/hover selection with glow, legal-move markers, animated moves,
  captured-piece trays, promotion picker, undo (full scene resync), flip/reset camera.
- Custom damped orbit camera (there is intentionally no OrbitControls dependency).
- Four themes + Daylight/Lamplight environments; theme changes retint everything live.

## Architecture map (inline script sections)
1. Chess engine (pure, frozen)
2. THEMES config object
3. Renderer / camera / lights / PMREM environment (`buildEnvironment`)
4. Procedural textures (`makeGrainTexture`, `makeLabelTexture`)
5. Board / table / frame / notation construction
6. Piece geometry (lathe profiles in `PROFILES`, knight extrusions, `buildPiece`,
   per-piece materials via `updatePieceMaterial`)
7. Game-state <-> scene sync (`pieceAt`, `syncFromBoard`, trays)
8. Tween system
9. Selection / raycasting / pointer input
10. Sound (synthesized)
11. Theme + environment application
12. UI wiring
13. Render loop

## Realism plan, in priority order

### 1. Real HDRI environment (highest impact, no Replicate needed)
Replace the procedural canvas equirect in `buildEnvironment` with real 2K HDRIs:
- Daylight: an interior daylight HDRI (e.g., Poly Haven CC0 — `studio_small_09`,
  `lebombo`, or a library/study interior).
- Lamplight: a dim warm interior HDRI (e.g., `moonless_golf` is too outdoor;
  prefer `hotel_room` or similar dim interior).
Download into `assets/hdri/`, load with `RGBELoader`, keep the PMREM pipeline.
Keep the procedural version as a fallback if the file is missing.

### 2. Upgrade three.js
Move from r128 (CDN) to a modern pinned version (>= r160) via npm + Vite, enabling:
- `renderer.physicallyCorrectLights` semantics (default in new versions)
- Better PMREM / IBL quality, `RGBELoader`, `EXRLoader`
- `postprocessing` or three's own `EffectComposer`: SSAO (N8AO is excellent),
  subtle bloom OFF (bloom reads as CG), vignette very subtle, SMAA.
Migration notes: `outputEncoding` -> `outputColorSpace`, `sRGBEncoding` ->
`SRGBColorSpace`, geometry APIs are compatible. The custom orbit code ports as-is.

### 3. PBR texture sets for board + table (Replicate or Poly Haven)
Current: procedural color-only grain. Target: full PBR (albedo + normal +
roughness) with correct UV scale:
- Board squares: fine-grained maple + walnut, plank-scale grain, per-square
  UV offset/rotation preserved (the existing code already randomizes offsets —
  keep that, it sells "individual veneer squares").
- Frame: rift-sawn walnut, long grain running around the border.
- Table: larger plank scale, slightly duller roughness.
Sources, either/both:
  a) Poly Haven CC0 wood sets (fastest, highest quality).
  b) Replicate: generate seamless tileable sets — see `scripts/generate_assets.mjs`.
     Generate albedo, then derive normal/roughness maps (the script includes a
     model slot for a texture/material model; verify the current best on
     replicate.com/explore — candidates change monthly).

### 4. Piece material upgrade
- Wood pieces: add normal map (fine turned-grain rings), slight roughness map
  variation, keep clearcoat low (0.1–0.2). Boxwood stays warm ochre — never white.
- Add `sheen` for the felt base pads: add a thin dark felt disc under each piece
  (radius = base radius, 2mm proud) with high-roughness dark green/red material.
  Real Staunton pieces all have felted bases and it grounds them visually.
- Subsurface-ish cheat for boxwood: tiny `transmission` is too costly; instead
  bake a light AO ring into the albedo via a radial gradient texture.

### 5. Grounding: contact shadows + AO
- SSAO via postprocessing (N8AO) at low intensity.
- Optional: blurred planar contact-shadow texture under the board
  (three.js "contact shadows" pattern) — pieces already cast PCF soft shadows.

### 6. Optional, only if the above lands: real GLTF Staunton set
The lathe pieces are decent; a museum-quality CC0 Staunton GLTF (check
Smithsonian 3D, Sketchfab CC0) with the SAME piece registration (1 unit squares,
`sqPos()` centers, group per piece with `userData.pieceType/pieceColor/mat`)
can be swapped in inside `buildPiece` without touching any game code.
Replicate image->3D models (TRELLIS etc.) are NOT recommended for pieces —
output topology/symmetry is not yet at turned-piece quality. Use Replicate for
textures/HDRI variants, not meshes.

## Replicate usage
- Token: `export REPLICATE_API_TOKEN=...` (never commit it).
- `scripts/generate_assets.mjs` is a working REST scaffold: create prediction,
  poll, download outputs to `assets/generated/`. Fill in the chosen model slug
  and per-material prompts (seamless, top-down, diffuse-only, no shadows).
- Budget sanity: a handful of texture generations, not per-square uniqueness.

## Acceptance criteria
- Side-by-side screenshot vs. current `index.html` shows: no white-plastic
  speculars, visible wood pore/normal response under orbiting light, pieces
  grounded (contact shadow), HDRI reflections sliding across pieces on orbit.
- 60fps on an M-series Mac at 1440p with SSAO on.
- All interaction still works: select/hover glow, legal markers, move/capture
  animations, trays, promotion, undo, flip/reset, themes, both environments.
- Engine untouched (diff shows zero changes in section 1).

## Style notes for this codebase
- No em dashes in any user-facing copy.
- Palette discipline: warm brass/walnut UI, True/Dark Autumn sensibility.
- Keep it one page unless Vite migration happens; if it does, keep modules few
  and obvious: `engine.js`, `scene.js`, `pieces.js`, `ui.js`, `main.js`.
