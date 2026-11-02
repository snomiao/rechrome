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
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SECRET_MASK = "***";
export const SECRET_MASK_TTL_MS = 15 * 60_000;
/** Shorter values are never masked: masking "1" everywhere would turn every 1 in every output
 *  into ***, corrupting ids and refs for the daemon's lifetime. A TOTP code (6 digits) still is.
 *  A short value is kept out of fill-secret's own reply by dropping the echoed code that holds it,
 *  and out of its error message by an exact replace; anything the page itself shows is not masked. */
export const MIN_MASK_LENGTH = 6;
export const maskable = (value: string | undefined | null): value is string => !!value && value.length >= MIN_MASK_LENGTH;

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
  --allow-domain GLOB   refuse unless the page host matches, e.g. '*.app.example.com' (repeatable)
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
  add(value: string, ttlMs = this.ttlMs) { if (maskable(value)) this.values.set(value, this.now() + ttlMs); }
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

/**
 * Read `socketPath` from `<baseDaemonDir>/<16-hex workspaceHash>/<session>.session` written by
 * cliDaemon (including Windows named pipes `\\.\pipe\pw-...`, which do not appear in socketRoot).
 */
export function daemonSessionSockets(session: string, env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const bases = env.PLAYWRIGHT_DAEMON_SESSION_DIR
    ? [env.PLAYWRIGHT_DAEMON_SESSION_DIR]
    : process.platform === "win32"
    ? [...new Set([
        join(env.USERPROFILE || home, "AppData", "Local", "ms-playwright", "daemon"),
        ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "ms-playwright", "daemon")] : []),
      ])]
    : process.platform === "darwin"
    ? [join(home, "Library", "Caches", "ms-playwright", "daemon")]
    : [join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright", "daemon")];
  const out: string[] = [];
  for (const base of bases) {
    let hashes: string[] = [];
    try { hashes = readdirSync(base); } catch { continue; }
    for (const h of hashes) {
      if (!/^[0-9a-f]{16}$/.test(h)) continue;
      try {
        const cfg = JSON.parse(readFileSync(join(base, h, `${session}.session`), "utf8"));
        if ((cfg?.name ?? session) === session && typeof cfg?.socketPath === "string" && cfg.socketPath)
          out.push(cfg.socketPath);
      } catch {}
    }
  }
  return [...new Set(out)];
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
  const candidates = [...new Set([...sessionSocketCandidates(opts.socketRoot, opts.session), ...daemonSessionSockets(opts.session)])];
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

/** Run a plain CLI command (e.g. tab-list, tab-select) on the session's browser over its socket. */
export async function runCliOnSession(opts: { socketRoot: string; session: string; cwd: string }, cliArgs: string[]): Promise<{ isError: boolean; text: string }> {
  const candidates = [...new Set([...sessionSocketCandidates(opts.socketRoot, opts.session), ...daemonSessionSockets(opts.session)])];
  for (const path of candidates) {
    let reply: { result?: any; error?: string };
    try { reply = await socketRequest(path, "run", { args: { _: cliArgs }, cwd: opts.cwd }); }
    catch { continue; }
    if (reply.error) throw new Error(reply.error);
    const r = reply.result;
    return { isError: !!r?.isError, text: typeof r === "string" ? r : typeof r?.text === "string" ? r.text : "" };
  }
  throw new Error("no browser is open in this session");
}

/**
 * Fill on the session's live browser. Returns the cliDaemon's reply (NOT yet masked — the
 * caller masks it) or throws an error whose message never contains the value.
 */
export function fillSecretOnSession(opts: { socketRoot: string; session: string; cwd: string; ref: string; value: string; allowDomains: string[]; submit: boolean }): Promise<{ isError: boolean; text: string }> {
  return runCodeOnSession({ ...opts, code: buildFillCode(opts.ref, opts.value, opts.allowDomains, opts.submit) });
}

// ---------- read-secret: a field's value to a pipe ----------
//
// The reverse of fill-secret, for moving a secret a page shows (an API signing secret in a
// password-type field) into a vault without it appearing anywhere. The page host must match a
// required --allow-domain; the value travels only in the response's `secretOut` field, is never
// logged, is masked in every later output, and the client writes it raw to a pipe only, never
// to a terminal. On a profile-scoped listener it is refused unless the host turned it on.

export const READ_SECRET_USAGE = `Usage: rech read-secret <ref|selector> --allow-domain <glob> [--allow-domain <glob>]... | <vault command>
  Writes the field's current value, raw and without a newline, to stdout, which must be a pipe
  into the program that stores it (never a terminal or a file). The value is never logged and
  is masked in later outputs.
  --allow-domain GLOB   required: refuse unless the field's page host matches, e.g. app.slack.com`;

/** Client args → the wire args (same shape); --allow-domain is required. */
export function parseReadSecretArgs(args: string[]): { ref: string; allowDomains: string[] } {
  const [cmd, ...rest] = args;
  if (cmd !== "read-secret") throw new Error("Expected read-secret");
  let ref: string | undefined;
  const allowDomains: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--allow-domain" || a.startsWith("--allow-domain=")) {
      const v = a === "--allow-domain" ? rest[++i] : a.slice("--allow-domain=".length);
      if (!v) throw new Error("--allow-domain got an empty host");
      for (const d of v.split(",")) { domainGlobToRegExp(d.trim()); allowDomains.push(d.trim()); }
    } else if (a.startsWith("-")) throw new Error(`read-secret: unknown option ${a}`);
    else if (ref === undefined) ref = a;
    else throw new Error("read-secret takes one target");
  }
  if (!ref) throw new Error("read-secret needs a target ref (from rech snapshot) or a selector");
  if (!allowDomains.length) throw new Error("read-secret needs --allow-domain: name the site the secret must come from");
  return { ref, allowDomains };
}

