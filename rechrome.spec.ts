import { describe, test, expect } from "bun:test";
import { parseUrl, authCheck, DEFAULT_PORT, ENV_KEY, deriveIdentity, normalizeRemote, normalizeCommandArgs, resolveChromeProfileSelector, resolveGlobalProfile, extractGlobalProfileArg } from "./rechrome.ts";
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

describe("normalizeCommandArgs", () => {
  test("maps human-friendly tab aliases", () => {
    expect(normalizeCommandArgs(["tabs"])).toEqual(["tab-list"]);
    expect(normalizeCommandArgs(["list"])).toEqual(["tab-list"]);
  });

  test("does not mutate caller args or rewrite other commands", () => {
    const args = ["open", "https://example.com"];
    expect(normalizeCommandArgs(args)).toEqual(args);
    expect(args).toEqual(["open", "https://example.com"]);
  });
});

describe("resolveChromeProfileSelector", () => {
  const profiles: Array<[string, { user_name?: string; name?: string }]> = [
    ["Default", { user_name: "person@example.com", name: "Work" }],
    ["Profile 1", { user_name: "other@example.com", name: "Personal" }],
    ["Profile 2", { name: "Guest" }],
  ];

  test("resolves exact email before profile name and folder", () => {
    const conflicting: typeof profiles = [
      ["Default", { user_name: "work", name: "Default profile" }],
      ["Profile 1", { user_name: "other@example.com", name: "work" }],
      ["work", { name: "Folder match" }],
    ];
    expect(resolveChromeProfileSelector(conflicting, "WORK")?.[0]).toBe("Default");
  });

  test("falls back to exact profile name, then exact folder name", () => {
    expect(resolveChromeProfileSelector(profiles, "personal")?.[0]).toBe("Profile 1");
    expect(resolveChromeProfileSelector(profiles, "profile 2")?.[0]).toBe("Profile 2");
  });

  test("does not accept partial email matches", () => {
    expect(resolveChromeProfileSelector(profiles, "person")).toBeNull();
  });

  test("rejects bare menu numbers", () => {
    expect(() => resolveChromeProfileSelector(profiles, "1")).toThrow("no longer accepts menu numbers");
  });

  test("allows numbered profile folder names when written in full", () => {
    expect(resolveChromeProfileSelector(profiles, "Profile 1")?.[0]).toBe("Profile 1");
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

describe("resolveGlobalProfile", () => {
  const registry = {
    "taku@example.com": { extensionId: "abc123", token: "tok001", profileDir: "Profile 1" },
    "other@example.com": { extensionId: "def456", token: "tok002", profileDir: "Default", userDataDir: "/tmp/ud" },
  };
  const cache = {
    "Default": { user_name: "other@example.com", name: "Work" },
    "Profile 1": { user_name: "taku@example.com", name: "Personal" },
    "Profile 2": { name: "Guest" },
  };

  test("resolves by exact registry email key (case-insensitive)", async () => {
    const result = await resolveGlobalProfile(registry, null, "Taku@Example.com");
    expect(result.email).toBe("taku@example.com");
    expect(result.entry.profileDir).toBe("Profile 1");
    expect(result.entry.token).toBe("tok001");
  });

  test("resolves by Chrome profile name via cache → email → registry", async () => {
    const result = await resolveGlobalProfile(registry, cache, "Personal");
    expect(result.email).toBe("taku@example.com");
    expect(result.entry.profileDir).toBe("Profile 1");
  });

  test("resolves by Chrome profile folder name via cache → email → registry", async () => {
    const result = await resolveGlobalProfile(registry, cache, "Profile 1");
    expect(result.email).toBe("taku@example.com");
    expect(result.entry.extensionId).toBe("abc123");
  });

  test("resolves by email via cache when not a direct registry key", async () => {
    const result = await resolveGlobalProfile(registry, cache, "other@example.com");
    expect(result.email).toBe("other@example.com");
    expect(result.entry.profileDir).toBe("Default");
    expect(result.entry.userDataDir).toBe("/tmp/ud");
  });

  test("throws when cache is null and registry key not found", async () => {
    await expect(resolveGlobalProfile(registry, null, "Unknown"))
      .rejects.toThrow("does not match any registered email");
  });

  test("throws when profile not found in cache", async () => {
    await expect(resolveGlobalProfile(registry, cache, "Nonexistent"))
      .rejects.toThrow("does not match any Chrome profile");
  });

  test("throws when profile has no email", async () => {
    await expect(resolveGlobalProfile(registry, cache, "Guest"))
      .rejects.toThrow("has no email associated");
  });

  test("throws when email from cache is not in registry", async () => {
    const noReg = { "taku@example.com": { extensionId: "a", token: "t", profileDir: "Default" } };
    await expect(resolveGlobalProfile(noReg, cache, "other@example.com"))
      .rejects.toThrow("is not registered");
  });

  test("throws for empty selector", async () => {
    await expect(resolveGlobalProfile(registry, cache, ""))
      .rejects.toThrow("requires a non-empty value");
  });

  test("throws for ambiguous profile name match", async () => {
    const dupCache = {
      "Profile 1": { user_name: "a@x.com", name: "Work" },
      "Profile 2": { user_name: "b@x.com", name: "Work" },
    };
    await expect(resolveGlobalProfile(registry, dupCache, "Work"))
      .rejects.toThrow("matches multiple profiles");
  });

  test("rejects bare menu numbers", async () => {
    await expect(resolveGlobalProfile(registry, cache, "1"))
      .rejects.toThrow("no longer accepts menu numbers");
  });
});

describe("extractGlobalProfileArg", () => {
  test("extracts --profile <val> from the leading flags", () => {
    const { args, selector } = extractGlobalProfileArg(
      ["--profile", "taku@example.com", "open", "https://example.com"],
    );
    expect(selector).toBe("taku@example.com");
    expect(args).toEqual(["open", "https://example.com"]);
  });

  test("extracts --profile=<val> from the leading flags", () => {
    const { args, selector } = extractGlobalProfileArg(
      ["--profile=taku@example.com", "eval", "() => document.title"],
    );
    expect(selector).toBe("taku@example.com");
    expect(args).toEqual(["eval", "() => document.title"]);
  });

  test("keeps a --profile placed after the subcommand (playwright-cli's own flag)", () => {
    const { args, selector } = extractGlobalProfileArg(
      ["open", "--profile", "/tmp/my-user-data-dir", "https://example.com"],
    );
    expect(selector).toBeUndefined();
    expect(args).toEqual(["open", "--profile", "/tmp/my-user-data-dir", "https://example.com"]);
  });

  test("keeps other leading flags (e.g. -s=...) alongside --profile", () => {
    const { args, selector } = extractGlobalProfileArg(
      ["-s=iso-deadbeef", "--profile", "other@example.com", "open", "about:blank"],
    );
    expect(selector).toBe("other@example.com");
    expect(args).toEqual(["-s=iso-deadbeef", "open", "about:blank"]);
  });

  test("last occurrence of --profile wins", () => {
    const { args, selector } = extractGlobalProfileArg(
      ["--profile", "a@x.com", "--profile=b@x.com", "open", "about:blank"],
    );
    expect(selector).toBe("b@x.com");
    expect(args).toEqual(["open", "about:blank"]);
  });

  test("throws when --profile is missing its value", () => {
    expect(() => extractGlobalProfileArg(["--profile"])).toThrow("requires a value");
    expect(() => extractGlobalProfileArg(["--profile", "--isolate", "open"])).toThrow("requires a value");
  });

  test("returns undefined selector when no --profile flag is present", () => {
    const { args, selector } = extractGlobalProfileArg(["open", "https://example.com"]);
    expect(selector).toBeUndefined();
    expect(args).toEqual(["open", "https://example.com"]);
  });
});
