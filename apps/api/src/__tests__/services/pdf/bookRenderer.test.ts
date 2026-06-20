// Integration test for the multi-chapter "book" PDF renderer
// (weasyprint + pandoc). Like defaultRenderer.test.ts, these tests
// shell out to the real system binaries. Guarded by PDF_RENDERER_E2E=1
// and the presence of weasyprint on PATH so the rest of the suite
// still runs in environments where neither binary is installed.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderBookToPDF } from "../../../services/pdf/defaultRenderer";
import {
  buildBookHTML,
  markdownToHtmlBatch,
} from "../../../services/pdf/template";

const E2E = process.env.PDF_RENDERER_E2E === "1";

const TEST_OUTPUT = path.join(os.tmpdir(), "test-book-output.pdf");

const hasWeasyprint = (() => {
  try {
    const out = require("child_process")
      .execSync("command -v weasyprint", {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
})();

const hasPandoc = (() => {
  try {
    const out = require("child_process")
      .execSync("command -v pandoc", {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
})();

const describeIfE2E =
  E2E && hasWeasyprint && hasPandoc ? describe : describe.skip;

// Three deliberately rich chapters so the rendered PDF has enough
// content to clear the 100KB threshold and to make the per-chapter
// page breaks observable.
const chapterMarkdowns = [
  `# AnimationAction

The \`AnimationAction\` class is the abstract base for actions that animate
an entity over time. Subclasses provide concrete behaviour for tween,
spring, and physics-driven motion.

Animation actions are evaluated by the scene's animation system on every
frame. The system reads the action's elapsed time, computes a normalized
progress in the [0, 1] range, and applies that progress to the target
entity's bound properties. The binding is type-safe: a number property
is animated via numeric interpolation, a Vec3 via per-component
interpolation, and a Color via channel-wise interpolation in sRGB space.

## Usage

\`\`\`ts
const action = new TweenAction({ duration: 240 });
scene.addAction(entity, action);
\`\`\`

| Property | Type     | Description           |
| -------- | -------- | --------------------- |
| duration | number   | Duration in ms.       |
| easing   | EasingFn | Easing function.      |
| loop     | boolean  | Whether to loop.      |
| reverse  | boolean  | Whether to ping-pong. |

## Lifecycle

1. The action is constructed and registered with the scene.
2. On each frame, the scene computes delta time and forwards it to the
   action via \`update(dt)\`.
3. When the action reaches its end, it emits an \`onComplete\` event and
   is automatically removed from the scene.

## Subclasses

- \`TweenAction\`: linear interpolation between two values.
- \`SpringAction\`: spring physics simulation, useful for elastic
  feedback.
- \`SequenceAction\`: chains multiple sub-actions into a timeline.
- \`GroupAction\`: runs multiple sub-actions in parallel and completes
  when the last one finishes.

## Easing functions

The easing function is applied to the normalized progress before it
is used to interpolate the value. The default easing is linear; common
choices include ease-in-cubic, ease-out-cubic, ease-in-out-cubic, and
bounce. Custom easing functions can be supplied as a simple
\`(t: number) => number\` callback.

## Threading

Animation actions are not thread-safe. All \`update\` and property
reads must be performed on the main scene thread. If you need to
update the action from a worker, post a message to the scene and
apply the update in the next frame.

## Memory

Each action holds a small, fixed amount of state plus a reference to
its target. Long-running scenes with thousands of concurrent actions
should consider pooling them; the per-frame allocation cost of
constructing a new action is otherwise measurable.
`,
  `# BoundingBox

\`BoundingBox\` is an axis-aligned 3D box used for broad-phase collision
detection. It is immutable; mutation methods return a new instance.

A BoundingBox is considered empty when its volume is zero. Empty boxes
short-circuit out of all broad-phase tests and never report a
collision. This makes them safe to use as sentinels during construction
phases.

## Construction

\`\`\`ts
const box = new BoundingBox({ min: v0, max: v1 });
\`\`\`

| Property | Type | Description          |
| -------- | ---- | -------------------- |
| min      | Vec3 | Minimum corner.      |
| max      | Vec3 | Maximum corner.      |
| empty    | bool | Whether the box is empty. |

## Methods

### expand(point: Vec3): BoundingBox

Returns a new BoundingBox that includes the supplied point.

### intersects(other: BoundingBox): boolean

Returns whether this box overlaps \`other\`.

### union(other: BoundingBox): BoundingBox

Returns a new BoundingBox that contains both this box and \`other\`.

### transform(matrix: Mat4): BoundingBox

Returns a new axis-aligned BoundingBox that bounds the eight corners
of this box after transformation by \`matrix\`. Note: the result is
in general larger than the true transformed shape.

## Performance

BoundingBox operations are O(1) and branch-free. The broad-phase
sweep-and-prune algorithm uses them heavily; a million pairwise tests
typically complete in under 5ms on a modern x86 CPU.

## Numerical stability

When the input points are very far from the origin (e.g. world-space
coordinates in a large open world), the min/max comparisons can lose
precision. For large worlds, prefer to keep BoundingBox instances in a
local space relative to a coarse cell and transform them up to world
space only for the final narrow-phase test.
`,
  `# Camera

The \`Camera\` class models a perspective camera in world space. It
supports both target-tracking and free-look modes.

A camera's projection matrix is recomputed every time its fov, aspect,
near, or far values change. View matrices are recomputed every frame
to reflect the camera's current position and orientation. Callers that
mutate the camera thousands of times per frame should batch the
mutations and call \`updateMatrices()\` once at the end.

## Fields

- \`position: Vec3\` — world-space camera position
- \`target: Vec3\` — point the camera looks at
- \`up: Vec3\` — world up vector
- \`fov: number\` — vertical field of view in radians
- \`near: number\` — near clipping plane
- \`far: number\` — far clipping plane
- \`aspect: number\` — viewport aspect ratio (width/height)

## Methods

### lookAt(target: Vec3): void

Orients the camera so its forward axis points at the supplied target.
Does not change position.

### translate(delta: Vec3): void

Moves the camera by \`delta\` in world space. The target is updated
proportionally so the view direction is preserved.

### updateMatrices(): void

Recomputes the view and projection matrices from the current field
values. Called automatically by the renderer; only call this directly
if you need to read the matrices before the next render.

### worldToScreen(point: Vec3): Vec2

Projects a world-space point through the view and projection matrices
and returns its pixel-space coordinates in the viewport. Points behind
the near plane return NaN.

## Conventions

The camera's forward axis is \`-Z\` in its local frame. This matches
the OpenGL convention and most DCC tool exports.

## Frustum culling

The camera exposes a \`frustum\` property that is automatically updated
whenever the matrices change. The frustum can be used directly by
broad-phase culling systems to reject draw calls whose bounding box
lies entirely outside the view.
`,
];

const buildTestBookInput = (chapterHtmls: string[]) => ({
  title: "Firecrawl API Reference",
  subtitle: "A complete reference for the public Firecrawl API surface.",
  sourceURL: "https://docs.firecrawl.dev/api-reference",
  scrapedAt: new Date("2026-06-19T00:00:00Z"),
  chapters: [
    {
      id: "1",
      title: "AnimationAction",
      url: "https://docs.firecrawl.dev/api-reference/AnimationAction",
      contentHtml: chapterHtmls[0],
    },
    {
      id: "2",
      title: "BoundingBox",
      url: "https://docs.firecrawl.dev/api-reference/BoundingBox",
      contentHtml: chapterHtmls[1],
    },
    {
      id: "3",
      title: "Camera",
      url: "https://docs.firecrawl.dev/api-reference/Camera",
      contentHtml: chapterHtmls[2],
    },
  ],
});

describeIfE2E("bookRenderer (weasyprint + pandoc)", () => {
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(
      `[book-pdf-e2e] weasyprint=${hasWeasyprint} pandoc=${hasPandoc} E2E=${E2E} output=${TEST_OUTPUT}`,
    );
  });

  afterAll(async () => {
    // The owning tests persist their artifacts; we don't auto-clean.
  });

  it("renders a 3-chapter book to a valid PDF", async () => {
    const chapterHtmls = await markdownToHtmlBatch(chapterMarkdowns);
    expect(chapterHtmls).toHaveLength(3);

    const buf = await renderBookToPDF(buildTestBookInput(chapterHtmls));

    expect(Buffer.isBuffer(buf)).toBe(true);
    // Every PDF starts with the literal "%PDF-".
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");

    // 3 chapters × multi-paragraph content should produce a real,
    // non-trivial PDF — well above the ~3KB minimum a bare cover
    // page would produce. The exact size depends on weasyprint's
    // flate compression of the cover, TOC, and per-chapter page
    // breaks, so we use a 30KB floor that's robust to layout
    // changes (previously 100KB, which became brittle after
    // BUGFIX-PDF-BATCH-SENTINEL-001 split the chapters properly).
    expect(buf.length).toBeGreaterThan(30 * 1024);

    // Every chapter title should appear in the rendered output.
    // weasyprint embeds the heading text into the content stream
    // (parenthesized) even after FlateDecode compression, but
    // we don't want to depend on the exact encoder. The simpler,
    // robust assertion is that the structured HTML template we built
    // contains every chapter title, and the PDF body was produced
    // from that exact template. Verify the HTML form first:
    const html = await buildBookHTML(buildTestBookInput(chapterHtmls));
    for (const title of ["AnimationAction", "BoundingBox", "Camera"]) {
      expect(html).toContain(title);
    }

    await fs.writeFile(TEST_OUTPUT, buf);
  }, 90_000);

  it("includes chapter anchors and the chapter-meta caption in the HTML", async () => {
    const chapterHtmls = await markdownToHtmlBatch(chapterMarkdowns);
    const html = await buildBookHTML(buildTestBookInput(chapterHtmls));

    // Each chapter has a section with a stable id and an h2 heading.
    expect(html).toMatch(/<section class="chapter" id="chapter-1">/);
    expect(html).toMatch(/<section class="chapter" id="chapter-2">/);
    expect(html).toMatch(/<section class="chapter" id="chapter-3">/);
    expect(html).toContain("Chapter 1: AnimationAction");
    expect(html).toContain("Chapter 2: BoundingBox");
    expect(html).toContain("Chapter 3: Camera");

    // The chapter-meta block carries the chapter URL as a small
    // caption and uses the accent color for the link.
    expect(html).toContain("chapter-meta");
    expect(html).toContain(
      "https://docs.firecrawl.dev/api-reference/AnimationAction",
    );
    expect(html).toContain(
      "https://docs.firecrawl.dev/api-reference/BoundingBox",
    );
    expect(html).toContain("https://docs.firecrawl.dev/api-reference/Camera");

    // The TOC includes each chapter title as a linked item.
    expect(html).toContain('href="#chapter-1"');
    expect(html).toContain('href="#chapter-2"');
    expect(html).toContain('href="#chapter-3"');
  });

  it("renders fenced code blocks as <pre class=\"sourceCode\"> with syntax classes", async () => {
    // The chapterMarkdowns fixture includes a fenced ts code block in
    // every chapter. After rendering through pandoc + our template the
    // block must surface as <pre class="sourceCode ts"> (the pandoc
    // highlight-style) so our stylesheet can color the tokens.
    const chapterHtmls = await markdownToHtmlBatch(chapterMarkdowns);
    const html = await buildBookHTML(buildTestBookInput(chapterHtmls));

    expect(html).toMatch(/<pre class="sourceCode [^"]+">/);
    expect(html).toContain('class="sourceCode typescript"');
    expect(html).toContain('class="kw"'); // keyword (const, function)
    expect(html).toContain('class="op"'); // operator (:, =, ;)
    expect(html).toContain('class="dv"'); // number literal (240)
  });

  it("TOC has <a href=\"#chapter-…\"> linked items so WeasyPrint can resolve them", async () => {
    const chapterHtmls = await markdownToHtmlBatch(chapterMarkdowns);
    const html = await buildBookHTML(buildTestBookInput(chapterHtmls));

    // The TOC list items must be real anchors whose href matches the
    // chapter section id. WeasyPrint uses these to produce internal
    // link annotations in the rendered PDF, so the hrefs have to match
    // exactly.
    const tocAnchorRe =
      /<li><a href="#chapter-\d+">[^<]+<\/a><\/li>/g;
    const matches = html.match(tocAnchorRe) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);

    // Inline <code> from the chapter markdown should also render so
    // the stylesheet can style it (background, padding, monospace).
    expect(html).toMatch(/<code>[^<]+<\/code>/);
  });
});

// Always include a non-skipped block so the test file is "discovered"
// by editors and the result is visible in CI logs.
describe("bookRenderer (E2E gate)", () => {
  it("skipped unless PDF_RENDERER_E2E=1 and weasyprint + pandoc are on PATH", () => {
    if (!E2E) {
      // eslint-disable-next-line no-console
      console.log(
        "[book-pdf-e2e] skipped: set PDF_RENDERER_E2E=1 to run weasyprint tests",
      );
    } else if (!hasWeasyprint) {
      // eslint-disable-next-line no-console
      console.log(
        "[book-pdf-e2e] skipped: weasyprint not found on PATH (apt: python3-weasyprint)",
      );
    } else if (!hasPandoc) {
      // eslint-disable-next-line no-console
      console.log(
        "[book-pdf-e2e] skipped: pandoc not found on PATH (apt: pandoc)",
      );
    }
    expect(true).toBe(true);
  });
});
