// Secret redaction, copied from snomiao/slack-term ts/redact.ts (PR #68, 73ae26e); keep
// the two in sync. rech runs it on every command's stdout/stderr; each secret becomes
// `[redacted:<rule id>]`. RECH_REDACT=0 turns it off for one call.
//
// Rules: gitleaks' default set (secret-rules/gitleaks.toml, v8.30.1, MIT — see
// secret-rules/gitleaks.LICENSE), run in-process by the JS regex engine, plus
// our own for what it does not cover (OWN_RULES). Measured 2026-11-02 on
// 1,000 synthetic messages (tests/redact.test.ts builds the same set):
// 0.1 ms and ~60 MB RSS per process, against ~0.9 s and ~62 MB per message
// for spawning the gitleaks binary, with the same catches.
import { readFileSync } from "node:fs";

export type SecretRule = {
  id: string;
  re: RegExp;
  /** Lowercase; the rule runs only when the text contains one of them. */
  keywords: string[];
  /** Minimum Shannon entropy of the secret (gitleaks' `entropy`). */
  entropy?: number;
  /** Which capture group is the secret (gitleaks' `secretGroup`). */
  group?: number;
  /** Allowlist regexes tested against the secret (gitleaks' regexTarget = secret, the default)… */
  allow: RegExp[];
  /** …against the whole match (regexTarget = match)… */
  allowMatch?: RegExp[];
  /** …and against the line the match is on (regexTarget = line). */
  allowLine?: RegExp[];
  stop: string[];
};

/** Go RE2 → JS. A leading `(?i)`/`(?s)` becomes a flag; a mid-pattern `(?i)`
 *  a scoped `(?i:…)` to the end of its group (JS has scoped modifiers, not
 *  RE2's open-ended ones); `(?P<n>` → `(?<n>`; POSIX classes spelled out;
 *  `\z` → `$`. */
export function goToJs(src: string): { source: string; flags: string } {
  let flags = "";
  for (;;) {
    const m = /^\(\?([is]+)\)/.exec(src);
    if (!m) break;
    flags += m[1];
    src = src.slice(m[0].length);
  }
  src = src.replaceAll("(?P<", "(?<").replaceAll("\\z", "$")
    .replaceAll("[[:alnum:]]", "[A-Za-z0-9]").replaceAll("[:alnum:]", "A-Za-z0-9")
    .replaceAll("[:alpha:]", "A-Za-z").replaceAll("[:digit:]", "0-9").replaceAll("[:space:]", "\\s");
  let out = "";
  const closers: number[] = []; // per open group: the scoped (?i: opened inside it
  let extra = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { out += c + (src[i + 1] ?? ""); i++; continue; }
    if (c === "[") { // a character class, verbatim
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (src.startsWith("(?i)", i)) { out += "(?i:"; extra++; i += 3; continue; }
    if (c === "(") { closers.push(extra); extra = 0; out += c; continue; }
    if (c === ")") { out += ")".repeat(extra); extra = closers.pop() ?? 0; out += c; continue; }
    // RE2's flag runs to the group's end across `|`; a JS scoped group must not swallow the
    // alternation, so close it before `|` and reopen it after.
    if (c === "|" && extra) { out += ")".repeat(extra) + "|" + "(?i:".repeat(extra); continue; }
    out += c;
  }
  out += ")".repeat(extra);
  return { source: out, flags: [...new Set(flags)].join("") };
}

type TomlAllow = { regexTarget?: string; regexes?: string[]; stopwords?: string[] };
type TomlRule = { id: string; regex?: string; keywords?: string[]; entropy?: number; secretGroup?: number; allowlists?: TomlAllow[]; allowlist?: TomlAllow };

