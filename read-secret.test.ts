import { expect, test } from "bun:test";
import { parseReadSecretArgs, readSecretWireArgs, parseReadSecretWire, buildReadCode } from "./fill-secret.ts";
import { authorizeProfileRequest } from "./listeners.ts";

test("read-secret requires --allow-domain and one target", () => {
  expect(() => parseReadSecretArgs(["read-secret", "e12"])).toThrow(/--allow-domain/);
  expect(() => parseReadSecretArgs(["read-secret", "--allow-domain", "app.slack.com"])).toThrow(/target/);
  expect(() => parseReadSecretArgs(["read-secret", "e1", "e2", "--allow-domain=x.com"])).toThrow(/one target/);
  expect(() => parseReadSecretArgs(["read-secret", "e1", "--allow-domain="])).toThrow(/empty/);
  expect(() => parseReadSecretArgs(["read-secret", "e1", "--allow-domain=x.com", "--to-file=/etc/x"])).toThrow(/unknown option/);
  const req = parseReadSecretArgs(["read-secret", "e12", "--allow-domain", "app.slack.com,*.slack.com"]);
  expect(readSecretWireArgs(req)).toEqual(["read-secret", "e12", "--allow-domain=app.slack.com", "--allow-domain=*.slack.com"]);
  expect(parseReadSecretWire(readSecretWireArgs(req))).toEqual(req);
  expect(() => parseReadSecretWire(["read-secret", "e12"])).toThrow();
  expect(() => parseReadSecretWire(["read-secret", "e12", "--filename=x"])).toThrow();
});

test("the read code checks the host before reading, and never embeds a value", () => {
  const code = buildReadCode("e12", ["app.slack.com"]);
  expect(code.indexOf("read-secret refused")).toBeLessThan(code.indexOf("t.value"));
  expect(code).toContain('aria-ref=e12');
  expect(code).toContain("app\\\\.slack\\\\.com");
});

const listener = { name: "dede", host: "127.0.0.1", port: 1, key: "k", profiles: ["qa"] };
const body = (args: string[]) => ({ args, identity: { key: "k", profile: "qa" } });

test("read-secret is off on a scoped listener until the host turns it on", () => {
  expect(() => authorizeProfileRequest(listener as any, body(["read-secret", "e1", "--allow-domain=x.com"]))).toThrow(/read-secret is off/);
  const on = { ...listener, readSecrets: true };
  expect(authorizeProfileRequest(on as any, body(["read-secret", "e1", "--allow-domain=x.com"]))).toBe("qa");
  expect(() => authorizeProfileRequest(on as any, body(["read-secret", "e1", "--filename=/tmp/x"]))).toThrow();
});
