import type { ScrollTrigger as ScrollTriggerType } from "gsap/ScrollTrigger";

/**
 * Writes a ScrollTrigger instance's progress (0-1) to a CSS custom property
 * on the given element every frame it updates. Lets CSS do the actual
 * staggered parallax/fade math (opacity, translate) off a single JS-owned
 * progress value, instead of animating properties directly from JS.
 *
 * Call from inside a ScrollTrigger config's `onUpdate`, e.g.:
 *   ScrollTrigger.create({
 *     trigger: panelRef.current,
 *     onUpdate: (self) => writeProgressVar(panelRef.current, self, "--panel-progress"),
 *   });
 */
export function writeProgressVar(
  element: HTMLElement | null,
  trigger: ScrollTriggerType,
  propertyName: string,
): void {
  element?.style.setProperty(propertyName, trigger.progress.toString());
}
