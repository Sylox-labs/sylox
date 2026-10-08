"use client";

import { useEffect, useState } from "react";

/**
 * True once WebGL has been confirmed available, false if it can't be
 * created or is lost mid-session. Canvases that use this should render
 * (and keep showing) their static poster frame whenever this is false —
 * never a blank or frozen canvas (brief §9.1).
 *
 * IMPORTANT: this never calls canvas.getContext() on the real canvas.
 * A <canvas> element can only ever have ONE rendering context for its
 * whole lifetime — if this hook claimed it first (even just to probe
 * support), the renderer's own getContext() call later would silently
 * return that same, differently-configured context instead of the one
 * it actually asked for, corrupting rendering. Support is probed on a
 * disposable canvas instead; context-loss is still tracked on the real
 * canvas via events, which fire for any context regardless of who
 * created it.
 */
function isWebGLSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const context = probe.getContext("webgl2") ?? probe.getContext("webgl");
    return context !== null;
  } catch {
    return false;
  }
}

export function useWebGLAvailable(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): boolean {
  const [isAvailable, setIsAvailable] = useState(isWebGLSupported);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setIsAvailable(false);
    };
    const handleContextRestored = () => {
      setIsAvailable(true);
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener(
        "webglcontextrestored",
        handleContextRestored,
      );
    };
  }, [canvasRef]);

  return isAvailable;
}
