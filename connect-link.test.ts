import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connectEnvLink, connectLinkProblem, firstLink, promptConnectLink, resolveConnectLink } from "./rechrome.ts";

const LINK = "https://rechrome.pages.dev/share/#rech1_invite_ABCDEFGHJKLMNPQRSTUVWXYZ2345";

test("firstLink takes the first non-empty trimmed line, tolerating a trailing newline and comments", () => {
  expect(firstLink(LINK)).toBe(LINK);
  expect(firstLink(`${LINK}\n`)).toBe(LINK);
  expect(firstLink(`  ${LINK}  \n\n`)).toBe(LINK);
  expect(firstLink(`\n\n${LINK}\nignored second line`)).toBe(LINK);
  expect(firstLink("")).toBe("");
  expect(firstLink("   \n  \n")).toBe("");
});

test("resolveConnectLink returns an inline url argument unchanged", async () => {
  expect(await resolveConnectLink(LINK, undefined)).toBe(LINK);
});

test("resolveConnectLink reads from a file, trimming a trailing newline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rech-connect-"));
  const path = join(dir, "link.txt");
  writeFileSync(path, `${LINK}\n`, { mode: 0o600 });
  expect(await resolveConnectLink(undefined, path)).toBe(LINK);
});

test("resolveConnectLink reads from stdin when url is -", async () => {
  expect(await resolveConnectLink("-", undefined, async () => `${LINK}\n`)).toBe(LINK);
});

test("resolveConnectLink reads from stdin when url is \"\" (yargs renders a bare - as empty)", async () => {
  expect(await resolveConnectLink("", undefined, async () => `${LINK}\n`)).toBe(LINK);
});

test("resolveConnectLink rejects url and file together", async () => {
  await expect(resolveConnectLink(LINK, "/tmp/whatever")).rejects.toThrow(/not more than one/);
});

test("resolveConnectLink rejects an empty file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rech-connect-"));
  const path = join(dir, "empty.txt");
  writeFileSync(path, "\n\n", { mode: 0o600 });
  await expect(resolveConnectLink(undefined, path)).rejects.toThrow(/No link found/);
});

test("resolveConnectLink rejects empty stdin", async () => {
  await expect(resolveConnectLink("-", undefined, async () => "\n")).rejects.toThrow(/No link on stdin/);
});

test("resolveConnectLink without any source explains the secure options", async () => {
  await expect(resolveConnectLink(undefined, undefined, undefined, { envLink: () => undefined, isTTY: false })).rejects.toThrow(/--file|stdin/);
});

const TOKEN = "rech1_invite_ABCDEFGHJKLMNPQRSTUVWXYZ2345";

test("resolveConnectLink reads a bare rech1_ token from stdin", async () => {
  expect(await resolveConnectLink("-", undefined, async () => `  ${TOKEN}\n`)).toBe(TOKEN);
});

test("resolveConnectLink without url or file falls back to the environment", async () => {
  expect(await resolveConnectLink(undefined, undefined, undefined, { envLink: () => LINK })).toBe(LINK);
  expect(await resolveConnectLink(undefined, undefined, undefined, { envLink: () => TOKEN })).toBe(TOKEN);
});

test("resolveConnectLink keeps a positional url ahead of the environment", async () => {
  expect(await resolveConnectLink(TOKEN, undefined, undefined, { envLink: () => LINK })).toBe(TOKEN);
});

test("resolveConnectLink --from-env requires the variable and no other source", async () => {
  expect(await resolveConnectLink(undefined, undefined, undefined, { fromEnv: true, envLink: () => LINK })).toBe(LINK);
  await expect(resolveConnectLink(undefined, undefined, undefined, { fromEnv: true, envLink: () => undefined })).rejects.toThrow(/RECH_CONNECT_URL or RECHROME_URL/);
  await expect(resolveConnectLink("-", undefined, undefined, { fromEnv: true, envLink: () => LINK })).rejects.toThrow(/not more than one/);
});

test("connectEnvLink prefers RECH_CONNECT_URL, trims, and ignores keys not inherited from the shell", () => {
  const all = new Set(["RECH_CONNECT_URL", "RECHROME_URL"]);
  expect(connectEnvLink({ RECH_CONNECT_URL: ` ${TOKEN}\n`, RECHROME_URL: LINK }, all)).toBe(TOKEN);
  expect(connectEnvLink({ RECHROME_URL: LINK }, all)).toBe(LINK);
  // RECHROME_URL loaded from a saved .env.local is the current connection, not a link to connect.
  expect(connectEnvLink({ RECHROME_URL: LINK }, new Set())).toBeUndefined();
  expect(connectEnvLink({ RECH_CONNECT_URL: "  " }, all)).toBeUndefined();
});

test("resolveConnectLink at a TTY with no link or env asks with the prompt", async () => {
  let asked = 0;
  const link = await resolveConnectLink(undefined, undefined, async () => { throw new Error("stdin must not be read"); }, { envLink: () => undefined, isTTY: true, prompt: async () => { asked++; return LINK; } });
  expect(link).toBe(LINK);
  expect(asked).toBe(1);
});

test("resolveConnectLink prefers the environment over the TTY prompt, and - still reads piped stdin", async () => {
  const prompt = async () => { throw new Error("should not prompt"); };
  expect(await resolveConnectLink(undefined, undefined, undefined, { envLink: () => TOKEN, isTTY: true, prompt })).toBe(TOKEN);
  expect(await resolveConnectLink("-", undefined, async () => LINK, { isTTY: true, prompt })).toBe(LINK);
});

test("promptConnectLink trims, re-asks on an invalid paste, and gives up on EOF or 3 bad tries", async () => {
  const answers = ["not a link", `  ${LINK}\n`];
  const warnings: string[] = [];
  const questions: string[] = [];
  expect(await promptConnectLink(async q => { questions.push(q); return answers.shift()!; }, m => warnings.push(m))).toBe(LINK);
  expect(questions[0]).toMatch(/Paste the share link/);
  expect(warnings).toHaveLength(1);
  await expect(promptConnectLink(async () => null, () => {})).rejects.toThrow(/No link entered/);
  await expect(promptConnectLink(async () => "nope", () => {})).rejects.toThrow(/No valid link/);
});

test("connectLinkProblem accepts share links and bare tokens only", () => {
  expect(connectLinkProblem(LINK)).toBeNull();
  expect(connectLinkProblem(TOKEN)).toBeNull();
  expect(connectLinkProblem("")).toMatch(/Nothing/);
  expect(connectLinkProblem("ftp://x")).toMatch(/not a share link/);
  expect(connectLinkProblem("hello")).toMatch(/not a share link/);
});
