// `rech fill-secret`: type a password or TOTP code into a page without the value ever
// reaching an argv, a log line, or command output.
//
// The secret lives with the client (an env var or stdin), so the client reads it and sends it
// in its own JSON body field, `secret`, never in `args`. The daemon (`serve`) then:
//   - logs only the args (ref + flags), never `secret`;
//   - hands the value to the session's cliDaemon over its local unix socket as a run-code
//     message, so no child process carries it in argv;
//   - checks the page host and fills in one step, so --allow-domain can't be raced by a
//     navigation between a separate check and the fill;
//   - masks the value as *** in that command's output, and keeps masking it in every later
//     output and served text file (snapshots echo input values, passwords included) for
//     SECRET_MASK_TTL_MS.
import { createHmac } from "crypto";
import { connect } from "net";
import { readdirSync } from "fs";
import { join } from "path";

export const SECRET_MASK = "***";
export const SECRET_MASK_TTL_MS = 15 * 60_000;

// ---------- client side ----------

export type FillSecretRequest = {
  ref: string;
  source: { kind: "env" | "stdin"; name?: string; envFile?: string };
  totp: boolean;
  allowDomains: string[];
  submit: boolean;
};

export const FILL_SECRET_USAGE = `Usage: rech fill-secret <ref> (--from-env VAR | --from-stdin | --totp-from-env VAR | --totp-from-stdin)
                         [--env-file <path>] [--allow-domain <glob>]... [--submit]
  Fills <ref> (from \`rech snapshot\`) with a secret the daemon never logs or echoes.
  --from-env VAR        the value of env var VAR on this machine
  --from-stdin          the first line of stdin
  --totp-from-env VAR   the current 6-digit TOTP code (RFC 6238, SHA1, 30s) for the base32 seed in VAR;
                        only the code leaves this machine, never the seed
  --totp-from-stdin     the same, seed read from stdin
  --env-file PATH       look VAR up in this dotenv file instead of the environment
  --allow-domain GLOB   refuse unless the page host matches, e.g. '*.my.salesforce.com' (repeatable)
  --submit              press Enter after filling`;

/** Parse `fill-secret` args (without the command itself). Throws a usage error. */
export function parseFillSecretArgs(args: string[]): FillSecretRequest {
  let ref: string | undefined;
  let source: FillSecretRequest["source"] | undefined;
  let totp = false;
  const allowDomains: string[] = [];
  let submit = false;
  let envFile: string | undefined;
  const setSource = (s: FillSecretRequest["source"], isTotp: boolean) => {
    if (source) throw new Error("fill-secret takes exactly one of --from-env, --from-stdin, --totp-from-env, --totp-from-stdin");
    source = s;
    totp = isTotp;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      if (a.startsWith("--") && eq > 0) return a.slice(eq + 1);
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--from-env") setSource({ kind: "env", name: value() }, false);
    else if (flag === "--totp-from-env") setSource({ kind: "env", name: value() }, true);
    else if (flag === "--from-stdin") setSource({ kind: "stdin" }, false);
    else if (flag === "--totp-from-stdin") setSource({ kind: "stdin" }, true);
    else if (flag === "--allow-domain") {
      // An explicitly empty guard (`--allow-domain "$UNSET"`) must not fail open into "no guard".
      const globs = value().split(",").map(s => s.trim());
      if (globs.some(g => !g)) throw new Error("--allow-domain got an empty host");
      allowDomains.push(...globs);
    }
    else if (flag === "--submit") submit = true;
    else if (flag === "--env-file") envFile = value();
    else if (a.startsWith("-")) throw new Error(`fill-secret: unknown option ${a}`);
    else if (ref === undefined) ref = a;
    // A second positional is almost certainly the secret itself typed on the command line,
    // which is exactly what this command exists to avoid. Don't echo it back.
    else throw new Error("fill-secret takes the secret from --from-env/--from-stdin, never as an argument");
  }
  if (!ref) throw new Error("fill-secret needs a target ref, e.g. e12 (see `rech snapshot`)");
  if (!source) throw new Error("fill-secret needs --from-env VAR, --from-stdin, --totp-from-env VAR or --totp-from-stdin");
  if (envFile) {
    if (source.kind !== "env") throw new Error("--env-file goes with --from-env / --totp-from-env");
    source.envFile = envFile;
  }
  if (source.kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.name!)) throw new Error(`fill-secret: "${source.name}" is not an environment variable name`);
  for (const d of allowDomains) domainGlobToRegExp(d); // validate early
  return { ref, source, totp, allowDomains, submit };
}

