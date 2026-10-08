"use client";

/**
 * Horizon Line — hero direction.
 *
 * Rationale: the peg is a single number people stare at on a dashboard, so
 * the whole hero is staged as one instrument line rather than a diffuse
 * cloud — it reads calm when flat, legible when it reorganizes into a
 * readout, and alarming the instant it visibly sags and breaks. Particles
 * are kept inside a shallow horizontal band at every state (including the
 * converge and settle states) so the piece stays a "signal", never a
 * generic particle-system showcase, and the camera never moves — only the
 * band's internal geometry changes. State 4 resolves into stacked
 * collateral bars rather than the sampled S-mark: it keeps the same
 * horizontal-line vocabulary as states 1-3 (a resolved stack of lines reads
 * as "the position is now solid," without introducing a logo shape that
 * would break the single-signal metaphor established in state 1).
 *
 * Progress model: ONE continuous scroll progress (0-3 across the 4 panels)
 * computed from each panel's bounding rect in the animation loop (not the
 * per-panel --panel-progress CSS vars, which are designed for the
 * panel-entrance fade and reset per panel rather than compose into a single
 * monotonic value). States blend continuously into each other rather than
 * snapping, which suits a single line morphing shape more than four
 * discrete poses would.
 *
 * Per-state particle behavior:
 *  1. Holding the peg — tight band, per-particle curl-noise drift (own
 *     formula, see curlDrift() below), ~92% Cyber Tin / 8% Silo Oatmeal.
 *  2. Signals become a score — band splits into 6 streams (one per signal
 *     type) that arc toward a shared center point and orbit it like a
 *     gauge needle sweep; color drifts Tin -> Oatmeal.
 *  3. The peg breaks — streams reconverge into the band, then the band
 *     fractures into chunks that sag under a fake-gravity term below a
 *     static threshold line (SVG overlay); color ramps to Risk Crimson;
 *     this is the only state with motion-blur trails (uncleared
 *     RenderTarget ping-pong + fading quad).
 *  4. Cover pays — fractured chunks settle into N flat horizontal bars
 *     (collateral stack), mostly Silo Oatmeal with a thin Risk Crimson
 *     accent on the bottom bar's lower edge only.
 *
 * Cursor: world-space pointer position pushes nearby particles outward
 * (inverse-square-ish falloff) with a spring pulling them back to their
 * state target every frame — own constants, tuned by eye.
 */

import { useEffect, useRef } from "react";
import {
  Camera,
  Geometry,
  Mesh,
  Program,
  RenderTarget,
  Renderer,
  Transform,
} from "ogl";
import { useDevicePerfTier, HERO_PARTICLE_COUNTS } from "@/lib/motion/useDevicePerfTier";
import { useInViewport } from "@/lib/motion/useInViewport";
import { useWebGLAvailable } from "@/lib/motion/useWebGLAvailable";

const COLOR_SLATE_BLACK = "#0b0c0e";
const COLOR_SILO_OATMEAL = "#f1efe9";
const COLOR_CYBER_TIN = "#b0b5bc";
const COLOR_RISK_CRIMSON = "#ff3b30";

const SIGNAL_STREAM_COUNT = 6;
const COLLATERAL_BAR_COUNT = 5;
const RUNWAY_PANEL_COUNT = 4;

// -----------------------------------------------------------------------
// GLSL — original curl-noise-style drift, stream convergence, fracture and
// bar-settle math. Public-domain simplex-noise technique implemented from
// scratch; constants below are tuned by eye for this piece and are not
// taken from any reference doc.
// -----------------------------------------------------------------------

