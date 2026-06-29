import { describe, test, expect } from "bun:test";
import { parseUrl, authCheck, DEFAULT_PORT, ENV_KEY, deriveIdentity, normalizeRemote } from "./rech.ts";
import { isUnderDir, splitCommand, shortClientLabel, isIsoSession } from "./serve.ts";

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

describe("normalizeRemote", () => {
  test("ssh remote -> host/owner/repo", () => {
    expect(normalizeRemote("git@github.com:snomiao/rechrome.git")).toBe("github.com/snomiao/rechrome");
  });
  test("https remote drops scheme/.git", () => {
    expect(normalizeRemote("https://github.com/snomiao/rechrome.git")).toBe("github.com/snomiao/rechrome");
  });
  test("strips embedded credentials", () => {
    expect(normalizeRemote("https://user:tok@github.com/snomiao/rechrome.git")).toBe("github.com/snomiao/rechrome");
  });
});

describe("deriveIdentity", () => {
  const base = { host: "mac", remote: "github.com/o/repo" };

  test("worktree mode keys on the worktree root path, not the branch", () => {
    const a = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a", root: "/wt/a", branch: "main" });
    const b = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a/sub", root: "/wt/a", branch: "main" });
    // cd-ing into a subdir keeps the same key (key is the worktree root, not cwd)
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("worktree:/wt/a");
  });

  test("collision fix: two worktrees on the SAME branch get DIFFERENT keys", () => {
    const a = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a", root: "/wt/a", branch: "main" });
    const b = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/b", root: "/wt/b", branch: "main" });
    expect(a.key).not.toBe(b.key);
  });

  test("mutable fix: switching branch in the same worktree keeps the key", () => {
    const before = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a", root: "/wt/a", branch: "main" });
    const after = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a", root: "/wt/a", branch: "feature" });
    expect(before.key).toBe(after.key);
    // ...but the human label still reflects the current branch
    expect(after.label).toBe("github.com/o/repo#a@feature");
  });

  test("detached HEAD does not degrade the key (no branch in key)", () => {
    const detached = deriveIdentity({ ...base, mode: "worktree", cwd: "/wt/a", root: "/wt/a", branch: "a1b2c3d" });
    expect(detached.key).toBe("worktree:/wt/a");
  });

  test("branch mode restores the legacy <remote>/tree/<branch> key", () => {
    const id = deriveIdentity({ ...base, mode: "branch", cwd: "/wt/a", root: "/wt/a", branch: "main" });
    expect(id.key).toBe("https://github.com/o/repo/tree/main");
  });

  test("cwd mode keys on the exact directory", () => {
    const id = deriveIdentity({ ...base, mode: "cwd", cwd: "/wt/a/sub", root: "/wt/a", branch: "main" });
    expect(id.key).toBe("cwd:/wt/a/sub");
  });

  test("non-git falls back to host:cwd for both key and label", () => {
    const id = deriveIdentity({ host: "mac", mode: "worktree", cwd: "/tmp/x", root: null, remote: null, branch: null });
    expect(id.key).toBe("worktree:/tmp/x");
    expect(id.label).toBe("mac:/tmp/x");
  });
});

describe("shortClientLabel", () => {
  test("current label -> basename:branch", () => {
    expect(shortClientLabel("github.com/o/repo#main@feature")).toBe("mai:fea");
  });
  test("current label without branch -> basename", () => {
    expect(shortClientLabel("github.com/o/repo#repo")).toBe("repo");
  });
  test("legacy gitUrl still parses", () => {
    expect(shortClientLabel("https://github.com/o/repo/tree/branch")).toBe("rep:bra");
  });
  test("host:cwd -> basename", () => {
    expect(shortClientLabel("mac:/path/to/dir")).toBe("dir");
  });
});

describe("isIsoSession", () => {
  test("matches a namespaced --isolate session", () => {
    expect(isIsoSession("a1b2c3d4-iso-deadbeefdeadbeef")).toBe(true);
  });
  test("matches a bare iso session", () => {
    expect(isIsoSession("iso-deadbeef")).toBe(true);
  });
  test("does not match a normal session key hash", () => {
    expect(isIsoSession("a1b2c3d4")).toBe(false);
  });
  test("does not match a non-iso named session", () => {
    expect(isIsoSession("a1b2c3d4-myflow")).toBe(false);
  });
});
