"use client";

// ----------------------------------------------------------------------------
// Depth Field — hero direction "Depth Field"
//
// Rationale: a full-viewport volumetric point cloud reads as a "trust field"
// you can see breathe, so the shift from calm to broken to covered feels like
// a physical property of the system rather than a chart changing value. Depth
// (point size/brightness falling off with simulated camera distance) and a
// single continuous progress scalar carry all four states, so the piece never
// needs the discrete snap-cuts a flatter 2D particle band would require.
// Layout is intentionally simpler than a ribbon-to-globe-to-burst sequence:
// one static camera, one point cloud, four readable configurations of it.
//
// Per-state particle behavior:
//   0 Holding the peg   — sparse volumetric scatter, slow curl-noise drift, Tin/Oatmeal.
//   1 Signals -> score  — ~6 clusters orbiting a shared center, Tin -> Oatmeal.
//   2 The peg breaks    — radial collapse toward center, crimson spreads outward
//                          from the core, motion-blur trails (state 2 only).
//   3 Cover pays        — snaps into an evenly-spaced 3D block lattice, Oatmeal
//                          dominant, one block edge carries a small crimson accent.
//
// Progress model: ONE continuous scroll progress (0..3) computed locally from
// GSAP ScrollTrigger across the full runway (not the shared per-panel
// --panel-progress vars, since those are per-panel CSS values and this scene
// wants one continuous float to drive GLSL state blending) — see useSceneProgress
// below. Curl noise, orbit/cluster placement, collapse and lattice math below
// are original formulas tuned by eye; no constants ported from reference docs.
// ----------------------------------------------------------------------------

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
  Vec2,
  Vec3,
} from "ogl";
import { useInViewport } from "@/lib/motion/useInViewport";
import { useWebGLAvailable } from "@/lib/motion/useWebGLAvailable";
import { useDevicePerfTier } from "@/lib/motion/useDevicePerfTier";
import { HERO_PARTICLE_COUNTS } from "@/lib/motion/useDevicePerfTier";

// Brand tokens (app/tokens.css) — resolved hex, never invented colors.
const COLOR_SLATE_BLACK: [number, number, number] = [0x0b / 255, 0x0c / 255, 0x0e / 255];
const COLOR_SILO_OATMEAL: [number, number, number] = [0xf1 / 255, 0xef / 255, 0xe9 / 255];
const COLOR_CYBER_TIN: [number, number, number] = [0xb0 / 255, 0xb5 / 255, 0xbc / 255];
const COLOR_RISK_CRIMSON: [number, number, number] = [0xff / 255, 0x3b / 255, 0x30 / 255];

