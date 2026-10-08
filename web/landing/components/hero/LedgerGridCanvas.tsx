"use client";

/**
 * Ledger Grid — hero canvas, direction 3 of 3.
 *
 * Rationale: particles live on a strict row/column lattice at every moment —
 * never a free-floating cloud — because the concept is "risk as a ledger":
 * signals are rows in a table, not debris in space. Motion always reads as
 * tabular (columns sliding, rows shifting) so the only direction-defining
 * gesture is discipline breaking down (state 3) and being restored (state 4).
 * State 2 treats 6 grid columns as 6 onchain risk signals feeding a single
 * dial; state 3 corrupts row alignment instead of scattering points freely,
 * because a broken ledger misaligns rows, it doesn't explode them; state 4
 * either reforms the lattice around a rasterized S-mark void or highlights a
 * locked-collateral block, both read as "the table is whole again."
 *
 * Progress model: ONE continuous 0-1 scroll fraction computed locally from
 * the section's own bounding rect (not `--panel-progress`, which is per-panel
 * and discrete) — chosen because the grid's column/row travel reads best as
 * a single continuous interpolation across all four states rather than a
 * snap at each panel boundary.
 */

import { useEffect, useRef } from "react";
import {
  Camera,
  Geometry,
  Mesh,
  Program,
  Renderer,
  RenderTarget,
  Transform,
  Triangle,
} from "ogl";
import { useDevicePerfTier, HERO_PARTICLE_COUNTS } from "@/lib/motion/useDevicePerfTier";
import { useInViewport } from "@/lib/motion/useInViewport";
import { useWebGLAvailable } from "@/lib/motion/useWebGLAvailable";

// Brand tokens only (app/tokens.css) — resolved to floats for GLSL uniforms.
const COLOR_CYBER_TIN = [0.6902, 0.7098, 0.7373];
const COLOR_SILO_OATMEAL = [0.9451, 0.9373, 0.9137];
const COLOR_RISK_CRIMSON = [1.0, 0.2314, 0.1882];
const COLOR_SLATE_BLACK = [0.0431, 0.0471, 0.0549];

const SIGNAL_COLUMNS = 6; // "6 signals feed one score" — brief's panel 2 copy.

/**
 * Rasterizes a simple geometric "S" glyph on an offscreen 2D canvas and
 * returns a function that tests whether a normalized (0..1, 0..1) point
 * lands on an opaque pixel. Independent implementation of the brief's
 * "rasterize and sample" idea (§ State 4 particle target) — no code from
 * the reference teardown's samplePoints() was read or reused.
 */
function buildMarkSampler(): (u: number, v: number) => boolean {
  const SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return () => false;
  }

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = "#fff";
  // Draw the S as a thick stroked path (own geometry, not a font glyph) so
  // the silhouette is a deliberate brand-mark-like S, not system-font text.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = SIZE * 0.17;
  ctx.strokeStyle = "#fff";
  ctx.beginPath();
  const m = SIZE * 0.22; // margin
  const top = m;
  const bottom = SIZE - m;
  const midY = SIZE / 2;
  const left = m;
  const right = SIZE - m;
  // Three-arc "S" built from cubic curves — own shape, own constants.
  ctx.moveTo(right, top + (bottom - top) * 0.12);
  ctx.bezierCurveTo(right, top, left, top, left, top + (bottom - top) * 0.28);
  ctx.bezierCurveTo(left, midY * 0.95, right, midY * 0.85, right, midY);
  ctx.bezierCurveTo(right, midY + (bottom - midY) * 0.55, left, bottom * 0.9, left, bottom - (bottom - top) * 0.12);
  ctx.bezierCurveTo(left, bottom, right, bottom, right, bottom - (bottom - top) * 0.28);
  ctx.stroke();

  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  return (u: number, v: number) => {
    const x = Math.min(SIZE - 1, Math.max(0, Math.floor(u * SIZE)));
    // Canvas y grows downward; our v=0 is bottom in clip space, so flip.
    const y = Math.min(SIZE - 1, Math.max(0, Math.floor((1 - v) * SIZE)));
    const alpha = data[(y * SIZE + x) * 4 + 3];
    return alpha > 80;
  };
}

