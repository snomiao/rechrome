// The invite page (rechrome.pages.dev/share/#rech1_invite_…): what this link gives, before anyone reaches the
// CLI. It connects like `rech connect` does (same room, same sealed channel), asks for /ping and
// shows the answer; it never redeems the invite. Bundled to public/invite.js, which is committed
// since Pages has no build step: `bun run build-invite-page`.
import { transcriptHash, randomHex } from "./e2e.ts";
import { SealedChannel, SignalSocket, signalSocketUrl } from "./rtc-channel.ts";
import { base58, parseToken } from "./token.ts";

export type PingInfo = {
  share?: string; kind?: "invite" | "device"; expiresAt?: number; profiles?: string[] | "*";
  device?: { id: string; name: string; approved: boolean };
  invite?: { state: "open" | "used" | "expired"; maxDevices: number; used: number; expiresAt?: number };
  profileInfo?: { key: string; name: string; registered: boolean }[];
  sessions?: { name: string; device: string }[];
  degraded?: boolean; chromeAccessProblem?: string;
};
export type InviteResult =
  | { state: "online"; info: PingInfo }
  | { state: "offline" }                  // nobody holds this link's room
  | { state: "no-path" }                  // a host is there, but no connection from this browser
  | { state: "unknown" }                  // the signal server didn't tell us
  | { state: "failed"; reason: string };  // unverified or refused: nothing from it is shown

const NO_PROOF = "The host couldn't prove it holds this link's secret, so nothing it sent is shown.";

async function hkdf(token: string, label: string, bytes: number): Promise<Uint8Array> {
  const parsed = parseToken(token);
  if (!parsed.ok) throw new Error("not a complete rech1_ link");
  const key = await crypto.subtle.importKey("raw", parsed.secret as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`rech/${label}`) }, key, bytes * 8));
}

/** secret.ts's roomOf and roomAuthOf, on WebCrypto. */
export async function deriveRoom(token: string): Promise<{ room: string; auth: string }> {
  const auth = Array.from(await hkdf(token, "auth", 32), b => b.toString(16).padStart(2, "0")).join("");
  return { room: base58(await hkdf(token, "room", 12), 17), auth };
}