const vertexShader = /* glsl */ `
  attribute vec3 position;
  attribute vec3 seed;      // xyz: stable per-point random values in [0,1)
  attribute float id;       // stable per-point index, normalized [0,1)

  uniform float uTime;
  uniform float uProgress;  // 0..3 continuous: 0 calm, 1 clusters, 2 collapse, 3 lattice
  uniform float uDpr;
  uniform vec2 uPointer;    // world-space xy of pointer on the z=0 plane
  uniform float uPointerActive;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;

  varying float vDepth;
  varying float vState;
  varying float vCrimsonMix;
  varying float vId;
  varying float vAccent;

  // --- original hash / value-noise, written from scratch for this scene ---
  float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  vec3 hash33(vec3 p) {
    float n = hash31(p);
    float n2 = hash31(p + 19.19);
    float n3 = hash31(p + 7.77);
    return vec3(n, n2, n3);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  // Curl of a scalar value-noise field (two offset samples per axis), our
  // own simple finite-difference curl — a standard public-domain technique,
  // own constants and sampling offsets.
  vec3 curlNoise(vec3 p) {
    float eps = 0.35;
    float n1 = valueNoise(p + vec3(0.0, eps, 0.0));
    float n2 = valueNoise(p - vec3(0.0, eps, 0.0));
    float n3 = valueNoise(p + vec3(0.0, 0.0, eps));
    float n4 = valueNoise(p - vec3(0.0, 0.0, eps));
    float n5 = valueNoise(p + vec3(eps, 0.0, 0.0));
    float n6 = valueNoise(p - vec3(eps, 0.0, 0.0));

    float x = (n1 - n2) - (n3 - n4);
    float y = (n3 - n4) - (n5 - n6);
    float z = (n5 - n6) - (n1 - n2);
    return normalize(vec3(x, y, z) + 1e-5);
  }

  // ---- state 0: holding the peg — sparse volumetric drift ----
  vec3 stateCalm(vec3 base, vec3 s, float t) {
    vec3 drift = curlNoise(base * 0.6 + vec3(0.0, 0.0, t * 0.035) + s * 2.0);
    return base + drift * 0.65;
  }

  // ---- state 1: signals become a score — 6 clusters orbiting a center ----
  vec3 stateClusters(vec3 base, vec3 s, float t, float pointId) {
    const float CLUSTER_COUNT = 6.0;
    float clusterId = floor(pointId * CLUSTER_COUNT * 0.999);
    float clusterAngle = (clusterId / CLUSTER_COUNT) * 6.28318530718;

    float orbitRadius = 2.6;
    float orbitSpeed = 0.18;
    float spin = clusterAngle + t * orbitSpeed;
    vec3 clusterCenter = vec3(cos(spin) * orbitRadius, sin(spin) * orbitRadius * 0.55, sin(spin * 0.7) * 0.9);

    // local offset within the cluster, its own gentle orbit around clusterCenter
    float localAngle = s.x * 6.28318530718 + t * (0.4 + s.y * 0.3);
    float localRadius = 0.18 + s.z * 0.5;
    vec3 localOffset = vec3(cos(localAngle) * localRadius, sin(localAngle) * localRadius, (s.y - 0.5) * 0.6);

    return clusterCenter + localOffset;
  }

  // ---- state 2: the peg breaks — radial collapse with inward twist ----
  vec3 stateCollapse(vec3 clustered, float t, float localProgress) {
    float twist = localProgress * 3.2 * (0.5 + hash31(clustered) * 0.5);
    float c = cos(twist);
    float sn = sin(twist);
    vec3 twisted = vec3(
      clustered.x * c - clustered.y * sn,
      clustered.x * sn + clustered.y * c,
      clustered.z
    );
    return mix(clustered, twisted * 0.15, localProgress);
  }

  // ---- state 3: cover pays — ordered 3D block lattice ----
  vec3 stateLattice(vec3 s, float pointId) {
    const float GRID_X = 9.0;
    const float GRID_Y = 6.0;
    const float GRID_Z = 5.0;
    float cellCount = GRID_X * GRID_Y * GRID_Z;
    float cellIndex = mod(floor(pointId * 4999.0), cellCount);

    float ix = mod(cellIndex, GRID_X);
    float iy = mod(floor(cellIndex / GRID_X), GRID_Y);
    float iz = floor(cellIndex / (GRID_X * GRID_Y));

    float spacing = 0.62;
    vec3 gridPos = vec3(
      (ix - (GRID_X - 1.0) * 0.5) * spacing,
      (iy - (GRID_Y - 1.0) * 0.5) * spacing,
      (iz - (GRID_Z - 1.0) * 0.5) * spacing - 0.4
    );

    // jitter each point to a slightly different position inside its block
    // so a "block" still reads as many points, not one dot.
    vec3 jitter = (s - 0.5) * spacing * 0.78;
    return gridPos + jitter;
  }

  void main() {
    vId = id;
    vec3 base = position;
    vec3 s = seed;

    float clampedProgress = clamp(uProgress, 0.0, 3.0);

    vec3 calmPos = stateCalm(base, s, uTime);
    vec3 clusterPos = stateClusters(base, s, uTime, id);

    // Segment 0->1: calm into clusters
    float seg01 = clamp(clampedProgress, 0.0, 1.0);
    vec3 pos = mix(calmPos, clusterPos, seg01);

    // Segment 1->2: clusters collapse inward, reddening outward from core
    float seg12 = clamp(clampedProgress - 1.0, 0.0, 1.0);
    vec3 collapsedPos = stateCollapse(clusterPos, uTime, seg12);
    pos = mix(pos, collapsedPos, seg12);

    // Segment 2->3: collapsed field resolves into the lattice
    float seg23 = clamp(clampedProgress - 2.0, 0.0, 1.0);
    vec3 latticePos = stateLattice(s, id);
    pos = mix(pos, latticePos, seg23);

    // cursor disturb-then-heal: push points away from pointer on the z=0
    // plane, decaying with distance; "heal" falls out naturally because the
    // push is recomputed fresh each frame from the live pointer uniform
    // rather than being integrated into position, so it springs back the
    // instant the pointer moves away.
    if (uPointerActive > 0.5) {
      vec2 toPoint = pos.xy - uPointer;
      float dist = length(toPoint);
      float radius = 1.4;
      float falloff = smoothstep(radius, 0.0, dist);
      float phase = sin(uTime * 2.2 + id * 37.0) * 0.5 + 0.5;
      vec2 push = normalize(toPoint + 1e-4) * falloff * (0.45 + phase * 0.25);
      pos.xy += push;
      pos.z += falloff * 0.12;
    }

    vState = clampedProgress;
    // crimson mix: ramps up through segment 1->2 (breaking), proportional to
    // distance-from-core so the reddening visibly spreads from the center
    // outward rather than tinting uniformly.
    float distFromCore = length(clusterPos) / 3.2;
    float breakHeat = seg12 * (1.0 - distFromCore * 0.6);
    vCrimsonMix = clamp(breakHeat, 0.0, 1.0);

    // lattice accent: a single small corner/edge of the lattice carries a
    // crimson accent once state 3 is reached, never dominant.
    float isAccentBlock = step(0.996, hash31(vec3(floor(id * 4999.0), 1.0, 2.0)));
    vAccent = isAccentBlock * seg23;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(-mvPosition.z, 0.001);
    vDepth = clamp(1.0 - (dist - 2.0) / 8.0, 0.0, 1.0);

    float baseSize = mix(14.0, 14.0, 0.0);
    float sizeByState = mix(10.0, mix(9.0, mix(7.0, 16.0, seg23), seg12), seg01);
    gl_PointSize = sizeByState * (0.35 + vDepth * 1.15) * uDpr;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uColorTin;
  uniform vec3 uColorOatmeal;
  uniform vec3 uColorCrimson;
  uniform float uProgress;

  varying float vDepth;
  varying float vState;
  varying float vCrimsonMix;
  varying float vId;
  varying float vAccent;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.1, d);

    // tin -> oatmeal across the whole runway (states 0 -> 3), with occasional
    // oatmeal flecks even at rest per brief's "mostly Tin + occasional Oatmeal".
    float toOatmeal = clamp(uProgress / 2.2, 0.0, 1.0);
    float fleck = step(0.92, fract(vId * 53.173));
    vec3 base = mix(uColorTin, uColorOatmeal, max(toOatmeal, fleck * 0.6));

    // crimson: only ever heats in from state 2, and as a small lattice accent.
    vec3 withCrimson = mix(base, uColorCrimson, clamp(vCrimsonMix + vAccent, 0.0, 1.0));

    float brightness = 0.55 + vDepth * 0.55;
    vec3 color = withCrimson * brightness;
    float alpha = soft * (0.55 + vDepth * 0.45);
    gl_FragColor = vec4(color, alpha);
  }
`;

