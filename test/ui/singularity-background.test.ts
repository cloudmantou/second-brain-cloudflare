import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");

describe("Singularity background restyle", () => {
  it("keeps the existing navigation and screen structure intact", () => {
    const orderedIds = [
      "sb-tab-observatory",
      "sb-tab-recall",
      "sb-tab-recent",
      "sb-tab-remember",
      "screen-observatory",
      "screen-recall",
      "screen-recent",
      "screen-remember",
    ];

    let previousIndex = -1;
    for (const id of orderedIds) {
      const currentIndex = html.indexOf(`id="${id}"`);
      expect(currentIndex, `${id} should remain in the existing app shell`).toBeGreaterThan(
        previousIndex
      );
      previousIndex = currentIndex;
    }
  });

  it("loads the background-only Singularity visual layer", () => {
    expect(html).toContain('href="/singularity-background.css"');

    const css = readFileSync(
      path.join(process.cwd(), "public/singularity-background.css"),
      "utf8"
    );

    expect(css).toContain("#auth-overlay::before");
    expect(css).toContain("#app::before");
    expect(css).toContain("pointer-events: none");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("--singularity-photon");
  });

  it("does not introduce a replacement Universe shell or canvas runtime", () => {
    expect(html).not.toContain('id="screen-universe"');
    expect(html).not.toContain("new PIXI.Application");
    expect(html).not.toContain("new Sigma");
  });
});