const VERTEX = /* glsl */ `
  attribute vec2 aBasePos;      // rest position along the horizon band, x in [-1,1], y jitter in [-1,1]
  attribute float aSeed;        // per-particle random in [0,1), drives drift phase / color flecks
  attribute float aStream;      // which of the 6 signal streams this particle belongs to (0..5)
  attribute float aBarSlot;     // which collateral bar this particle settles into in state 4 (0..N-1)
  attribute float aBarT;        // position along that bar's length, [0,1]
  attribute float aFracturePiece; // which fracture chunk this particle belongs to in state 3

  uniform float uTime;
  uniform float uProgress;      // 0..3 continuous across the 4 states
  uniform float uAspect;
  uniform vec2 uPointer;        // world-space pointer position
  uniform float uPointerActive;
  uniform float uDevicePixelRatio;
  uniform float uBasePointSize;

  varying float vSeed;
  varying float vHeat;          // 0 = cool brand tones, 1 = fully crimson-hot
  varying float vOatmealMix;    // 0 = tin, 1 = oatmeal
  varying float vAlpha;

  #define PI 3.14159265359

  // --- small hash / value-noise helpers (own implementation) ---
  float hash21(vec2 p) {
    p = fract(p * vec2(123.47, 345.91));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // Curl of a scalar noise field, approximated via a small finite-difference
  // stencil on two offset noise lookups — a standard, public-domain
  // curl-from-scalar-noise trick, own epsilon/scale constants.
  vec2 curlDrift(vec2 p, float t) {
    float eps = 0.08;
    vec2 timeOffset = vec2(t * 0.045, -t * 0.03);
    float n1 = valueNoise(p * 1.6 + timeOffset + vec2(0.0, eps));
    float n2 = valueNoise(p * 1.6 + timeOffset - vec2(0.0, eps));
    float n3 = valueNoise(p * 1.6 + timeOffset + vec2(eps, 0.0));
    float n4 = valueNoise(p * 1.6 + timeOffset - vec2(eps, 0.0));
    float dx = (n1 - n2) / (2.0 * eps);
    float dy = (n3 - n4) / (2.0 * eps);
    return vec2(dy, -dx);
  }

  // Smooth windowing helper: 1 inside [a,b], eased to 0 outside, clamp-safe.
  float windowMask(float x, float a, float b, float soft) {
    float lo = smoothstep(a - soft, a + soft, x);
    float hi = 1.0 - smoothstep(b - soft, b + soft, x);
    return lo * hi;
  }

  void main() {
    vSeed = aSeed;

    // uProgress drives 4 states: [0,1) state1->2, [1,2) state2->3, [2,3] state3->4
    float localProgress = clamp(uProgress, 0.0, 3.0);
    float s1to2 = clamp(localProgress, 0.0, 1.0);
    float s2to3 = clamp(localProgress - 1.0, 0.0, 1.0);
    float s3to4 = clamp(localProgress - 2.0, 0.0, 1.0);

    // ---- STATE 1: holding the peg ----
    vec2 drift = curlDrift(aBasePos * 2.0 + aSeed * 7.0, uTime) * 0.045;
    vec2 breathe = vec2(0.0, sin(uTime * 0.6 + aSeed * PI * 2.0) * 0.012);
    vec2 pos1 = aBasePos * vec2(1.0, 0.18) + drift + breathe;

    // ---- STATE 2: signals become a score ----
    // Each stream arcs from its slice of the band toward a shared center,
    // then settles into a slow orbit at a radius set by its stream index,
    // like six needles converging on one gauge face.
    float streamAngleBase = (aStream / float(${SIGNAL_STREAM_COUNT.toFixed(1)})) * PI * 2.0;
    float orbitRadius = 0.16 + 0.05 * fract(aStream * 0.37 + aSeed * 0.5);
    float orbitAngle = streamAngleBase + uTime * (0.25 + aStream * 0.015) + aSeed * PI * 0.5;
    vec2 gaugeTarget = vec2(cos(orbitAngle), sin(orbitAngle) * uAspect) * orbitRadius;
    // Streams travel from their resting band slice toward the gauge target.
    vec2 streamRest = vec2(aBasePos.x, aBasePos.y * 0.18 + (aStream - 2.5) * 0.02);
    vec2 pos2 = mix(streamRest, gaugeTarget, smoothstep(0.0, 1.0, s1to2));
    pos2 += drift * (1.0 - s1to2) * 0.6;

    // ---- STATE 3: the peg breaks ----
    // Streams pour back into the band, which then fractures into chunks
    // that sag below the threshold line under a fake-gravity pull.
    float fractureSpread = (aFracturePiece - 5.0) * 0.07;
    float sagAmount = pow(s2to3, 1.6) * (0.22 + 0.1 * fract(aFracturePiece * 0.63));
    vec2 chunkOffset = vec2(fractureSpread * s2to3, -sagAmount);
    vec2 jitter = curlDrift(aBasePos * 3.0 + aFracturePiece, uTime * 1.6) * 0.03 * s2to3;
    vec2 pos3 = mix(pos2, pos1 + chunkOffset + jitter, smoothstep(0.0, 1.0, s2to3));

    // ---- STATE 4: cover pays ----
    // Fractured chunks resolve into flat horizontal collateral bars.
    float barY = -0.42 + aBarSlot * 0.19;
    vec2 barTarget = vec2((aBarT - 0.5) * 1.5, barY);
    vec2 pos4 = mix(pos3, barTarget, smoothstep(0.0, 1.0, s3to4));

    vec2 finalPos = pos4;

    // ---- pointer disturb-then-heal ----
    vec2 toPoint = finalPos - uPointer;
    float dist = length(toPoint) + 0.0001;
    float influence = uPointerActive * smoothstep(0.35, 0.0, dist);
    vec2 push = normalize(toPoint) * influence * 0.12;
    finalPos += push;

    // ---- color / heat varyings ----
    float oatmealFleck = step(0.92, fract(aSeed * 13.1));
    vOatmealMix = mix(oatmealFleck, 1.0, smoothstep(0.0, 1.0, s1to2) * (1.0 - s2to3 * 0.3));
    vOatmealMix = mix(vOatmealMix, 1.0, s3to4);
    vHeat = smoothstep(0.15, 1.0, s2to3) * (1.0 - s3to4);
    vAlpha = 1.0;

    gl_Position = vec4(finalPos.x / uAspect, finalPos.y, 0.0, 1.0);
    gl_Position.x *= uAspect;

    float sizeBoost = 1.0 + vHeat * 0.9 + s3to4 * 0.4;
    gl_PointSize = uBasePointSize * uDevicePixelRatio * sizeBoost;
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform vec3 uColorTin;
  uniform vec3 uColorOatmeal;
  uniform vec3 uColorCrimson;
  uniform float uTrailAlpha; // 1.0 normally; lowered when drawing into the trail-blend pass

  varying float vSeed;
  varying float vHeat;
  varying float vOatmealMix;
  varying float vAlpha;

  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float d = length(centered);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);

    vec3 base = mix(uColorTin, uColorOatmeal, vOatmealMix);
    vec3 color = mix(base, uColorCrimson, vHeat);

    float alpha = core * vAlpha * uTrailAlpha;
    gl_FragColor = vec4(color, alpha);
  }
`;