/** gitleaks' rules TOML → rules. Path-only rules (no regex) are skipped. */
export function loadGitleaksRules(toml: string): SecretRule[] {
  const c = Bun.TOML.parse(toml) as { rules: TomlRule[]; allowlist?: TomlAllow };
  const compile = (r: string): RegExp => { const j = goToJs(r); return new RegExp(j.source, j.flags); };
  const gAllow = (c.allowlist?.regexes ?? []).map(compile);
  const gStop = (c.allowlist?.stopwords ?? []).map((s) => s.toLowerCase());
  const rules: SecretRule[] = [];
  for (const r of c.rules) {
    if (!r.regex) continue;
    const allow = [...gAllow];
    const allowMatch: RegExp[] = [];
    const allowLine: RegExp[] = [];
    const stop = [...gStop];
    for (const a of [...(r.allowlists ?? []), ...(r.allowlist ? [r.allowlist] : [])]) {
      // Each allowlist is tested against what it names, not always the secret
      // (generic-api-key's api_version exclusion is a regexTarget = match one).
      const into = a.regexTarget === "match" ? allowMatch : a.regexTarget === "line" ? allowLine : allow;
      for (const x of a.regexes ?? []) into.push(compile(x));
      for (const s of a.stopwords ?? []) stop.push(String(s).toLowerCase());
    }
    const j = goToJs(r.regex);
    rules.push({
      id: r.id, re: new RegExp(j.source, j.flags + "gd"), keywords: (r.keywords ?? []).map((k) => k.toLowerCase()),
      ...(r.entropy ? { entropy: r.entropy } : {}), ...(r.secretGroup ? { group: r.secretGroup } : {}), allow,
      ...(allowMatch.length ? { allowMatch } : {}), ...(allowLine.length ? { allowLine } : {}), stop,
    });
  }
  return rules;
}