/** The args the daemon sees (and logs): the ref and flags, never the secret or where it came from. */
export function fillSecretWireArgs(req: FillSecretRequest): string[] {
  return ["fill-secret", req.ref, ...req.allowDomains.map(d => `--allow-domain=${d}`), ...(req.submit ? ["--submit"] : []), ...(req.totp ? ["--totp"] : [])];
}

/** Read the raw secret (a value, or a TOTP seed) from the client's env or stdin. */
export async function readSecretSource(source: FillSecretRequest["source"], env = process.env, stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<string> {
  if (source.kind === "env") {
    const v = source.envFile ? parseDotenv(await Bun.file(source.envFile).text().catch(() => { throw new Error(`fill-secret: cannot read ${source.envFile}`); }))[source.name!] : env[source.name!];
    if (!v) throw new Error(`fill-secret: ${source.name} is not set or empty${source.envFile ? ` in ${source.envFile}` : ""}`);
    return v;
  }
  const text = await stdin();
  const v = text.replace(/\r?\n[\s\S]*$/, "");
  if (!v) throw new Error("fill-secret: nothing on stdin");
  return v;
}

/** Minimal dotenv: KEY=VALUE, optional `export `, single/double quotes, # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) {
      v = v.slice(1, v.lastIndexOf(q));
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
    } else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

// ---------- TOTP (RFC 6238 / RFC 4226) ----------

export function base32Decode(input: string): Buffer {
  const s = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    // Never quote the input: it is the seed.
    if (v < 0) throw new Error("TOTP seed is not valid base32");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
  }
  if (!out.length) throw new Error("TOTP seed is empty");
  return Buffer.from(out);
}

export function totpCode(seedBase32: string, timeMs = Date.now(), opts: { digits?: number; period?: number; algorithm?: "sha1" | "sha256" | "sha512" } = {}): string {
  const { digits = 6, period = 30, algorithm = "sha1" } = opts;
  const counter = Math.floor(timeMs / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, base32Decode(seedBase32)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** ms to wait so a code still has at least `minLeftMs` of validity when it reaches the page. */
export function totpWaitMs(timeMs = Date.now(), period = 30, minLeftMs = 5000): number {
  const left = period * 1000 - (timeMs % (period * 1000));
  return left < minLeftMs ? left + 50 : 0;
}

// ---------- shared ----------

/**
 * `example.com` matches only that host; `*.example.com` matches any subdomain at any depth
 * (not the apex). Case-insensitive; ports are not part of the match.
 */
export function domainGlobToRegExp(glob: string): RegExp {
  const g = glob.trim().toLowerCase();
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(g)) throw new Error(`--allow-domain "${glob}" is not a host or *.host glob`);
  const esc = (s: string) => s.replace(/[.]/g, "\\.");
  return g.startsWith("*.") ? new RegExp(`^(?:[a-z0-9-]+\\.)+${esc(g.slice(2))}$`, "i") : new RegExp(`^${esc(g)}$`, "i");
}

export function hostAllowed(host: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some(g => domainGlobToRegExp(g).test(host));
}

// ---------- daemon side ----------

/** Parse what the daemon received; the scoped-listener check accepts exactly this shape. */
export function parseFillSecretWire(args: string[]): { ref: string; allowDomains: string[]; submit: boolean; totp: boolean } {
  const [cmd, ref, ...rest] = args;
  if (cmd !== "fill-secret" || !ref || ref.startsWith("-")) throw new Error("fill-secret needs a target ref");
  const allowDomains: string[] = [];
  let submit = false, totp = false;
  for (const a of rest) {
    if (a === "--submit") submit = true;
    else if (a === "--totp") totp = true;
    else if (a.startsWith("--allow-domain=")) { const d = a.slice("--allow-domain=".length); domainGlobToRegExp(d); allowDomains.push(d); }
    else throw new Error(`fill-secret: unexpected argument ${a.startsWith("-") ? a : "(positional)"}`);
  }
  return { ref, allowDomains, submit, totp };
}