export function readSecretWireArgs(req: { ref: string; allowDomains: string[] }): string[] {
  return ["read-secret", req.ref, ...req.allowDomains.map(d => `--allow-domain=${d}`)];
}

/** Parse what the daemon received; exactly the shape readSecretWireArgs sends. */
export function parseReadSecretWire(args: string[]): { ref: string; allowDomains: string[] } {
  const [cmd, ref, ...rest] = args;
  if (cmd !== "read-secret" || !ref || ref.startsWith("-")) throw new Error("read-secret needs a target ref");
  const allowDomains: string[] = [];
  for (const a of rest) {
    if (!a.startsWith("--allow-domain=")) throw new Error(`read-secret: unexpected argument ${a.startsWith("-") ? a : "(positional)"}`);
    const d = a.slice("--allow-domain=".length);
    domainGlobToRegExp(d);
    allowDomains.push(d);
  }
  if (!allowDomains.length) throw new Error("read-secret needs --allow-domain");
  return { ref, allowDomains };
}

/** run-code that checks the field's own document host, then returns {host, value} as JSON. */
export function buildReadCode(ref: string, allowDomains: string[]): string {
  const patterns = allowDomains.map(d => domainGlobToRegExp(d).source);
  const locator = /^(f\d+)?e\d+$/.test(ref) ? `page.locator(${JSON.stringify(`aria-ref=${ref}`)})` : `page.locator(${JSON.stringify(ref)})`;
  return `async page => {
  const el = await ${locator}.elementHandle({ timeout: 10000 });
  try {
    const host = String(await el.evaluate(e => e.ownerDocument.location.hostname)).toLowerCase();
    const allowed = ${JSON.stringify(patterns)};
    if (!allowed.some(p => new RegExp(p, "i").test(host)))
      throw new Error("read-secret refused: the field's page host " + JSON.stringify(host) + " is not allowed by --allow-domain");
    // Like fill: a label ref means its control. A field reads as its value; anything else (a
    // secret shown as text after "Show") as its text.
    // A page getter can throw an error that quotes the value: report a fixed message instead.
    let value;
    try {
      value = await el.evaluate(e => {
        const t = e.tagName === "LABEL" && e.control ? e.control : e;
        return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ? String(t.value) : String(t.textContent ?? "").trim();
      });
    } catch { throw new Error("read-secret: could not read the field"); }
    return JSON.stringify({ host, value });
  } finally {
    await el.dispose().catch(() => {});
  }
}`;
}