/** Ours, for what gitleaks' set leaves out. */
export const OWN_RULES: SecretRule[] = [
  // ?token=… / &sig=… in a URL; `<your token>` and xxx-style placeholders are not secrets.
  { id: "url-secret-param", re: /[?&](?:access_token|token|key|api_key|apikey|secret|client_secret|password|passwd|pwd|sig|signature)=([^&\s#<>"'|]{6,})/gid, group: 1, keywords: ["="], allow: [/^(?:x+|\*+|\.\.\.|your[-_]?\w*|xxx\w*)$/i], stop: [] },
  // OpenAI / Anthropic / OpenRouter style keys, whatever their exact layout.
  { id: "sk-key", re: /\b(sk-(?:proj-|ant-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,})/gd, group: 1, keywords: ["sk-"], entropy: 3.5, allow: [], stop: [] },
  // A 6-digit code only right after a word that says it is one: a bare
  // 6-digit number is far more often an amount, an order or a build.
  { id: "otp-code", re: /(?:code|コード|otp|pin|passcode|認証|確認番号|ワンタイム)[^\d\n]{0,20}(?<![\d.])(\d{6})(?![\d.])/gid, group: 1, keywords: [], allow: [], stop: [] },
];

let cached: SecretRule[] | undefined;
/** gitleaks' rules + ours, loaded once. */
export function secretRules(): SecretRule[] {
  cached ??= [...loadGitleaksRules(readFileSync(new URL("./secret-rules/gitleaks.toml", import.meta.url), "utf8")), ...OWN_RULES];
  return cached;
}

function shannon(s: string): number {
  const f = new Map<string, number>();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export type SecretHit = { id: string; start: number; end: number };

/** Every span of an exact value the caller knows is secret (its own token, a
 *  value it filled in), longest first, plus the value's JSON-string spelling
 *  (a `"` or `\\` in it is escaped there). The 4th rule, after rechrome's
 *  fill-secret scrub; values shorter than 6 are ignored as unsafe to match. */
function findKnown(text: string, known: readonly string[]): SecretHit[] {
  const forms = new Set<string>();
  for (const v of known) {
    if (v.length < 6) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
  }
  const out: SecretHit[] = [];
  for (const f of [...forms].sort((a, b) => b.length - a.length)) {
    for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + f.length)) out.push({ id: "known-secret", start: i, end: i + f.length });
  }
  return out;
}

export type RedactOptions = { rules?: SecretRule[]; known?: readonly string[] };

/** Unbroken runs of base64/hex characters this long are image data or blobs, not secrets (the
 *  longest gitleaks secret is a few hundred characters). Scanning them costs seconds per MB, as
 *  short keywords such as `api` or `okta` turn up in random base64 by chance. */
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{4096,}/g;

/** Every secret span in `text`. */
export function findSecrets(text: string, opts: RedactOptions = {}): SecretHit[] {
  if (text.length >= 4096 && OPAQUE_RUN.test(text)) {
    OPAQUE_RUN.lastIndex = 0;
    // Scan the text between the runs only, keeping the original offsets; known values are still
    // found everywhere, since an exact match is cheap.
    const out: SecretHit[] = opts.known?.length ? findKnown(text, opts.known) : [];
    let at = 0;
    for (const m of [...text.matchAll(OPAQUE_RUN), { index: text.length, 0: '' } as unknown as RegExpExecArray]) {
      const piece = text.slice(at, m.index);
      if (piece) for (const h of findSecrets(piece, { ...opts, known: [] })) out.push({ ...h, start: h.start + at, end: h.end + at });
      at = m.index + m[0].length;
    }
    return out;
  }
  OPAQUE_RUN.lastIndex = 0;
  const rules = opts.rules ?? secretRules();
  const lower = text.toLowerCase();
  const out: SecretHit[] = opts.known?.length ? findKnown(text, opts.known) : [];
  for (const r of rules) {
    if (r.keywords.length && !r.keywords.some((k) => lower.includes(k))) continue;
    for (const m of text.matchAll(r.re)) {
      // What gitleaks calls the secret — the configured group, else the first
      // that matched — decides entropy and the secret allowlist. What is
      // MASKED is that group only when the rule names it; otherwise the whole
      // match, since the first group can be a harmless fragment (a webhook's
      // UUID, a JWT's fixed header) and the real secret would stay visible.
      // Spans come from the match's own indices (the `d` flag): looking a
      // value up in m[0] finds an EARLIER copy (`?secret=secret`, rechrome #55).
      const gi = r.group ?? m.findIndex((g, i) => i > 0 && !!g);
      const secret = gi > 0 ? m[gi] : m[0];
      if (!secret) continue;
      if (r.entropy && shannon(secret) < r.entropy) continue;
      if (r.allow.some((a) => a.test(secret))) continue;
      if (r.allowMatch?.some((a) => a.test(m[0]))) continue;
      if (r.allowLine) {
        const ls = text.lastIndexOf("\n", m.index) + 1;
        const le = text.indexOf("\n", m.index + m[0].length);
        if (r.allowLine.some((a) => a.test(text.slice(ls, le < 0 ? undefined : le)))) continue;
      }
      const sl = secret.toLowerCase();
      if (r.stop.some((s) => sl.includes(s))) continue;
      const span = r.group ? m.indices?.[r.group] : undefined;
      if (span) out.push({ id: r.id, start: span[0], end: span[1] });
      else {
        // gitleaks' patterns end (and some start) with a boundary — space,
        // quote, `;`, a literal \n — that is context, not secret: keep it.
        let a = m.index;
        let b = m.index + m[0].length;
        const edge = /[\s'"`;=:,]/;
        while (a < b && edge.test(text[a]!)) a++;
        for (;;) {
          if (b > a && edge.test(text[b - 1]!)) b--;
          else if (b - 2 >= a && /\\[nr]/.test(text.slice(b - 2, b))) b -= 2;
          else break;
        }
        out.push({ id: r.id, start: a, end: b });
      }
    }
  }
  return out;
}

/** `text` with every secret replaced by `[redacted:<rule id>]`. Overlapping
 *  hits merge into one span, named by the longest. */
export function redact(text: string, opts: RedactOptions = {}): { text: string; kinds: string[] } {
  const hits = findSecrets(text, opts).sort((a, b) => a.start - b.start || b.end - a.end);
  if (!hits.length) return { text, kinds: [] };
  const spans: SecretHit[] = [];
  for (const h of hits) {
    const last = spans[spans.length - 1];
    if (last && h.start < last.end) {
      if (h.end - h.start > last.end - last.start) last.id = h.id;
      last.end = Math.max(last.end, h.end);
    } else spans.push({ ...h });
  }
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + `[redacted:${s.id}]`;
    at = s.end;
  }
  return { text: out + text.slice(at), kinds: [...new Set(spans.map((s) => s.id))] };
}
