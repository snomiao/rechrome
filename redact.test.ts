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
  const hits = [{ id: "t", re: /token=(\w+)/g, keywords: [], allow: [], stop: [] }];
  expect(redact("token=token", hits).text).toBe("token=[redacted:t]");
});
