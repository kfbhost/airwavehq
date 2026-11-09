import { describe, expect, it } from "vitest";
import { PROCESSING_PRESETS, broadcastFilterArgsFor } from "../src/processing.js";
import type { ProcessingPreset } from "@radiohost/shared";

describe("broadcast processing", () => {
  const presets: ProcessingPreset[] = ["gentle", "radio", "punch"];

  for (const preset of presets) {
    it(`${preset}: returns a -filter_complex multiband graph with limiter`, () => {
      const args = broadcastFilterArgsFor(preset, true);
      expect(args[0]).toBe("-filter_complex");
      const graph = args[1]!;
      expect(graph).toContain("asplit=3");
      expect(graph).toContain("acompressor");
      expect(graph).toContain("amix=inputs=3:normalize=0");
      expect(graph.split(",").pop()).toMatch(/^alimiter=limit=/);
    });
  }

  it("off returns no filter args", () => {
    expect(broadcastFilterArgsFor("off", true)).toEqual([]);
  });

  it("returns no args when processing is disabled", () => {
    expect(broadcastFilterArgsFor("radio", false)).toEqual([]);
  });

  it("presets are distinct (punch is hotter than gentle)", () => {
    expect(PROCESSING_PRESETS.gentle).not.toBe(PROCESSING_PRESETS.radio);
    expect(PROCESSING_PRESETS.radio).not.toBe(PROCESSING_PRESETS.punch);
  });
});