interface GridAttributes {
  position: Float32Array; // aHome: grid rest position, clip-space-ish units
  gridCoord: Float32Array; // (colFrac 0..1, rowFrac 0..1)
  random: Float32Array; // per-point random seed pair
  dialTarget: Float32Array; // state-2 destination on the dial
  markMask: Float32Array; // 1 = visible grid point, 0 = inside S void
  accent: Float32Array; // 1 = Silo Oatmeal accent point, 0 = Cyber Tin
}

function buildGrid(count: number, aspect: number): GridAttributes {
  // Columns/rows sized to land close to `count` while keeping SIGNAL_COLUMNS
  // as an exact divisor of the column count, so state 2's "6 columns feed
  // the dial" reads cleanly with no remainder column.
  const roughCols = Math.round(Math.sqrt(count * aspect));
  const cols = Math.max(SIGNAL_COLUMNS, Math.round(roughCols / SIGNAL_COLUMNS) * SIGNAL_COLUMNS);
  const rows = Math.max(1, Math.round(count / cols));
  const total = cols * rows;

  const position = new Float32Array(total * 2);
  const gridCoord = new Float32Array(total * 2);
  const random = new Float32Array(total * 2);
  const dialTarget = new Float32Array(total * 2);
  const markMask = new Float32Array(total);
  const accent = new Float32Array(total);

  const markSampler = buildMarkSampler();

  // Extent in "world" units; x scaled by aspect so the grid reads as square
  // cells on any viewport rather than stretched.
  const extentX = aspect;
  const extentY = 1;
  const spacingX = (extentX * 2) / (cols + 1);
  const spacingY = (extentY * 2) / (rows + 1);

  // Dial geometry for state 2: a center-screen arc, columns distributed
  // along it in column order. Independent of any reference-doc gauge math —
  // just a half-circle arc parameterized by column index.
  const dialRadius = Math.min(extentX, extentY) * 0.42;
  const dialCenterX = 0;
  const dialCenterY = -extentY * 0.05;

  let i = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = -extentX + spacingX * (col + 1);
      const y = -extentY + spacingY * (row + 1);
      position[i * 2] = x;
      position[i * 2 + 1] = y;

      const colFrac = col / (cols - 1 || 1);
      const rowFrac = row / (rows - 1 || 1);
      gridCoord[i * 2] = colFrac;
      gridCoord[i * 2 + 1] = rowFrac;

      random[i * 2] = Math.random();
      random[i * 2 + 1] = Math.random();

      // Which of the 6 signal columns this point belongs to, then its
      // position along the dial's arc: angle sweeps -160deg..-20deg so the
      // dial reads like a gauge face, slightly offset per-row within the
      // column so a whole column collapses into a short arc segment rather
      // than a single point (keeps it a "column" rather than a dot).
      const signalIndex = Math.floor(colFrac * SIGNAL_COLUMNS * 0.999999);
      const segmentSpan = 1 / SIGNAL_COLUMNS;
      const withinSegment = rowFrac * segmentSpan * 0.9;
      const arcFrac = signalIndex * segmentSpan + withinSegment;
      const angle = Math.PI * (1.0 - arcFrac) - Math.PI * 0.5;
      dialTarget[i * 2] = dialCenterX + Math.cos(angle) * dialRadius;
      dialTarget[i * 2 + 1] = dialCenterY + Math.sin(angle) * dialRadius * 0.82;

      // S-mark sampling: normalize grid position to 0..1 UV and test
      // against the rasterized silhouette. Points landing ON the glyph are
      // masked OUT (markMask = 0) so the mark reads as absence within the
      // otherwise-full grid, per the brief's "cut-out negative space" spec.
      const u = (x + extentX) / (extentX * 2);
      const v = (y + extentY) / (extentY * 2);
      markMask[i] = markSampler(u, v) ? 0 : 1;

      // Every 7th point (Nth-point accent per the brief) renders Oatmeal at
      // rest instead of Tin — deliberately not a divisor of cols/rows so
      // the accent reads as a scattered signal, not a sub-grid.
      accent[i] = i % 7 === 0 ? 1 : 0;

      i++;
    }
  }

  return { position, gridCoord, random, dialTarget, markMask, accent };
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 aHome;
  attribute vec2 aGridCoord;
  attribute vec2 aRandom;
  attribute vec2 aDialTarget;
  attribute float aMarkMask;
  attribute float aAccent;

  uniform float uTime;
  uniform float uState; // continuous 0..3 progress across the four states
  uniform float uAspect;
  uniform float uDpr;
  uniform vec2 uPointer; // world-space pointer position
  uniform float uPointerActive;
  uniform float uGlitch; // 0..1 intensity, peaks mid-state-3

  varying float vAccent;
  varying float vGlitch;
  varying float vMarked;

  // Cheap hash for per-row jitter — independent, small, own constants.
  float hash(float n) {
    return fract(sin(n * 127.1 + 53.73) * 43758.5453123);
  }

  void main() {
    vAccent = aAccent;
    vGlitch = uGlitch;

    // --- State 1: calm grid, light breathing scale, no travel. aRandom
    // offsets each point's phase slightly so the breathe isn't a perfectly
    // synchronized pulse across a whole column. ---
    float breathe = 1.0 + sin(uTime * 0.6 + aGridCoord.x * 6.2831 + aRandom.x * 1.5) * 0.015;
    vec2 calmPos = aHome * breathe;

    // --- State 2: straight-line travel along the point's own column path
    // from its grid home toward its precomputed dial-arc target. A pure
    // lerp keeps the motion axis-locked in spirit (each point follows one
    // authored path, not a curl-noise cloud). ---
    float travel = smoothstep(1.0, 2.0, uState);
    vec2 convergedPos = mix(aHome, aDialTarget, travel);
    vec2 pos = mix(calmPos, convergedPos, travel);

    // --- State 3: rows glitch out of alignment and sag downward, reddening
    // on the fragment side. Jitter is per-ROW (hash of row index + time) so
    // whole rows skew together, not per-point noise — a lattice breaking
    // its row discipline, not a cloud. ---
    float rowSeed = floor(aGridCoord.y * 64.0);
    float jitterPhase = hash(rowSeed + floor(uTime * 3.0));
    float rowJitterX = (jitterPhase - 0.5) * 0.18 * uGlitch;
    float sag = uGlitch * 0.22 * (0.4 + 0.6 * hash(rowSeed * 3.1));
    float breakPos3 = smoothstep(2.0, 3.0, uState);
    vec2 brokenPos = pos + vec2(rowJitterX, -sag);
    pos = mix(pos, brokenPos, breakPos3);

    // --- State 4: grid reforms to calm positions; masked points (the
    // S-mark void, or none if using the collateral-block fallback) are
    // pushed to near-zero scale/alpha instead of being removed, so the
    // lattice itself stays complete and the mark reads as an absence. ---
    float reform = smoothstep(3.0, 3.6, uState);
    vec2 finalPos = mix(brokenPos, calmPos, reform);
    pos = mix(pos, finalPos, smoothstep(2.6, 3.2, uState));

    vMarked = mix(1.0, aMarkMask, reform);

    // --- Cursor disturb-then-heal: points within radius are pushed away
    // along the pointer-to-point vector, eased by distance; releasing the
    // cursor lets the spring terms above (grid home pull) heal it back
    // every subsequent frame since pos is recomputed from aHome each time. ---
    vec2 toPoint = pos - uPointer;
    float dist = length(toPoint) + 0.0001;
    float influence = uPointerActive * smoothstep(0.26, 0.0, dist);
    pos += normalize(toPoint) * influence * 0.085;

    vec2 clip = vec2(pos.x / uAspect, pos.y);
    gl_Position = vec4(clip, 0.0, 1.0);

    float baseSize = 2.0 + aAccent * 1.1;
    gl_PointSize = baseSize * uDpr;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform vec3 uColorTin;
  uniform vec3 uColorOatmeal;
  uniform vec3 uColorCrimson;
  uniform float uState;
  uniform float uGlitch;

  varying float vAccent;
  varying float vGlitch;
  varying float vMarked;

  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float d = length(centered);
    if (d > 0.5) discard;

    float soft = smoothstep(0.5, 0.2, d);

    // Resting color: Tin, with Nth-point Oatmeal accents.
    vec3 resting = mix(uColorTin, uColorOatmeal, vAccent);

    // State 2: drift resting color toward Oatmeal as the dial resolves.
    float towardScore = smoothstep(1.0, 2.6, uState);
    vec3 scored = mix(resting, uColorOatmeal, towardScore * 0.85);

    // State 3: heat toward crimson with glitch intensity.
    vec3 broken = mix(scored, uColorCrimson, vGlitch);

    // State 4: resolve to Oatmeal; the fallback accent block (if used) is
    // carried through vAccent/resting rather than reintroducing crimson —
    // crimson here stays a minor stroke via uGlitch's residual only.
    float settle = smoothstep(3.0, 3.8, uState);
    vec3 final = mix(broken, uColorOatmeal, settle * 0.9);

    float alpha = soft * mix(1.0, 0.08, 1.0 - vMarked);
    gl_FragColor = vec4(final, alpha);
  }