// Full-screen fading quad used only for the state-3 motion-blur pass.
const TRAIL_VERTEX = /* glsl */ `
  attribute vec2 aPosition;
  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uPrevFrame;
  uniform float uFadeAlpha;
  uniform vec2 uResolution;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 prev = texture2D(uPrevFrame, uv);
    gl_FragColor = vec4(prev.rgb, prev.a * uFadeAlpha);
  }
`;

interface ParticleAttributes {
  basePos: Float32Array;
  seed: Float32Array;
  stream: Float32Array;
  barSlot: Float32Array;
  barT: Float32Array;
  fracturePiece: Float32Array;
}

function buildParticleAttributes(count: number): ParticleAttributes {
  const basePos = new Float32Array(count * 2);
  const seed = new Float32Array(count);
  const stream = new Float32Array(count);
  const barSlot = new Float32Array(count);
  const barT = new Float32Array(count);
  const fracturePiece = new Float32Array(count);

  const fractureChunkCount = 11;

  for (let i = 0; i < count; i++) {
    // Band is wide (x spans nearly the full width) and shallow (y jitter
    // kept small) so the rest geometry reads as one horizontal line.
    const x = (Math.random() * 2 - 1) * 0.98;
    const y = (Math.random() * 2 - 1) * 1.0;
    basePos[i * 2] = x;
    basePos[i * 2 + 1] = y;

    seed[i] = Math.random();
    stream[i] = Math.floor(Math.random() * SIGNAL_STREAM_COUNT);
    barSlot[i] = Math.floor(Math.random() * COLLATERAL_BAR_COUNT);
    barT[i] = Math.random();
    fracturePiece[i] = Math.floor(Math.random() * fractureChunkCount);
  }

  return { basePos, seed, stream, barSlot, barT, fracturePiece };
}