/** Read the field on the session's live browser. The returned value must never be logged. */
export async function readSecretOnSession(opts: { socketRoot: string; session: string; cwd: string; ref: string; allowDomains: string[] }): Promise<{ host: string; value: string }> {
  const { isError, text } = await runCodeOnSession({ ...opts, code: buildReadCode(opts.ref, opts.allowDomains), json: true });
  // Pass on only the messages this code writes itself (they hold the host, never the value).
  if (isError) throw new Error(text.match(/read-secret refused: [^\n]*/)?.[0] ?? (/no browser is open|could not reach/.test(text) ? text.trim().split("\n")[0]! : "read-secret: could not read the field (is the ref from a fresh rech snapshot?)"));
  let raw: unknown;
  try { raw = JSON.parse(text).result; } catch { raw = text.match(/### Result\n([^\n]*)/)?.[1]; }
  let out: any = raw;
  for (let i = 0; i < 2 && typeof out === "string"; i++) { try { out = JSON.parse(out); } catch { out = undefined; } }
  if (!out || typeof out.host !== "string" || typeof out.value !== "string") throw new Error("read-secret: the page returned no value");
  return out;
}

// ---------- read-storage: a localStorage/sessionStorage value to a pipe ----------
//
// Same contract as read-secret: value only in `secretOut`, never logged, masked later, client
// pipe-only. For the live app token in storage (Slack's localConfig_v2 teams[T...].token). Reads
// via page-level evaluate, so it works over the extension bridge. localStorage is per-origin, so
// the session's page must be on the allowed host.

export const READ_STORAGE_USAGE = `Usage: rech read-storage <local|session> <key> [json-path] --allow-domain <glob> [--goto <url>] | <command>
  Writes the storage value, raw and without a newline, to stdout, which must be a pipe into the
  program that stores it (never a terminal or a file). Never logged; masked in later outputs.
  <local|session>       localStorage or sessionStorage
  <key>                 the storage key, e.g. localConfig_v2
  [json-path]           optional: a path into the JSON value, e.g. teams.T0123.token or teams[T0123].token
  --allow-domain GLOB   required: the page's host must match, e.g. app.slack.com
  --goto URL            first navigate the attached tab to URL (host must match --allow-domain),
                        so the value is read from it, e.g. --goto https://app.slack.com/client/T0`;

/** Split "teams[T0123].token" / "teams.T0123.token" into ["teams","T0123","token"]. */
export function parseStoragePath(path: string): string[] {
  return path.match(/[^.[\]]+/g) ?? [];
}

export function parseReadStorageArgs(args: string[]): { area: "local" | "session"; key: string; path: string[]; allowDomains: string[]; gotoUrl?: string } {
  const [cmd, ...rest] = args;
  if (cmd !== "read-storage") throw new Error("Expected read-storage");
  const pos: string[] = [];
  const allowDomains: string[] = [];
  let gotoUrl: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--allow-domain" || a.startsWith("--allow-domain=")) {
      const v = a === "--allow-domain" ? rest[++i] : a.slice("--allow-domain=".length);
      if (!v) throw new Error("--allow-domain got an empty host");
      for (const d of v.split(",")) { domainGlobToRegExp(d.trim()); allowDomains.push(d.trim()); }
    } else if (a === "--goto" || a.startsWith("--goto=")) {
      gotoUrl = a === "--goto" ? rest[++i] : a.slice("--goto=".length);
      if (!gotoUrl) throw new Error("--goto got an empty URL");
    } else if (a.startsWith("-")) throw new Error(`read-storage: unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length < 2 || pos.length > 3) throw new Error("read-storage needs <local|session> <key> [json-path]");
  const [area, key, rawPath] = pos;
  if (area !== "local" && area !== "session") throw new Error("read-storage: first argument must be 'local' or 'session'");
  if (!key) throw new Error("read-storage: a storage key is required");
  if (!allowDomains.length) throw new Error("read-storage needs --allow-domain: name the site the value must come from");
  if (gotoUrl) { let u; try { u = new URL(gotoUrl); } catch { throw new Error("--goto must be an http(s) URL"); } if (!/^https?:$/.test(u.protocol)) throw new Error("--goto must be an http(s) URL"); if (!allowDomains.some(d => domainGlobToRegExp(d).test(u.hostname.toLowerCase()))) throw new Error("--goto URL host must match --allow-domain"); }
  return { area, key, path: rawPath ? parseStoragePath(rawPath) : [], allowDomains, gotoUrl };
}

export function readStorageWireArgs(req: { area: string; key: string; path: string[]; allowDomains: string[]; gotoUrl?: string }): string[] {
  return ["read-storage", req.area, req.key, ...(req.path.length ? [req.path.join(".")] : []), ...req.allowDomains.map(d => `--allow-domain=${d}`), ...(req.gotoUrl ? [`--goto=${req.gotoUrl}`] : [])];
}

export function parseReadStorageWire(args: string[]): { area: "local" | "session"; key: string; path: string[]; allowDomains: string[]; gotoUrl?: string } {
  const [cmd, area, key, ...rest] = args;
  if (cmd !== "read-storage" || (area !== "local" && area !== "session") || !key || key.startsWith("-")) throw new Error("read-storage needs <local|session> <key>");
  const allowDomains: string[] = [];
  let path: string[] = [];
  let gotoUrl: string | undefined;
  for (const a of rest) {
    if (a.startsWith("--allow-domain=")) { const d = a.slice("--allow-domain=".length); domainGlobToRegExp(d); allowDomains.push(d); }
    else if (a.startsWith("--goto=")) { gotoUrl = a.slice("--goto=".length); }
    else if (!a.startsWith("-") && !path.length) path = parseStoragePath(a);
    else throw new Error(`read-storage: unexpected argument ${a.startsWith("-") ? a : "(positional)"}`);
  }
  if (!allowDomains.length) throw new Error("read-storage needs --allow-domain");
  return { area, key, path, allowDomains, gotoUrl };
}

/** run-code reading storage[key], optionally walking a JSON path; returns {host,value} JSON. */
export function buildReadStorageCode(area: "local" | "session", key: string, path: string[], allowDomains: string[]): string {
  const patterns = allowDomains.map(d => domainGlobToRegExp(d).source);
  const store = area === "local" ? "localStorage" : "sessionStorage";
  return `async page => {
  const allowed = ${JSON.stringify(patterns)};
  const hostOf = (u) => { const m = /^[a-z][a-z0-9+.-]*:\\/\\/([^/?#]+)/i.exec(String(u || "")); return m ? m[1].replace(/^[^@]*@/, "").replace(/:\\d+$/, "").toLowerCase() : ""; };
  const ok = (h) => h && allowed.some(p => new RegExp(p, "i").test(h));
  // The caller has foregrounded the --allow-domain tab; read from whichever of this tab's frames
  // is on the allowed host (the top frame can be a blank wrapper over the bridge).
  const frame = page.frames().find(f => ok(hostOf(f.url())));
  const host = frame ? hostOf(frame.url()) : "";
  if (!frame)
    throw new Error("read-storage refused: the foreground tab is not on an --allow-domain host (host " + JSON.stringify(hostOf(page.url())) + ")");
  const out = await frame.evaluate(({ key, path }) => {
    const raw = window.${store}.getItem(key);
    if (raw === null) return { missing: true };
    if (!path.length) return { value: raw };
    let v;
    try { v = JSON.parse(raw); } catch { return { notjson: true }; }
    for (const seg of path) {
      if (v == null || typeof v !== "object") return { nopath: true };
      v = v[seg];
    }
    if (v === undefined) return { nopath: true };
    return { value: typeof v === "string" ? v : JSON.stringify(v) };
  }, { key: ${JSON.stringify(key)}, path: ${JSON.stringify(path)} });
  if (out.missing) throw new Error("read-storage: no ${store} key " + JSON.stringify(${JSON.stringify(key)}) + " on " + host);
  if (out.notjson) throw new Error("read-storage: the value is not JSON, so the path can't apply");
  if (out.nopath) throw new Error("read-storage: the json-path is not present in the value");
  return JSON.stringify({ host, value: out.value });
}`;
}

export async function readStorageOnSession(opts: { socketRoot: string; session: string; cwd: string; area: "local" | "session"; key: string; path: string[]; allowDomains: string[]; gotoUrl?: string }): Promise<{ host: string; value: string }> {
  // Over the extension bridge Playwright reaches only the attached tab, and localStorage is
  // per-origin. With --goto, navigate that tab to the allowed URL in THIS same invocation (so the
  // attachment can't change between navigate and read), then read it.
  if (opts.gotoUrl) {
    await runCliOnSession(opts, ["goto", opts.gotoUrl]).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
  }
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { isError, text } = await runCodeOnSession({ socketRoot: opts.socketRoot, session: opts.session, cwd: opts.cwd, code: buildReadStorageCode(opts.area, opts.key, opts.path, opts.allowDomains), json: true });
    if (!isError) {
      let raw: unknown;
      try { raw = JSON.parse(text).result; } catch { raw = text.match(/### Result\n([^\n]*)/)?.[1]; }
      let o: any = raw;
      for (let i = 0; i < 2 && typeof o === "string"; i++) { try { o = JSON.parse(o); } catch { o = undefined; } }
      if (o && typeof o.host === "string" && typeof o.value === "string") return o;
      throw new Error("read-storage: the page returned no value");
    }
    last = text.match(/read-storage(?: refused)?: [^\n]*/)?.[0] ?? (/no browser is open|could not reach/.test(text) ? text.trim().split("\n")[0]! : "read-storage: could not read the value");
    if (!/foreground tab is not on/.test(last)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  // A clearer hint for the common case: the allowed site isn't the attached tab.
  if (/foreground tab is not on/.test(last))
    last += ". Put the site on the active tab first: rech goto <url on that host>, then rerun read-storage.";
  throw new Error(last || "read-storage: could not read the value");
}

// ---------- read-cookie: a cookie value (incl. HttpOnly) to a pipe ----------
//
// Same contract as read-secret: the value travels only in the response's `secretOut`, is never
// logged, is masked in later outputs, and the client writes it raw to a pipe only. For moving a
// session cookie (Slack's HttpOnly `d`/xoxd) from the user's own browser into an auth tool.
// Reads via Playwright's context.cookies(), which returns HttpOnly cookies (document.cookie can't).

export const READ_COOKIE_USAGE = `Usage: rech read-cookie <name> <domain> --allow-domain <domain> | <command>
  Writes the cookie's value, raw and without a newline, to stdout, which must be a pipe into the
  program that stores it (never a terminal or a file). Never logged; masked in later outputs.
  <name>                the cookie name, e.g. d
  <domain>              the cookie's domain, e.g. acme.slack.com
  --allow-domain GLOB   required: the cookie's domain must match, e.g. acme.slack.com`;

function validCookieName(n: string): boolean {
  // RFC6265 token; no control/separator chars. Keeps the name out of regex/URL trouble.
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(n);
}

export function parseReadCookieArgs(args: string[]): { name: string; domain: string; allowDomains: string[] } {
  const [cmd, ...rest] = args;
  if (cmd !== "read-cookie") throw new Error("Expected read-cookie");
  const pos: string[] = [];
  const allowDomains: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--allow-domain" || a.startsWith("--allow-domain=")) {
      const v = a === "--allow-domain" ? rest[++i] : a.slice("--allow-domain=".length);
      if (!v) throw new Error("--allow-domain got an empty host");
      for (const d of v.split(",")) { domainGlobToRegExp(d.trim()); allowDomains.push(d.trim()); }
    } else if (a.startsWith("-")) throw new Error(`read-cookie: unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error("read-cookie needs <name> <domain>, e.g. rech read-cookie d acme.slack.com");
  const [name, domain] = pos;
  if (!validCookieName(name!)) throw new Error("read-cookie: that cookie name is not a valid token");
  if (!/^[a-z0-9.-]+$/i.test(domain!)) throw new Error("read-cookie: <domain> must be a plain host like acme.slack.com");
  if (!allowDomains.length) throw new Error("read-cookie needs --allow-domain: name the domain the cookie must belong to");
  return { name: name!, domain: domain!, allowDomains };
}

export function readCookieWireArgs(req: { name: string; domain: string; allowDomains: string[] }): string[] {
  return ["read-cookie", req.name, req.domain, ...req.allowDomains.map(d => `--allow-domain=${d}`)];
}

export function parseReadCookieWire(args: string[]): { name: string; domain: string; allowDomains: string[] } {
  const [cmd, name, domain, ...rest] = args;
  if (cmd !== "read-cookie" || !name || !domain || name.startsWith("-") || domain.startsWith("-")) throw new Error("read-cookie needs <name> <domain>");
  if (!validCookieName(name)) throw new Error("read-cookie: invalid cookie name");
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error("read-cookie: invalid domain");
  const allowDomains: string[] = [];
  for (const a of rest) {
    if (!a.startsWith("--allow-domain=")) throw new Error(`read-cookie: unexpected argument ${a.startsWith("-") ? a : "(positional)"}`);
    const d = a.slice("--allow-domain=".length);
    domainGlobToRegExp(d);
    allowDomains.push(d);
  }
  if (!allowDomains.length) throw new Error("read-cookie needs --allow-domain");
  return { name, domain, allowDomains };
}

/** run-code that reads one cookie via context.cookies(); returns {domain, value} JSON, or throws. */
export function buildReadCookieCode(name: string, domain: string, allowDomains: string[]): string {
  const patterns = allowDomains.map(d => domainGlobToRegExp(d).source);
  return `async page => {
  const allowed = ${JSON.stringify(patterns)};
  const dom = ${JSON.stringify(domain.toLowerCase())}.replace(/^\\./, "");
  if (!allowed.some(p => new RegExp(p, "i").test(dom)))
    throw new Error("read-cookie refused: domain " + JSON.stringify(dom) + " is not allowed by --allow-domain");
  // All cookies, any path (a URL filter would drop /app-scoped ones). Domain-match per RFC6265:
  // the cookie's own domain is dom, or a parent of dom (a ".slack.com" cookie serves a subdomain).
  const cookies = await page.context().cookies();
  const domainMatches = cd => { cd = String(cd).replace(/^\\./, "").toLowerCase(); return dom === cd || dom.endsWith("." + cd); };
  const match = cookies.filter(c => c.name === ${JSON.stringify(name)} && domainMatches(c.domain));
  if (!match.length) throw new Error("read-cookie: no cookie " + JSON.stringify(${JSON.stringify(name)}) + " for " + dom + " (is this profile signed in?)");
  const values = [...new Set(match.map(c => { try { return String(c.value); } catch { return null; } }))];
  if (values.length !== 1 || values[0] == null) throw new Error("read-cookie: " + match.length + " cookies named " + JSON.stringify(${JSON.stringify(name)}) + " for " + dom + " disagree; narrow the domain");
  return JSON.stringify({ domain: dom, value: values[0] });
}`;
}

export async function readCookieOnSession(opts: { socketRoot: string; session: string; cwd: string; name: string; domain: string; allowDomains: string[] }): Promise<{ domain: string; value: string }> {
  const { isError, text } = await runCodeOnSession({ ...opts, code: buildReadCookieCode(opts.name, opts.domain, opts.allowDomains), json: true });
  if (isError) throw new Error(text.match(/read-cookie(?: refused)?: [^\n]*/)?.[0] ?? (/no browser is open|could not reach/.test(text) ? text.trim().split("\n")[0]! : "read-cookie: could not read the cookie"));
  let raw: unknown;
  try { raw = JSON.parse(text).result; } catch { raw = text.match(/### Result\n([^\n]*)/)?.[1]; }
  let out: any = raw;
  for (let i = 0; i < 2 && typeof out === "string"; i++) { try { out = JSON.parse(out); } catch { out = undefined; } }
  if (!out || typeof out.domain !== "string" || typeof out.value !== "string") throw new Error("read-cookie: the browser returned no value");
  return out;
}

// ---------- password fields in snapshots ----------
//
// Snapshots print every input's value, and that includes password fields Chrome autofilled
// (or the user typed), which never went through fill-secret. Before a snapshot-bearing output
// leaves the daemon, read the live password values (all frames) and mask them like secrets.

// Password inputs, plus fields marked as passwords that a "show password" toggle turned into text.
const PASSWORD_FIELDS = 'input[type=password], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i], input[name*="pass" i], input[id*="pass" i]';
const PASSWORD_VALUES_CODE = `async page => {
  const values = [];
  let failedFrames = 0;
  for (const frame of page.frames()) {
    try { values.push(...await frame.$$eval(${JSON.stringify(PASSWORD_FIELDS)}, els => els.map(e => e.value))); } catch { failedFrames++; }
  }
  return { values: values.filter(Boolean), failedFrames };
}`;

/**
 * Current values of every password field on the session's page. Never logs them. Throws when
 * coverage is incomplete (a frame could not be read), so the caller can fail closed.
 */
export async function passwordValuesOnSession(opts: { socketRoot: string; session: string; cwd: string }): Promise<string[]> {
  const { isError, text } = await runCodeOnSession({ ...opts, code: PASSWORD_VALUES_CODE, json: true });
  if (isError) throw new Error("password scan failed");
  const { values, failedFrames } = parseScanResult(text);
  if (failedFrames) throw new Error(`password scan could not read ${failedFrames} frame(s)`);
  return values;
}

/** The run-code result: `{"result": "{...}"}` in json mode, or a `### Result` section from older cliDaemons. */
export function parseScanResult(text: string): { values: string[]; failedFrames: number } {
  let raw: unknown;
  try { raw = JSON.parse(text).result; } catch { raw = text.match(/### Result\n([^\n]*)/)?.[1]; }
  let value: any = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { value = undefined; } }
  if (!value || !Array.isArray(value.values) || typeof value.failedFrames !== "number") throw new Error("password scan returned no result");
  return { values: value.values.filter((v: unknown): v is string => typeof v === "string" && v.length > 0), failedFrames: value.failedFrames };
}

/** Replace inline snapshot sections when they could not be checked for password values. */
export function withholdSnapshots(text: string, reason: string): string {
  return text.replace(/### Snapshot\n[\s\S]*?(?=\n### |$)/g, `### Snapshot\n[rech] snapshot withheld: ${reason}. Retry the command.`);
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
