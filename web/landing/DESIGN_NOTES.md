# Sylox landing page: design notes

## stellar.org — what we took

- **Per-section theming.** Each section declares its own light/dark identity via a `data-theme` attribute, and every component reads semantic CSS variables (`--surface`, `--text-primary`, `--accent`, and so on) rather than branching on theme in JS. The semantic layer sits on top of six fixed brand primitives. This gives us alternating dark/light sections with zero per-component theme logic.
- **Sticky canvas with scrolling panels.** A full-height canvas pins in place via `position: sticky`, while copy panels scroll over it using a negative top margin pulling the scrollable content up to overlap the pinned layer, followed by a tall scroll "runway" that gives the panels room to move. Scroll progress is written to a CSS custom property per panel, and the actual parallax/opacity math lives in plain CSS reading that variable — JS only ever writes one number per frame.
- **Header hide-on-scroll-down, show-on-scroll-up**, driven by a single CSS variable the header's transform reads.
- **Hairline card borders that strengthen on hover**, with the whole card as a single click target.
- **Count-up numbers that reserve their final layout width** so the surrounding text never reflows while digits are still animating, plus a visually-hidden label carrying the real value for screen readers.
- **Performance discipline as a first-class concern**: pause the render loop when off-screen (IntersectionObserver) or when the tab is hidden, cap device pixel ratio, scale particle/point counts down on mobile, and provide a real static fallback under reduced motion — not just a frozen canvas.
- **Motion-blur trails via an uncleared render target.** Instead of clearing a WebGL render target every frame, drawing a low-opacity dark quad over the previous frame before drawing new particles leaves a fading streak behind fast-moving points. We use this only for the "peg breaks" state, not continuously.
- **A general technique for turning an SVG mark into particle positions**: rasterize the shape to an offscreen canvas, read back pixel alpha, and treat opaque pixels as candidate particle targets. We implemented our own version of this independently rather than adapting any specific sampling function.

## stellar.org — what we deliberately left out

- Any gold or yellow hue, anywhere — Sylox's palette has no warm accent; crimson is the only accent, and it's reserved for risk states, not decoration.
- The ribbon-to-globe-to-explosion choreography, the camera fly-through, and all specific shader constants tied to that sequence. Our hero tells its own four-state story with its own motion, not a variation on theirs.
- Coins, coin stacks, and their shape library. Sylox's object system was designed from scratch (gauge, seal, vault — see the "How it works" section) with no reference to coin iconography.
- The serif-italic emphasis / display pairing. Sylox uses a single condensed grotesque display face (see Typography below).
- Any Stellar wordmark or implied affiliation with the Stellar Development Foundation. We say "Built on Stellar" in plain text only.
- The literal particle counts and shader constants documented in the teardown. We derived our own particle-count budget from a frame-time target appropriate to Sylox's simpler four-state story, rather than reusing numbers tuned for a much busier continuous scene.

## pfbridge.xyz — what we took

- **Giant editorial type with tight line height and real negative space** as the primary visual device in text-driven sections, rather than leaning on illustration.
- **A statement that lights up character-by-character as the page scrolls past it**, using a short, tightly-scrubbed reveal rather than a slow fade — the kind of thing that reads as "arriving" rather than "animating."
- **Content sliding up over a still, fixed layer beneath it** as a section transition — achieved with plain CSS stacking (a fixed background layer, an opaque higher z-index sibling that scrolls normally over it), no scroll-hijacking library required.
- **A sticky element on one side of the viewport while simple rows scroll past on the other**, using nothing but native `position: sticky` — no scroll-progress JS needed for this particular pattern.
- **Few sections, each doing one clear job**, and a visible hairline grid underlying card and row layouts.

## pfbridge.xyz — what we deliberately left out

- The acid lime / electric blue / pastel sticker palette, and the sticker/word-stack treatment generally.
- The three-color CTA strip and the parenthetical "(What is X?)" label style.
- Wireframe 3D renders and skewed/scaled hero imagery.
- Fake percentage preloaders and color-wipe transitions.
- Their licensed display/serif fonts, which we have no rights to and wouldn't use regardless of licensing — our type system is built from Inter, Space Mono, and a free display stand-in (see below).
- Every documented mistake from their live site: no preloader blocking first paint, no autoplay-with-sound, exactly one real `<h1>`, WOFF2-only fonts with only the weights actually used, no redundant icon libraries, no dead links or unused dependencies, and real metadata (title, description, Open Graph, `og:image`) from the start rather than left at framework defaults.

## The Sylox visual language

Sylox is risk infrastructure, not a consumer product, so the visual language leans instrumental rather than decorative: a near-black surface (Slate Black), warm off-white text (Silo Oatmeal), muted greys for structure (Anchor Graphite, Cement Grey, Cyber Tin), and exactly one accent — Risk Crimson — spent deliberately rather than everywhere. The five-band risk scale (Normal → Watch → Warning → Distress → Event) is treated as a single intensity ramp from calm neutral to full crimson, never as unrelated traffic-light colors, and every place that shows a band pairs its color with its name so meaning never depends on color alone.

Type splits cleanly by role: Inter carries body and UI copy, Space Mono carries anything numeric, labeled, or meant to read as data (scores, eyebrows, status tags), and a single condensed display face carries poster-scale headlines. Hairline borders, visible grid lines, and whole-card click targets borrow the editorial discipline of pfbridge.xyz's layout without borrowing its palette or type. Motion borrows Stellar's performance discipline and its sticky-canvas/CSS-variable scroll-progress pattern, but tells an entirely different story with it: Sylox's hero doesn't explode into a logo, it walks through four states of a risk score — calm, measured, broken, and resolved — because that sequence is literally what the product does, not a spectacle borrowed from a bridge or a coin.

## Display font

The chosen display stand-in is **Big Shoulders** (Google Fonts): a genuinely condensed, variable-weight (100-900) industrial grotesque, closest among the free alternatives to the licensed board reference Founders Grotesk X-Condensed. It's loaded through a single `--font-display-family` token (see `web/shared/ui/src/tokens/fonts.ts` and `tokens.css`) so a licensed face can replace it later with a one-line change.