/**
 * The run-code function the cliDaemon executes. The host check reads the target element's OWN
 * document (so a cross-origin iframe ref is checked against the iframe, not the top page), and the
 * fill goes through that same element handle: if the document navigates after the check, the
 * handle is detached and the fill fails instead of landing on the new page. The value is embedded
 * as a JSON string literal; the cliDaemon echoes this code back, which the daemon masks.
 */
export function buildFillCode(ref: string, value: string, allowDomains: string[], submit: boolean): string {
  const patterns = allowDomains.map(d => domainGlobToRegExp(d).source);
  const locator = /^(f\d+)?e\d+$/.test(ref) ? `page.locator(${JSON.stringify(`aria-ref=${ref}`)})` : `page.locator(${JSON.stringify(ref)})`;
  return `async page => {
  const el = await ${locator}.elementHandle({ timeout: 10000 });
  try {
    const host = String(await el.evaluate(e => e.ownerDocument.location.hostname)).toLowerCase();
    const allowed = ${JSON.stringify(patterns)};
    if (allowed.length && !allowed.some(p => new RegExp(p, "i").test(host)))
      throw new Error("fill-secret refused: the field's page host " + JSON.stringify(host) + " is not allowed by --allow-domain ${allowDomains.join(",").replace(/[^a-z0-9*.,-]/gi, "")}");
    await el.fill(${JSON.stringify(value)}, { timeout: 10000 });
    ${submit ? `await el.press("Enter", { timeout: 10000 });` : ""}
    return "filled " + ${JSON.stringify(ref)} + " on " + host;
  } finally {
    await el.dispose().catch(() => {});
  }
}`;
}

/**
 * Values to mask, with expiry. Global, not per-session: masking a stray match is harmless.
 * Passwords are masked for the daemon's lifetime (they stay in the field); TOTP codes for the
 * default TTL (an expired code is worthless). A daemon restart forgets them.
 */
export class SecretMasker {
  private values = new Map<string, number>();
  constructor(private ttlMs = SECRET_MASK_TTL_MS, private now = () => Date.now()) {}
  add(value: string, ttlMs = this.ttlMs) { if (value) this.values.set(value, this.now() + ttlMs); }
  get active(): boolean { this.prune(); return this.values.size > 0; }
  mask(text: string): string {
    if (!text) return text;
    this.prune();
    // Longest first, so a value containing another is masked whole.
    for (const v of [...this.values.keys()].sort((a, b) => b.length - a.length)) {
      text = text.replaceAll(v, SECRET_MASK);
      // The cliDaemon echoes the value as a JS string literal; mask that spelling too.
      const lit = JSON.stringify(v).slice(1, -1);
      if (lit !== v) text = text.replaceAll(lit, SECRET_MASK);
    }
    return text;
  }
  private prune() { const t = this.now(); for (const [v, exp] of this.values) if (exp <= t) this.values.delete(v); }
}

/**
 * cliDaemon sockets for exactly this session: `<root>/<16-hex workspaceHash>-<session>.sock`, or
 * older `<session>.sock`. Never a plain suffix match: session `aaaa` must not match another
 * client's `<hash>-bbbb-aaaa.sock` (its `-s=aaaa` sub-session).
 */
export function sessionSocketCandidates(socketRoot: string, session: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(socketRoot); } catch { return []; }
  return names.filter(n => n === `${session}.sock` || (n.length === session.length + 22 && /^[0-9a-f]{16}-/.test(n) && n.slice(17) === `${session}.sock`)).map(n => join(socketRoot, n));
}

