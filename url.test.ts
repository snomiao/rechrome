import { expect, test } from "bun:test";
import { parseUrl, registeredProfileUrl, profileConnectionUri } from "./rechrome.ts";
import { serviceUrl } from "./listeners.ts";

test("fragment credentials and profile override legacy parameters", () => {
  const raw = "https://old@example.com/rechrome?profile=old&token=old#?key=new&profile=qa%40example.com&token=secret&extension_id=id&user_data_dir=%2Ftmp%2Fqa&load_extension=%2Ftmp%2Fext";
  expect(parseUrl(raw)).toEqual({ key: "new", host: "example.com", port: 443, protocol: "https", prefix: "/rechrome/", profileDirectory: "qa@example.com", extensionToken: "secret", extensionId: "id", userDataDir: "/tmp/qa", loadExtension: "/tmp/ext" });
  expect(serviceUrl(raw, "ping")).toBe("https://example.com/rechrome/ping");
});

test("legacy URLs and fragments without a question mark remain supported", () => {
  expect(parseUrl("http://legacy@example.com:13775/?profile=qa&token=ext")).toMatchObject({ key: "legacy", profileDirectory: "qa", extensionToken: "ext" });
  expect(parseUrl("https://example.com/#key=new&profile=qa")).toMatchObject({ key: "new", profileDirectory: "qa" });
  expect(parseUrl("https://old@example.com/#?key=").key).toBe("");
});

test("generated profile URLs keep bridge credentials on the daemon", () => {
  const url = registeredProfileUrl("https://daemon@example.com/rechrome/?profile=qa&token=bridge&extension_id=id&user_data_dir=/private&load_extension=/ext");
  expect(url).toBe("https://example.com/rechrome/?profile=qa#key=daemon");
  expect(parseUrl(url)).toMatchObject({ key: "daemon", profileDirectory: "qa", extensionToken: undefined });
  expect(registeredProfileUrl("https://example.com/rechrome/#?key=daemon&profile=qa&token=bridge")).toBe(url);
});

test("profile URI printing preserves proxy endpoints and uses root for direct listeners", () => {
  const local = { name: "local", host: "127.0.0.1", port: 13775, key: "local-key", profiles: "*" as const };
  const remote = { name: "remote", host: "127.0.0.1", port: 13776, key: "remote-key", profiles: ["qa"], prefix: "/rechrome/" };
  expect(profileConnectionUri("qa", "https://example.com/rechrome/?profile=old#key=remote-key", [local, remote]))
    .toBe("https://example.com/rechrome/?profile=qa#key=remote-key");
  expect(profileConnectionUri("qa", undefined, [local])).toBe("http://127.0.0.1:13775/?profile=qa#key=local-key");
  expect(profileConnectionUri("qa", "https://ignored.example/", [local], "local")).toBe("http://127.0.0.1:13775/?profile=qa#key=local-key");
  expect(() => profileConnectionUri("personal", "https://example.com/#key=remote-key", [remote])).toThrow("does not allow");
  expect(() => profileConnectionUri("qa", undefined, [local, remote])).toThrow("Choose a listener");
});