export function HorizonLineCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tier = useDevicePerfTier();
  const { ref: viewportRef, isActive } = useInViewport<HTMLDivElement>();
  const webglAvailable = useWebGLAvailable(canvasRef);

  // Combine the viewport ref and wrapper ref onto the same node.
  const setWrapperRef = (node: HTMLDivElement | null) => {
    wrapperRef.current = node;
    viewportRef.current = node;
  };

  // Threshold-line overlay opacity, driven by the same scroll progress the
  // canvas uses, exposed as a CSS var on the wrapper (state 3 only).
  const thresholdOpacityRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    if (!webglAvailable) return;

    const particleCount = HERO_PARTICLE_COUNTS[tier];

    const renderer = new Renderer({
      canvas,
      dpr: Math.min(window.devicePixelRatio || 1, 1.5),
      alpha: false,
      antialias: false,
    });
    const gl = renderer.gl;
    gl.clearColor(
      ...(hexToRgb(COLOR_SLATE_BLACK) as [number, number, number]),
      1,
    );

    const camera = new Camera(gl, { near: 0.01, far: 10 });
    camera.position.z = 1;

    const scene = new Transform();

    const { basePos, seed, stream, barSlot, barT, fracturePiece } =
      buildParticleAttributes(particleCount);

    const geometry = new Geometry(gl, {
      aBasePos: { size: 2, data: basePos },
      aSeed: { size: 1, data: seed },
      aStream: { size: 1, data: stream },
      aBarSlot: { size: 1, data: barSlot },
      aBarT: { size: 1, data: barT },
      aFracturePiece: { size: 1, data: fracturePiece },
    });

    const program = new Program(gl, {
      vertex: VERTEX,
      fragment: FRAGMENT,
      transparent: true,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uAspect: { value: 1 },
        uPointer: { value: [0, 0] },
        uPointerActive: { value: 0 },
        uDevicePixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) },
        uBasePointSize: { value: tier === "mobile" ? 3.2 : 2.4 },
        uColorTin: { value: hexToRgb(COLOR_CYBER_TIN) },
        uColorOatmeal: { value: hexToRgb(COLOR_SILO_OATMEAL) },
        uColorCrimson: { value: hexToRgb(COLOR_RISK_CRIMSON) },
        uTrailAlpha: { value: 1 },
      },
    });

    const points = new Mesh(gl, { geometry, program, mode: gl.POINTS });
    points.setParent(scene);

    // --- motion-blur trail resources (state 3 only) ---
    // Two offscreen render targets ping-ponged: each frame we draw the
    // previous target's contents through a low-alpha fading quad into the
    // current target (without clearing first), then draw the live points
    // on top, then blit that target to the screen. This is the "uncleared
    // render target + fading quad" technique described in prose in the
    // shared brief; alpha value and ping-pong bookkeeping below are our own.
    const targetA = new RenderTarget(gl, { depth: false });
    const targetB = new RenderTarget(gl, { depth: false });
    let readTarget = targetA;
    let writeTarget = targetB;

    const trailGeometry = new Geometry(gl, {
      aPosition: {
        size: 2,
        data: new Float32Array([-1, -1, 3, -1, -1, 3]),
      },
    });
    const trailProgram = new Program(gl, {
      vertex: TRAIL_VERTEX,
      fragment: TRAIL_FRAGMENT,
      transparent: true,
      depthTest: false,
      uniforms: {
        uPrevFrame: { value: null },
        uFadeAlpha: { value: 0.42 },
        uResolution: { value: [1, 1] },
      },
    });
    const trailMesh = new Mesh(gl, { geometry: trailGeometry, program: trailProgram });

    const blitGeometry = new Geometry(gl, {
      aPosition: {
        size: 2,
        data: new Float32Array([-1, -1, 3, -1, -1, 3]),
      },
    });
    const blitProgram = new Program(gl, {
      vertex: TRAIL_VERTEX,
      fragment: /* glsl */ `
        precision mediump float;
        uniform sampler2D uPrevFrame;
        uniform vec2 uResolution;
        void main() {
          vec2 uv = gl_FragCoord.xy / uResolution;
          gl_FragColor = texture2D(uPrevFrame, uv);
        }
      `,
      transparent: false,
      depthTest: false,
      uniforms: { uPrevFrame: { value: null }, uResolution: { value: [1, 1] } },
    });
    const blitMesh = new Mesh(gl, { geometry: blitGeometry, program: blitProgram });

    function resize() {
      const width = wrapper!.clientWidth;
      const height = wrapper!.clientHeight;
      renderer.setSize(width, height);
      const aspect = width / height;
      program.uniforms.uAspect.value = aspect;
      targetA.setSize(width * renderer.dpr, height * renderer.dpr);
      targetB.setSize(width * renderer.dpr, height * renderer.dpr);
      trailProgram.uniforms.uResolution.value = [
        width * renderer.dpr,
        height * renderer.dpr,
      ];
      blitProgram.uniforms.uResolution.value = [
        width * renderer.dpr,
        height * renderer.dpr,
      ];
    }
    resize();
    window.addEventListener("resize", resize);

    // --- scroll progress: one continuous 0..(RUNWAY_PANEL_COUNT-1) value ---
    let scrollProgress = 0;
    function computeScrollProgress() {
      const panels = wrapper!
        .closest("section")
        ?.querySelectorAll<HTMLElement>("[data-hero-panel]");
      if (!panels || panels.length === 0) return;
      const viewportCenter = window.innerHeight / 2;
      let raw = 0;
      for (let i = 0; i < panels.length; i++) {
        const rect = panels[i].getBoundingClientRect();
        const panelCenter = rect.top + rect.height / 2;
        const distance = viewportCenter - panelCenter;
        // Each panel contributes a 0..1 "arrival" amount based on how far
        // its center has crossed the viewport center, clamped per-segment.
        const t = clamp01(distance / rect.height + 0.5);
        if (i === 0) {
          raw = t > 0.5 ? 0 : 0; // panel 0 is the rest state; progress starts at panel 1
        } else {
          raw = Math.max(raw, (i - 1) + t);
        }
      }
      scrollProgress = clamp(raw, 0, RUNWAY_PANEL_COUNT - 1);
    }

    // --- pointer tracking ---
    const pointerWorld = { x: 0, y: 0, active: 0 };
    function handlePointerMove(event: PointerEvent) {
      const rect = wrapper!.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      pointerWorld.x = nx * program.uniforms.uAspect.value;
      pointerWorld.y = ny;
      pointerWorld.active = 1;
    }
    function handlePointerLeave() {
      pointerWorld.active = 0;
    }
    wrapper.addEventListener("pointermove", handlePointerMove);
    wrapper.addEventListener("pointerleave", handlePointerLeave);

    let rafId = 0;
    let running = true;
    const startTime = performance.now();

    function frame() {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      if (!isActive) return;

      const elapsed = (performance.now() - startTime) / 1000;
      computeScrollProgress();

      program.uniforms.uTime.value = elapsed;
      program.uniforms.uProgress.value = scrollProgress;
      program.uniforms.uPointer.value = [pointerWorld.x, pointerWorld.y];
      program.uniforms.uPointerActive.value +=
        (pointerWorld.active - program.uniforms.uPointerActive.value) * 0.12;

      const inState3 = scrollProgress >= 2 && scrollProgress < 3;
      thresholdOpacityRef.current = inState3
        ? Math.min(1, (scrollProgress - 2) * 2.2)
        : scrollProgress >= 3
          ? Math.max(0, 1 - (scrollProgress - 3) * 4)
          : 0;
      wrapper!.style.setProperty(
        "--threshold-opacity",
        thresholdOpacityRef.current.toString(),
      );

      if (inState3) {
        // Motion-blur pass: fade the previous frame into the write target,
        // then draw live points on top of it, then blit to screen.
        program.uniforms.uTrailAlpha.value = 1;
        trailProgram.uniforms.uPrevFrame.value = readTarget.texture;

        renderer.render({ scene: trailMesh, camera, target: writeTarget, clear: false });
        renderer.render({ scene: points, camera, target: writeTarget, clear: false });

        blitProgram.uniforms.uPrevFrame.value = writeTarget.texture;
        renderer.render({ scene: blitMesh, camera, clear: true });

        const tmp = readTarget;
        readTarget = writeTarget;
        writeTarget = tmp;
      } else {
        program.uniforms.uTrailAlpha.value = 1;
        renderer.render({ scene: points, camera, clear: true });
        // Reset trail targets so re-entering state 3 later doesn't blit a
        // stale trail from a previous pass.
        renderer.render({ scene: blitMesh, camera, target: readTarget, clear: true });
        renderer.render({ scene: blitMesh, camera, target: writeTarget, clear: true });
      }
    }

    frame();

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      wrapper.removeEventListener("pointermove", handlePointerMove);
      wrapper.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [tier, isActive, webglAvailable]);

  return (
    <div ref={setWrapperRef} className="relative h-full w-full bg-slate-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* Static threshold line overlay for state 3 ("the peg breaks"). */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ opacity: "var(--threshold-opacity, 0)" }}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="0"
          y1="50%"
          x2="100%"
          y2="50%"
          stroke="var(--color-cement-grey)"
          strokeWidth="1"
          strokeDasharray="6 10"
        />
      </svg>
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.substring(0, 2), 16) / 255;
  const g = parseInt(normalized.substring(2, 4), 16) / 255;
  const b = parseInt(normalized.substring(4, 6), 16) / 255;
  return [r, g, b];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}
