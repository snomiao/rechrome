import { expect, test } from "bun:test";
import { redact } from "./redact.ts";
test("masks a secret-shaped token in page text", () => {
  const key = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const r = redact(`token: ${key} ok`);
  expect(r.text).not.toContain(key);
  expect(r.kinds.length).toBeGreaterThan(0);
});
test("leaves ordinary page text alone", () => {
  const t = "Welcome back — 3 new messages at https://example.com/inbox";
  expect(redact(t).text).toBe(t);
});
test("masks the captured value, not an earlier copy of it", () => {
  const hits = [{ id: "t", re: /token=(\w+)/gd, group: 1, keywords: [], allow: [], stop: [] }];
  expect(redact("token=token", { rules: hits }).text).toBe("token=[redacted:t]");
});
test("without a secretGroup the whole match is masked", () => {
  const rules = [{ id: "t", re: /(hooks)\/[A-Za-z0-9]{20}/g, keywords: [], allow: [], stop: [] }];
  expect(redact("x hooks/abcdefghij0123456789 y", { rules }).text).toBe("x [redacted:t] y");
});
test("match-targeted allowlists see the whole match", () => {
  const rules = [{ id: "t", re: /\w+=(\w+)/gd, group: 1, keywords: [], allow: [], allowMatch: [/^api_version=/], stop: [] }];
  expect(redact("api_version=2026", { rules }).text).toBe("api_version=2026");
});
test("a mid-pattern (?i) keeps alternatives apart", () => {
  const key = "Zq8vR2mXw7LpT4nKc9YbH3sJd6GfA1eU";
  expect(redact(`curl -H 'Authorization: Bearer ${key}' https://example.com`).text).not.toContain(key);
});

test("long base64 runs (image data) are skipped, fast; secrets beside them are still caught", () => {
  const blob = Buffer.from(crypto.getRandomValues(new Uint8Array(3_750_000))).toString("base64"); // 5 MB
  const text = `"data:image/png;base64,${blob}" token ghp_1234567890abcdefghijABCDEFGHIJ123456\n`;
  const t0 = performance.now();
  const r = redact(text);
  expect(performance.now() - t0).toBeLessThan(500);
  expect(r.kinds).toEqual(["github-pat"]);
  expect(r.text).toContain(blob);
});
