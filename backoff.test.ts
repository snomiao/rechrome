import { expect, test } from "bun:test";
import { reconnectDelay } from "./webrtc.ts";

test("reconnect delay stays within ±25% of the back-off", () => {
  expect(reconnectDelay(1000, () => 0)).toBe(750);
  expect(reconnectDelay(1000, () => 1)).toBe(1250);
  expect(reconnectDelay(8000, () => 0.5)).toBe(8000);
});