/** One request/response over a cliDaemon socket (newline-delimited JSON). */
export function socketRequest(path: string, method: string, params: unknown, timeoutMs = 30_000): Promise<{ result?: any; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, timeoutMs);
    sock.setEncoding("utf8"); // decode across chunk boundaries, not per chunk
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.destroy();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch { reject(new Error("unreadable cliDaemon response")); }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.on("close", () => { clearTimeout(timer); reject(new Error("cliDaemon closed the connection")); });
  });
}

/** Run a run-code function on the session's live browser over its cliDaemon socket (no child argv). */
export async function runCodeOnSession(opts: { socketRoot: string; session: string; cwd: string; code: string; json?: boolean }): Promise<{ isError: boolean; text: string }> {
  // The cliDaemon listens on a named pipe there, which this socket scan can't find.
  if (process.platform === "win32") throw new Error("fill-secret is not supported on a Windows daemon yet");
  const candidates = sessionSocketCandidates(opts.socketRoot, opts.session);
  if (!candidates.length) throw new Error("no browser is open in this session; run `rech open <url>` first");
  const errors: string[] = [];
  for (const path of candidates) {
    let reply: { result?: any; error?: string };
    try {
      reply = await socketRequest(path, "run", { args: { _: ["run-code", opts.code] }, cwd: opts.cwd, ...(opts.json ? { json: true } : {}) });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e)); // stale socket: try the next one
      continue;
    }
    if (reply.error) throw new Error(reply.error);
    const r = reply.result;
    return { isError: !!r?.isError, text: typeof r === "string" ? r : typeof r?.text === "string" ? r.text : "" };
  }
  throw new Error(`could not reach this session's browser (${errors.join("; ")}); run \`rech open <url>\` first`);
}

/**
 * Fill on the session's live browser. Returns the cliDaemon's reply (NOT yet masked — the
 * caller masks it) or throws an error whose message never contains the value.
 */
export function fillSecretOnSession(opts: { socketRoot: string; session: string; cwd: string; ref: string; value: string; allowDomains: string[]; submit: boolean }): Promise<{ isError: boolean; text: string }> {
  return runCodeOnSession({ ...opts, code: buildFillCode(opts.ref, opts.value, opts.allowDomains, opts.submit) });
}

// ---------- password fields in snapshots ----------
//
// Snapshots print every input's value, and that includes password fields Chrome autofilled
// (or the user typed), which never went through fill-secret. Before a snapshot-bearing output
// leaves the daemon, read the live password values (all frames) and mask them like secrets.

const PASSWORD_VALUES_CODE = `async page => {
  const out = [];
  for (const frame of page.frames()) {
    try { out.push(...await frame.$$eval("input[type=password]", els => els.map(e => e.value))); } catch {}
  }
  return out.filter(Boolean);
}`;

/** Current values of every password input on the session's page. Never logs them. */
export async function passwordValuesOnSession(opts: { socketRoot: string; session: string; cwd: string }): Promise<string[]> {
  const { isError, text } = await runCodeOnSession({ ...opts, code: PASSWORD_VALUES_CODE, json: true });
  if (isError) throw new Error("password scan failed");
  return parseRunCodeStringArray(text);
}

/** The run-code result: `{"result": "[...]"}` in json mode, or a `### Result` section from older cliDaemons. */
export function parseRunCodeStringArray(text: string): string[] {
  let raw: unknown;
  try { raw = JSON.parse(text).result; } catch { raw = text.match(/### Result\n([^\n]*)/)?.[1]; }
  let value: unknown = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { value = undefined; } }
  if (!Array.isArray(value)) throw new Error("password scan returned no list");
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** True when a command's output carries a snapshot (inline or as a saved file). */
export const hasSnapshot = (text: string) => /### Snapshot|\.ya?ml\b/.test(text);

/**
 * Fallback for when the live scan misses (the page moved on, the scan failed): blank the value
 * of any snapshot textbox whose accessible name reads like a password field.
 */
const PASSWORD_LINE = /^(\s*-\s*textbox\s+"[^"\n]*(?:password|passwd|passcode|\bpin\b|パスワード|暗証)[^"\n]*"[^\n:]*):[ \t]+\S.*$/gim;
export function maskPasswordLines(text: string): string {
  return text.replace(PASSWORD_LINE, `$1: ${SECRET_MASK}`);
}
