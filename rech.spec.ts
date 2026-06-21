import { describe, test, expect } from "bun:test";
import { parseUrl, authCheck, DEFAULT_PORT, ENV_KEY } from "./rech.ts";
import { isUnderDir, splitCommand } from "./serve.ts";

describe("parseUrl", () => {
  test("parses key, host, and port from an http URL", () => {
    const result = parseUrl("http://mykey@example.com:9999");
    expect(result).toMatchObject({ key: "mykey", host: "example.com", port: 9999, protocol: "http" });
  });

  test("falls back to scheme default port when port is missing", () => {
    const result = parseUrl("http://mykey@example.com");
    expect(result).toMatchObject({ key: "mykey", host: "example.com", port: 80, protocol: "http" });
  });

  test("uses 443 for https when port is missing", () => {
    const result = parseUrl("https://mykey@example.com");
    expect(result).toMatchObject({ host: "example.com", port: 443, protocol: "https" });
  });

  test("handles URL-safe base64 characters in key", () => {
    const result = parseUrl("http://ab_c-dEf12@host:8080");
    expect(result.key).toBe("ab_c-dEf12");
  });

  test("parses localhost URLs", () => {
    const result = parseUrl("http://k@localhost:13775");
    expect(result).toMatchObject({ key: "k", host: "localhost", port: 13775, protocol: "http" });
  });

  test("extracts extension_id, token, profile, user_data_dir from query params", () => {
    const result = parseUrl(
      "http://k@host:13775?extension_id=EID&token=TOK&profile=Profile%201&user_data_dir=/tmp/ud",
    );
    expect(result).toMatchObject({
      extensionId: "EID",
      extensionToken: "TOK",
      profileDirectory: "Profile 1",
      userDataDir: "/tmp/ud",
    });
  });
});

describe("authCheck", () => {
  test("returns null for valid bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(authCheck(req, "secret123")).toBeNull();
  });

  test("returns 401 for wrong bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 401 when no authorization header", () => {
    const req = new Request("http://localhost/run");
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 401 for empty bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer " },
    });
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});

describe("constants", () => {
  test("ENV_KEY is RECHROME_URL", () => {
    expect(ENV_KEY).toBe("RECHROME_URL");
  });

  test("DEFAULT_PORT is 13775", () => {
    expect(DEFAULT_PORT).toBe(13775);
  });
});

describe("isUnderDir", () => {
  test("relative file under base is contained", () => {
    expect(isUnderDir("/work", "out/a.png")).toBe(true);
  });
  test("parent-escape is not contained", () => {
    expect(isUnderDir("/work", "../etc/passwd")).toBe(false);
  });
  test("base itself is not 'under'", () => {
    expect(isUnderDir("/work", ".")).toBe(false);
  });
  test("a different absolute path is not contained", () => {
    // On POSIX an absolute candidate resolves outside; on Windows a different drive does too.
    const other = process.platform === "win32" ? "D:/x.png" : "/other/x.png";
    expect(isUnderDir("/work", other)).toBe(false);
  });
});

describe("splitCommand", () => {
  test("splits a plain command on spaces", () => {
    expect(splitCommand("node /repo/cli.js")).toEqual(["node", "/repo/cli.js"]);
  });
  test("keeps a double-quoted path with spaces intact", () => {
    expect(splitCommand('"C:\\Program Files\\nodejs\\node.exe" C:/repo/cli.js'))
      .toEqual(["C:\\Program Files\\nodejs\\node.exe", "C:/repo/cli.js"]);
  });
  test("empty string yields no tokens", () => {
    expect(splitCommand("")).toEqual([]);
  });
});