export async function fetchInviteInfo(token: string, opts: { signal: string; RTCPeerConnection?: any; timeoutMs?: number; onHost?: () => void }): Promise<InviteResult> {
  let derived: { room: string; auth: string };
  try { derived = await deriveRoom(token); }
  catch (error) { return { state: "failed", reason: error instanceof Error ? error.message : String(error) }; }
  const RTC = opts.RTCPeerConnection ?? (globalThis as any).RTCPeerConnection;
  let sock: SignalSocket | undefined, pc: any, channel: SealedChannel | undefined;
  let hostSeen = false, confirmed = false;
  return new Promise<InviteResult>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: InviteResult) => {
      clearTimeout(timer);
      resolve(result);
      sock?.close(); channel?.close();
      try { pc?.close(); } catch {}
    };
    const gaveUp = () => done(confirmed ? { state: "failed", reason: "The connection to the host was lost." } : hostSeen ? { state: "no-path" } : { state: "unknown" });
    timer = setTimeout(gaveUp, opts.timeoutMs ?? 20_000);

    const ask = () => {
      const id = randomHex(8);
      const chunks: Uint8Array[] = [];
      let status = 0;
      channel!.onFrame = f => {
        if (f?.id !== id) return;
        if (f.t === "res") status = f.status;
        else if (f.t === "data" && typeof f.b64 === "string") chunks.push(Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)));
        else if (f.t === "end") {
          let body: any = null;
          try { body = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c => [...c])))); } catch {}
          if (f.error || status !== 200 || !body) done({ state: "failed", reason: body?.error ?? f.error ?? `The host answered ${status}.` });
          else done({ state: "online", info: body });
        }
      };
      void channel!.sendFrame({ t: "req", id, method: "GET", path: "/ping" });
    };

    const onOffer = (m: any) => {
      if (!RTC) return gaveUp();
      pc = new RTC({ iceServers: Array.isArray(m.ice) ? m.ice : [] });
      pc.onicecandidate = (e: any) => { if (e.candidate?.candidate) sock!.send({ type: "candidate", candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid } }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") gaveUp(); };
      const th = (async () => {
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        sock!.send({ type: "answer", sdp: pc.localDescription.sdp });
        return transcriptHash(m.sdp, pc.localDescription.sdp);
      })();
      th.catch(() => done({ state: "failed", reason: NO_PROOF }));
      pc.ondatachannel = (e: any) => {
        channel = new SealedChannel(e.channel, "client");
        channel.onClose = () => { if (confirmed) gaveUp(); };
        const ready = async () => {
          try {
            await channel!.setKeys(token, await th);
            if (!(await channel!.confirm())) return done({ state: "failed", reason: NO_PROOF });
          } catch { return done({ state: "failed", reason: NO_PROOF }); }
          confirmed = true;
          ask();
        };
        if (e.channel.readyState === "open") void ready(); else e.channel.onopen = ready;
      };
    };

    sock = new SignalSocket(signalSocketUrl(opts.signal, derived.room), { role: "client", auth: derived.auth }, m => {
      if (m.type === "welcome") {
        if (m.hostPresent === false) return done({ state: "offline" });
        hostSeen = true;
        opts.onHost?.();
      } else if (m.type === "host-leave") { if (!confirmed) done({ state: "offline" }); }
      else if (m.type === "offer" && typeof m.sdp === "string" && !pc) onOffer(m);
      else if (m.type === "candidate" && m.candidate && pc) pc.addIceCandidate(m.candidate).catch(() => {});
    }, code => {
      if (code === 4404) done({ state: "offline" });
      else if (code === 1008) done({ state: "failed", reason: "The signal server refused this link." });
      else if (!confirmed) gaveUp();
    });
    sock.open().catch(() => done({ state: "unknown" }));
  });
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** What to show for a result, line by line. Host data, so it only ever becomes text. */
export function inviteLines(r: InviteResult): { text: string; list?: boolean }[] {
  if (r.state === "offline") return [{ text: "○ Host offline: nobody is answering this link. Its rech daemon may be down, or the link expired or was revoked. Ask the host to check." }];
  if (r.state === "no-path") return [{ text: "● Host online, but no direct path from this browser, so no details here. The connect command may still work from your machine." }];
  if (r.state === "unknown") return [{ text: "Couldn't check the host. You can still try the command." }];
  if (r.state === "failed") return [{ text: `Couldn't read this link's details: ${r.reason}` }];
  const { info } = r;
  const out: { text: string; list?: boolean }[] = [{ text: "● Host online" }];
  out.push({ text: `Share: ${info.share ?? "?"}, ${info.expiresAt ? `until ${when(info.expiresAt)}` : "no end date"}` });
  if (info.invite) {
    const { state, used, maxDevices, expiresAt } = info.invite;
    if (state === "open") out.push({ text: `Invite: open, ${used} of ${maxDevices} device${maxDevices === 1 ? "" : "s"} joined${expiresAt ? `, expires ${when(expiresAt)}` : ""}` });
    if (state === "used") out.push({ text: "Invite: already used, so the command won't work. Ask the host for a fresh one; if you didn't use it, tell them, since someone else did." });
    if (state === "expired") out.push({ text: "Invite: expired unused, so the command won't work. Ask the host for a fresh one." });
  }
  if (info.device) out.push({ text: `This is the link of device ${info.device.name}${info.device.approved ? "" : ", still waiting for the host's approval"}.` });
  if (info.profileInfo) {
    out.push({ text: "Profiles:" });
    for (const p of info.profileInfo) out.push({ text: `${p.name ? `${p.name} (${p.key})` : p.key}${p.registered ? "" : ": not set up on the host"}`, list: true });
  } else {
    if (Array.isArray(info.profiles)) out.push({ text: `Profiles: ${info.profiles.join(", ")}` });
    out.push({ text: "This host's rech daemon is an older version; updating it shows more here." });
  }
  if (info.sessions) {
    if (info.sessions.length) {
      out.push({ text: "Open sessions:" });
      for (const s of info.sessions) out.push({ text: `${s.name} (device ${s.device})`, list: true });
    } else out.push({ text: "No open sessions." });
  }
  if (info.chromeAccessProblem) out.push({ text: `Host problem: ${info.chromeAccessProblem}` });
  if (info.degraded) out.push({ text: "Recent browser commands on this host timed out." });
  return out;
}

export function renderInvite(el: any, r: InviteResult, doc: any): void {
  el.textContent = "";
  for (const line of inviteLines(r)) {
    const row = doc.createElement("div");
    row.textContent = line.list ? `  • ${line.text}` : line.text;
    el.append(row);
  }
}

if (typeof document !== "undefined") {
  const match = /^#(rech1_(?:(?:invite|reusable)_)?[1-9A-HJ-NP-Za-km-z]{28})$/.exec(location.hash);
  const el = document.getElementById("host-status");
  if (match && el) {
    void fetchInviteInfo(match[1]!, { signal: `${location.origin}/`, onHost: () => { el.textContent = "● Host online, getting details…"; } })
      .then(result => renderInvite(el, result, document));
  }
}
