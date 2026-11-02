// Secret redaction (ported from snomiao/slack-term PR #68) for page text rech prints:
// stdout/stderr of every command; each secret becomes `[redacted:<rule id>]`.
// RECH_REDACT=0 turns it off for one call.
//
// Rules: gitleaks' default set (secret-rules/gitleaks.toml, v8.30.1, MIT — see
// secret-rules/gitleaks.LICENSE), run in-process by the JS regex engine, plus
// our own for what it does not cover (OWN_RULES). Measured 2026-11-02 on
// 1,000 synthetic messages (slack-term tests/redact.test.ts):
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
  allow: RegExp[];
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
    out += c;
  }
  out += ")".repeat(extra);
  return { source: out, flags: [...new Set(flags)].join("") };
}

type TomlAllow = { regexTarget?: string; regexes?: string[]; stopwords?: string[] };
type TomlRule = { id: string; regex?: string; keywords?: string[]; entropy?: number; secretGroup?: number; allowlists?: TomlAllow[]; allowlist?: TomlAllow };

/** gitleaks' rules TOML → rules. Path-only rules (no regex) are skipped;
 *  allowlists that target the whole line are skipped (we see no lines). */
export function loadGitleaksRules(toml: string): SecretRule[] {
  const c = Bun.TOML.parse(toml) as { rules: TomlRule[]; allowlist?: TomlAllow };
  const compile = (r: string): RegExp => { const j = goToJs(r); return new RegExp(j.source, j.flags); };
  const gAllow = (c.allowlist?.regexes ?? []).map(compile);
  const gStop = (c.allowlist?.stopwords ?? []).map((s) => s.toLowerCase());
  const rules: SecretRule[] = [];
  for (const r of c.rules) {
    if (!r.regex) continue;
    const allow = [...gAllow];
    const stop = [...gStop];
    for (const a of [...(r.allowlists ?? []), ...(r.allowlist ? [r.allowlist] : [])]) {
      if (a.regexTarget && a.regexTarget !== "secret" && a.regexTarget !== "match") continue;
      for (const x of a.regexes ?? []) allow.push(compile(x));
      for (const s of a.stopwords ?? []) stop.push(String(s).toLowerCase());
    }
    const j = goToJs(r.regex);
    rules.push({
      id: r.id, re: new RegExp(j.source, j.flags + "g"), keywords: (r.keywords ?? []).map((k) => k.toLowerCase()),
      ...(r.entropy ? { entropy: r.entropy } : {}), ...(r.secretGroup ? { group: r.secretGroup } : {}), allow, stop,
    });
  }
  return rules;
}

/** Ours, for what gitleaks' set leaves out. */
export const OWN_RULES: SecretRule[] = [
  // ?token=… / &sig=… in a URL; `<your token>` and xxx-style placeholders are not secrets.
  { id: "url-secret-param", re: /[?&](?:access_token|token|key|api_key|apikey|secret|client_secret|password|passwd|pwd|sig|signature)=([^&\s#<>"'|]{6,})/gi, keywords: ["="], allow: [/^(?:x+|\*+|\.\.\.|your[-_]?\w*|xxx\w*)$/i], stop: [] },
  // OpenAI / Anthropic / OpenRouter style keys, whatever their exact layout.
  { id: "sk-key", re: /\b(sk-(?:proj-|ant-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,})/g, keywords: ["sk-"], entropy: 3.5, allow: [], stop: [] },
  // A 6-digit code only right after a word that says it is one: a bare
  // 6-digit number is far more often an amount, an order or a build.
  { id: "otp-code", re: /(?:code|コード|otp|pin|passcode|認証|確認番号|ワンタイム)[^\d\n]{0,20}(?<![\d.])(\d{6})(?![\d.])/gi, keywords: [], allow: [], stop: [] },
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

/** Every secret span in `text`. */
export function findSecrets(text: string, rules = secretRules()): SecretHit[] {
  const lower = text.toLowerCase();
  const out: SecretHit[] = [];
  for (const r of rules) {
    if (r.keywords.length && !r.keywords.some((k) => lower.includes(k))) continue;
    for (const m of text.matchAll(r.re)) {
      const secret = (r.group ? m[r.group] : m.slice(1).find((g) => g)) ?? m[0];
      if (!secret) continue;
      if (r.entropy && shannon(secret) < r.entropy) continue;
      if (r.allow.some((a) => a.test(secret))) continue;
      const sl = secret.toLowerCase();
      if (r.stop.some((s) => sl.includes(s))) continue;
      const start = m.index + m[0].indexOf(secret);
      out.push({ id: r.id, start, end: start + secret.length });
    }
  }
  return out;
}

/** `text` with every secret replaced by `[redacted:<rule id>]`. Overlapping
 *  hits merge into one span, named by the longest. */
export function redact(text: string, rules = secretRules()): { text: string; kinds: string[] } {
  const hits = findSecrets(text, rules).sort((a, b) => a.start - b.start || b.end - a.end);
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
