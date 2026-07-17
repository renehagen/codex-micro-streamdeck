import { describe, expect, it } from "vitest";
import { renderSessionKey, STATUS_COLORS, svgDataUri } from "../src/key-image.js";

describe("session key images", () => {
  it("uses the official Codex status colors", () => {
    expect(STATUS_COLORS).toEqual({
      idle: "#343434",
      unread: "#9BF396",
      thinking: "#9CD5FE",
      "needs-input": "#FFD0B8",
      error: "#FF7373"
    });
  });

  it("escapes session titles and marks the selected slot", () => {
    const svg = renderSessionKey({ slot: 2, title: "A&B <test>", status: "thinking", selected: true });
    expect(svg).toContain("A&amp;B &lt;test&gt;");
    expect(svg).toContain("#715CFF");
    expect(svg).toContain(">3</text>");
  });

  it("returns a Stream Deck-compatible SVG data URI", () => {
    expect(svgDataUri("<svg/>")).toMatch(/^data:image\/svg\+xml;base64,/u);
  });
});