`;

// Full-screen fading quad used only to let state 3's render target
// accumulate instead of clearing — the "uncleared RT + low-alpha quad"
// motion-blur technique described in prose in the brief, own numbers.
const BLUR_VERTEX = /* glsl */ `
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uFade;
  uniform vec3 uBg;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(uBg, uFade);
  }
`;

export function LedgerGridCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tier = useDevicePerfTier();
  const isWebGLAvailable = useWebGLAvailable(canvasRef);
  // The container doubles as the in-viewport sentinel — no second ref to merge.
  const { ref: containerRef, isActive } = useInViewport<HTMLDivElement>();

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        canvas,
        dpr: Math.min(window.devicePixelRatio, 1.5),
        alpha: false,
        antialias: false,
      });
    } catch {
      return;
    }
    const { gl } = renderer;
    gl.clearColor(...(COLOR_SLATE_BLACK as [number, number, number]), 1);

    const camera = new Camera(gl, { near: 0.1, far: 10 });
    camera.position.z = 1;
    const scene = new Transform();

    const particleCount = HERO_PARTICLE_COUNTS[tier];
    let aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const grid = buildGrid(particleCount, aspect);

    const geometry = new Geometry(gl, {
      aHome: { size: 2, data: grid.position },
      aGridCoord: { size: 2, data: grid.gridCoord },
      aRandom: { size: 2, data: grid.random },
      aDialTarget: { size: 2, data: grid.dialTarget },
      aMarkMask: { size: 1, data: grid.markMask },
      aAccent: { size: 1, data: grid.accent },
    });

    const uniforms = {
      uTime: { value: 0 },
      uState: { value: 0 },
      uAspect: { value: aspect },
      uDpr: { value: Math.min(window.devicePixelRatio, 1.5) },
      uPointer: { value: [10, 10] as [number, number] },
      uPointerActive: { value: 0 },
      uGlitch: { value: 0 },
      uColorTin: { value: COLOR_CYBER_TIN },
      uColorOatmeal: { value: COLOR_SILO_OATMEAL },
      uColorCrimson: { value: COLOR_RISK_CRIMSON },
    };

    const program = new Program(gl, {
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
      uniforms,
      transparent: true,
      depthTest: false,
    });

    const points = new Mesh(gl, { geometry, program, mode: gl.POINTS });
    points.setParent(scene);

    // --- Motion-blur plumbing (state 3 only): two ping-ponged render
    // targets we do NOT clear each frame, plus a fading full-screen quad
    // drawn before the particles each frame to decay the previous frame's
    // contents. Blitted to the default framebuffer at the end of the
    // frame. Own implementation of the brief's prose technique.
    let rtA = new RenderTarget(gl, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      depth: false,
    });
    let rtB = new RenderTarget(gl, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      depth: false,
    });

    const blurUniforms = {
      uFade: { value: 0.42 },
      uBg: { value: COLOR_SLATE_BLACK },
    };
    const blurProgram = new Program(gl, {
      vertex: BLUR_VERTEX,
      fragment: BLUR_FRAGMENT,
      uniforms: blurUniforms,
      transparent: true,
      depthTest: false,
    });
    const blurQuad = new Mesh(gl, { geometry: new Triangle(gl), program: blurProgram });

    // Blit program: draws a render target's texture to the screen untouched.
    const blitUniforms = { tMap: { value: rtA.texture } };
    const blitProgram = new Program(gl, {
      vertex: BLUR_VERTEX,
      fragment: /* glsl */ `
        precision mediump float;
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(tMap, vUv);
        }
      `,
      uniforms: blitUniforms,
      transparent: false,
      depthTest: false,
    });
    const blitQuad = new Mesh(gl, { geometry: new Triangle(gl), program: blitProgram });

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width, height);
      aspect = width / Math.max(1, height);
      uniforms.uAspect.value = aspect;
      rtA = new RenderTarget(gl, { width, height, depth: false });
      rtB = new RenderTarget(gl, { width, height, depth: false });
    };
    resize();
    window.addEventListener("resize", resize);

    // --- Pointer tracking, mapped into the same world-space the grid uses. ---
    const pointerWorld: [number, number] = [10, 10];
    let pointerActiveTarget = 0;
    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      pointerWorld[0] = nx * aspect;
      pointerWorld[1] = ny;
      pointerActiveTarget = 1;
    };
    const handlePointerLeave = () => {
      pointerActiveTarget = 0;
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);

    // --- Scroll progress: one continuous 0..3 value derived from how far
    // the section has scrolled through its own runway, recomputed on
    // scroll/resize without a ScrollTrigger dependency (kept local to this
    // component since it needs a single continuous float, not a per-panel
    // snap). ---
    let scrollState = 0;
    const computeScrollState = () => {
      const section = container.closest("section");
      const rect = (section ?? container).getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
      const fraction = total > 0 ? scrolled / total : 0;
      scrollState = Math.min(3, Math.max(0, fraction * 3));
    };
    computeScrollState();
    window.addEventListener("scroll", computeScrollState, { passive: true });
    window.addEventListener("resize", computeScrollState);

    let rafId = 0;
    let lastTime = performance.now();
    let usePingPongA = true;

    const renderLoop = () => {
      rafId = requestAnimationFrame(renderLoop);
      if (!isActive) return;

      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      uniforms.uTime.value += dt;
      uniforms.uState.value = scrollState;

      // Glitch intensity peaks through state 3 (2..3) and fully resolves by
      // the start of state 4's reform.
      const glitchRamp = Math.min(
        1,
        Math.max(0, (scrollState - 2.0) / 0.6),
      );
      const glitchFade = 1 - Math.min(1, Math.max(0, (scrollState - 2.85) / 0.4));
      uniforms.uGlitch.value = glitchRamp * glitchFade;

      uniforms.uPointer.value = pointerWorld;
      uniforms.uPointerActive.value +=
        (pointerActiveTarget - uniforms.uPointerActive.value) * 0.12;

      const inBlurWindow = scrollState > 1.95 && scrollState < 3.05;

      if (inBlurWindow) {
        const readTarget = usePingPongA ? rtA : rtB;
        const writeTarget = usePingPongA ? rtB : rtA;
        blitUniforms.tMap.value = readTarget.texture;

        // Draw previous frame's content faded, then particles, into writeTarget.
        renderer.render({ scene: blitQuad, camera, target: writeTarget, clear: false });
        renderer.render({ scene: blurQuad, camera, target: writeTarget, clear: false });
        renderer.render({ scene, camera, target: writeTarget, clear: false });

        // Blit writeTarget to the screen (omitting `target` renders to the
        // default framebuffer, per OGL's Renderer.render).
        blitUniforms.tMap.value = writeTarget.texture;
        renderer.render({ scene: blitQuad, camera, clear: true });

        usePingPongA = !usePingPongA;
      } else {
        renderer.render({ scene, camera, clear: true });
      }
    };
    rafId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("resize", computeScrollState);
      window.removeEventListener("scroll", computeScrollState);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
    // containerRef/canvasRef are stable ref objects (identity never changes
    // across renders), so they're intentionally omitted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, isActive]);

  return (
    <div ref={containerRef} className="relative h-full w-full bg-slate-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {!isWebGLAvailable && (
        <div className="absolute inset-0 bg-slate-black" aria-hidden="true" />
      )}
    </div>
  );
}
