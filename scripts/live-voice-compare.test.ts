import { expect, test } from "bun:test";
import { buildProbeCode, unwrap, isolatedSession } from "./live-voice-compare.ts";
import { analyzePcm } from "./live-voice-analyze.ts";

test("bounded result parsing accepts direct and legacy results without interpreting diagnostics", () => {
  expect(unwrap(JSON.stringify({ result: JSON.stringify({ muted: true }) }))).toEqual({
    muted: true,
  });
  expect(unwrap('### Result\n{"muted":true}\n### Events\nignored')).toEqual({ muted: true });
  expect(() => unwrap("### Result\n{}\n### Result\n{}")).toThrow();
  expect(() => unwrap("x".repeat(512 * 1024 + 1))).toThrow();
});
test("probe refuses a missing WAV duration before generating any browser operation", () => {
  const id = "b-" + "a".repeat(32);
  const marker = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  for (const seconds of [undefined, NaN, Infinity, 0, -1, 30.01])
    expect(() => buildProbeCode(1, marker, id, "AAAA", seconds as number)).toThrow();
  expect(() => buildProbeCode(1, marker, id, "AAAA", 4.5)).not.toThrow();
  expect(() => buildProbeCode(-1, marker, id, "AAAA", 4)).toThrow();
  expect(() => buildProbeCode(1, marker, id, "AAAA", 4, { data: "AAAA", seconds: 27 })).toThrow();
  expect(() => buildProbeCode(1, "", id, "AAAA", 4)).toThrow();
});
test("default, shared, and malformed browser session identifiers are refused before socket use", () => {
  for (const session of [
    "",
    "existing-session",
    "../x-iso_owned",
    "x-iso_owned;other",
    "x".repeat(130) + "-iso_owned",
  ])
    expect(() => isolatedSession(session, "other-iso_owned")).toThrow();
  expect(() => isolatedSession("x-iso_owned", "x-iso_owned")).toThrow();
  expect(isolatedSession("x-iso_owned", "x-iso_other")).toBe("x-iso_owned");
});
test("silent and short UI sounds do not become validated spoken-language evidence", () => {
  const silence = analyzePcm(new Float32Array(16000));
  expect(silence.firstActiveSeconds).toBeNull();
  expect(silence.peak).toBe(0);
  const sound = new Float32Array(16000);
  sound.fill(0.5, 3200, 6400);
  const signal = analyzePcm(sound);
  expect(signal.firstActiveSeconds).toBe(0.2);
  expect(signal.activeSeconds).toBeCloseTo(0.2);
  expect(() => analyzePcm(new Float32Array([NaN]))).toThrow();
  expect(() => analyzePcm(new Float32Array(16000 * 65 + 1))).toThrow();
});