// Fullscreen fading quad, used only while compositing the motion-blur trail
// render target during state 2 ("the peg breaks"). Uncleared RT + a low-alpha
// quad drawn each frame is a general accumulation-trail technique; the alpha
// value and blend setup here are our own, tuned by eye.
const trailFadeVertex = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const trailFadeFragment = /* glsl */ `
  precision mediump float;
  uniform vec3 uBackground;
  uniform float uFadeAlpha;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(uBackground, uFadeAlpha);
  }
`;

const blitVertex = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const blitFragment = /* glsl */ `
  precision mediump float;
  uniform sampler2D tMap;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tMap, vUv);
  }
`;

interface SceneHandles {
  renderer: Renderer;
  camera: Camera;
  scene: Transform;
  particles: Mesh;
  program: Program;
  pointerUniform: Vec2;
  pointerActiveUniform: { value: number };
  progressUniform: { value: number };
  timeUniform: { value: number };
  trailTargetA: RenderTarget;
  trailTargetB: RenderTarget;
  trailFadeMesh: Mesh;
  blitMesh: Mesh;
}

function buildScene(
  gl: Renderer["gl"],
  particleCount: number,
): Omit<SceneHandles, "renderer" | "camera" | "trailTargetA" | "trailTargetB"> {
  const scene = new Transform();

  const positions = new Float32Array(particleCount * 3);
  const seeds = new Float32Array(particleCount * 3);
  const ids = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    // sparse volumetric scatter inside a flattened sphere — real z variation,
    // not a thin band, so depth cues (size/brightness falloff) are visible.
    const radius = Math.cbrt(Math.random()) * 3.4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3 + 0] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.65;
    positions[i * 3 + 2] = radius * Math.cos(phi) * 0.9 - 1.0;

    seeds[i * 3 + 0] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();

    ids[i] = i / particleCount;
  }

  const geometry = new Geometry(gl, {
    position: { size: 3, data: positions },
    seed: { size: 3, data: seeds },
    id: { size: 1, data: ids },
  });

  const progressUniform = { value: 0 };
  const timeUniform = { value: 0 };
  const pointerUniform = new Vec2(0, 0);
  const pointerActiveUniform = { value: 0 };

  const program = new Program(gl, {
    vertex: vertexShader,
    fragment: fragmentShader,
    uniforms: {
      uTime: timeUniform,
      uProgress: progressUniform,
      uDpr: { value: Math.min(window.devicePixelRatio, 1.5) },
      uPointer: pointerUniform,
      uPointerActive: pointerActiveUniform,
      uColorTin: { value: COLOR_CYBER_TIN },
      uColorOatmeal: { value: COLOR_SILO_OATMEAL },
      uColorCrimson: { value: COLOR_RISK_CRIMSON },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const particles = new Mesh(gl, { geometry, program, mode: gl.POINTS });
  particles.setParent(scene);

  // Fullscreen triangle geometries for the trail-fade quad and the final blit.
  const trailFadeGeometry = new Triangle(gl);
  const trailFadeMesh = new Mesh(gl, {
    geometry: trailFadeGeometry,
    program: new Program(gl, {
      vertex: trailFadeVertex,
      fragment: trailFadeFragment,
      uniforms: {
        uBackground: { value: COLOR_SLATE_BLACK },
        uFadeAlpha: { value: 0.42 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  });

  const blitGeometry = new Triangle(gl);
  const blitMesh = new Mesh(gl, {
    geometry: blitGeometry,
    program: new Program(gl, {
      vertex: blitVertex,
      fragment: blitFragment,
      uniforms: { tMap: { value: null } },
      depthTest: false,
      depthWrite: false,
    }),
  });

  return {
    scene,
    particles,
    program,
    pointerUniform,
    pointerActiveUniform,
    progressUniform,
    timeUniform,
    trailFadeMesh,
    blitMesh,
  };
}

/**
 * Full-viewport volumetric point-cloud hero canvas. See file header for the
 * per-state behavior and progress model. Pauses its render loop off-screen /
 * hidden-tab via useInViewport, and defers entirely to the static fallback
 * if WebGL is unavailable or the context is lost mid-session.
 */
export function DepthFieldCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { ref: viewportRef, isActive } = useInViewport<HTMLDivElement>();
  const webglAvailable = useWebGLAvailable(canvasRef);
  const perfTier = useDevicePerfTier();

  // Combine the container ref with the in-viewport observer ref.
  const setContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    viewportRef.current = node;
  };

  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let destroyed = false;
    let handles: SceneHandles | null = null;
    let rafId = 0;
    let scrollTriggerInstance: import("gsap/ScrollTrigger").ScrollTrigger | undefined;
    let pointerActiveTimeout: ReturnType<typeof setTimeout> | undefined;

    const particleCount = HERO_PARTICLE_COUNTS[perfTier];

    const renderer = new Renderer({
      canvas,
      dpr: Math.min(window.devicePixelRatio, 1.5),
      alpha: false,
      antialias: false,
    });
    const gl = renderer.gl;
    gl.clearColor(...COLOR_SLATE_BLACK, 1);

    const camera = new Camera(gl, { near: 0.1, far: 30, fov: 45 });
    camera.position.set(0, 0, 7.5);
    camera.lookAt([0, 0, 0]);

    const built = buildScene(gl, particleCount);

    const makeTrailTarget = () =>
      new RenderTarget(gl, {
        width: container.clientWidth,
        height: container.clientHeight,
        depth: false,
      });

    const trailTargetA = makeTrailTarget();
    const trailTargetB = makeTrailTarget();

    handles = {
      renderer,
      camera,
      scene: built.scene,
      particles: built.particles,
      program: built.program,
      pointerUniform: built.pointerUniform,
      pointerActiveUniform: built.pointerActiveUniform,
      progressUniform: built.progressUniform,
      timeUniform: built.timeUniform,
      trailTargetA,
      trailTargetB,
      trailFadeMesh: built.trailFadeMesh,
      blitMesh: built.blitMesh,
    };

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width, height);
      camera.perspective({ aspect: width / height });
      trailTargetA.setSize(width, height);
      trailTargetB.setSize(width, height);
    };
    resize();
    window.addEventListener("resize", resize);

    // Continuous 0..3 scroll progress across the hero's scroll runway,
    // computed locally (own ScrollTrigger instance) rather than reused from
    // useHeroPanelProgress's per-panel --panel-progress vars, since this
    // scene wants one continuous float driving GLSL state blending across
    // the whole runway rather than four independent per-panel progresses.
    (async () => {
      const { ScrollTrigger } = await import("gsap/ScrollTrigger");
      const section = container.closest("section");
      if (!section || destroyed) return;

      scrollTriggerInstance = ScrollTrigger.create({
        trigger: section,
        start: "top top",
        end: "bottom bottom",
        scrub: true,
        onUpdate: (self) => {
          if (handles) handles.progressUniform.value = self.progress * 3;
        },
      });
    })();

    // Pointer tracking in a canvas-local NDC-ish space, mapped to the same
    // world-scale the particles live in (z=0 plane at the scene origin).
    const pointerWorld = new Vec3();
    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      // Approximate world-space position on the z=0 plane given our fixed
      // camera distance/FOV — close enough for a disturb effect, not a
      // precise unproject (keeps this cheap, runs every pointermove).
      const worldHalfHeight = Math.tan((45 * Math.PI) / 180 / 2) * 7.5;
      const worldHalfWidth = worldHalfHeight * (camera.aspect || 1);
      pointerWorld.set(ndcX * worldHalfWidth, ndcY * worldHalfHeight, 0);
      if (!handles) return;
      handles.pointerUniform.set(pointerWorld.x, pointerWorld.y);
      handles.pointerActiveUniform.value = 1;
      if (pointerActiveTimeout) clearTimeout(pointerActiveTimeout);
      pointerActiveTimeout = setTimeout(() => {
        if (handles) handles.pointerActiveUniform.value = 0;
      }, 180);
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    const startTime = performance.now();
    let usingA = true;

    const renderFrame = () => {
      rafId = requestAnimationFrame(renderFrame);
      if (!isActiveRef.current || !handles) return;

      const elapsed = (performance.now() - startTime) / 1000;
      handles.timeUniform.value = elapsed;

      const progress = handles.progressUniform.value;
      // Motion-blur trails are state-2-only ("the peg breaks"), per brief.
      const inBreakState = progress > 0.85 && progress < 2.15;

      if (inBreakState) {
        const readTarget = usingA ? handles.trailTargetA : handles.trailTargetB;
        const writeTarget = usingA ? handles.trailTargetB : handles.trailTargetA;

        // Seed the write target with the previous frame's accumulated trail
        // so it stays uncleared across frames (ping-ponged since OGL can't
        // read and write the same target in one pass).
        (handles.blitMesh.program.uniforms.tMap as { value: unknown }).value =
          readTarget.texture;
        renderer.render({ scene: handles.blitMesh, target: writeTarget, clear: false });

        // Low-alpha quad over the carried-forward contents — the
        // "uncleared target + fading quad" trail technique.
        renderer.render({ scene: handles.trailFadeMesh, target: writeTarget, clear: false });

        // Draw particles additively on top of the fading trail.
        renderer.render({
          scene: handles.scene,
          camera,
          target: writeTarget,
          clear: false,
        });

        // Blit the accumulated trail target to the screen.
        (handles.blitMesh.program.uniforms.tMap as { value: unknown }).value =
          writeTarget.texture;
        renderer.render({ scene: handles.blitMesh, clear: true });

        usingA = !usingA;
      } else {
        renderer.render({ scene: handles.scene, camera, clear: true });
      }
    };
    rafId = requestAnimationFrame(renderFrame);

    return () => {
      destroyed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      if (pointerActiveTimeout) clearTimeout(pointerActiveTimeout);
      scrollTriggerInstance?.kill();
      built.particles.geometry.remove();
      built.program.remove();
    };
  }, [perfTier]);

  if (!webglAvailable) {
    // Caller (page.tsx via HeroCanvasSwitch) renders the static fallback
    // when prefers-reduced-motion is set; this guards the separate case of
    // WebGL being unavailable or lost mid-session while motion is allowed.
    return <div className="h-full w-full bg-slate-black" />;
  }

  return (
    <div ref={setContainerRef} className="h-full w-full">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
