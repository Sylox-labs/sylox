import { describe, expect, it, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDevicePerfTier } from "./useDevicePerfTier";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

function setHardwareConcurrency(cores: number | undefined) {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    writable: true,
    configurable: true,
    value: cores,
  });
}

describe("useDevicePerfTier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies a narrow viewport as mobile", () => {
    setViewport(400);
    setHardwareConcurrency(8);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("mobile");
  });

  it("classifies a mid viewport as tablet", () => {
    setViewport(900);
    setHardwareConcurrency(8);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("tablet");
  });

  it("classifies a wide viewport as desktop", () => {
    setViewport(1440);
    setHardwareConcurrency(8);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("desktop");
  });

  it("downgrades desktop to tablet on a low-core-count device", () => {
    setViewport(1440);
    setHardwareConcurrency(2);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("tablet");
  });

  it("downgrades tablet to mobile on a low-core-count device", () => {
    setViewport(900);
    setHardwareConcurrency(2);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("mobile");
  });

  it("falls back to a reasonable default when hardwareConcurrency is unavailable", () => {
    setViewport(1440);
    setHardwareConcurrency(undefined);
    const { result } = renderHook(() => useDevicePerfTier());
    expect(result.current).toBe("desktop");
  });
});
