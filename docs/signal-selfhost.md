# Run your own signal server

WebRTC shares need a rendezvous where the host and a client swap connection details before they
talk directly. By default that is `https://rechrome.pages.dev/`. Any server speaking
[`rech-signal-1`](#protocol-rech-signal-1) works instead; this page shows five ways to run one.

## What you are trusting (less than you'd think)

A signal server only relays the handshake. It never sees a share's secret: it gets a room id and
an admission token, both one-way HKDF outputs of the secret. The encryption keys are derived from
the secret *and* the DTLS fingerprints both sides exchanged, so a server that swaps in its own
fingerprints ends up with keys that don't match, and the connection fails closed.

| A hostile signal server can | It cannot |
|---|---|
| refuse or drop connections | read or change browser traffic |
| see which IPs meet in which room, and when | learn the secret, or join a share |

Self-hosting is about **availability**, **metadata** and **policy** (a network that only allows its
own hosts), not about who can read your browser.

## Choose a way

| Way | Cost | Needs | Good for |
|---|---|---|---|
| [A. Cloudflare Workers](#a-cloudflare-workers) | free tier | a Cloudflare account | always up, nothing to run |
| [B. A server + Caddy](#b-a-server--caddy) | a small VPS | public IP, a domain | full control |
| [C. Tailscale Funnel](#c-a-home-machine--tailscale-funnel) | free | Tailscale, a machine that stays on | no open ports, no domain |
| [D. Docker](#d-docker) | varies | a container host + TLS | Fly, Render, k8s… |
| [E. Quick tunnel](#e-quick-tunnel-testing-only) | free | `cloudflared` | trying it out |

Clients on other networks need **HTTPS/WSS**, and the server must allow WebSocket upgrades.

## A. Cloudflare Workers

The same design as the default server: one SQLite-backed Durable Object per room, with WebSocket
hibernation so an idle host costs nothing. It fits the Workers Free plan (100k requests/day;
incoming WebSocket messages count 20:1; idle hibernated objects aren't billed).

```bash
git clone https://github.com/snomiao/rechrome && cd rechrome/signal/cloudflare
npx wrangler login
npx wrangler deploy        # → https://rech-signal.<your-subdomain>.workers.dev
```

For a custom domain whose zone is on the same account, uncomment the `routes` line in
`wrangler.jsonc`. (`wrangler dev` needs Node.js, not Bun.)

## B. A server + Caddy

The relay is built into rech:

```bash
bunx rechrome signal serve --host 127.0.0.1 --port 8787
```

Put TLS in front; Caddy gets certificates automatically:

```caddy
signal.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Keep it running with systemd:

```ini
# /etc/systemd/system/rech-signal.service
[Unit]
Description=rech signal relay
After=network-online.target

[Service]
ExecStart=/home/rech/.bun/bin/bunx rechrome signal serve --host 127.0.0.1 --port 8787
User=rech
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

## C. A home machine + Tailscale Funnel

Funnel gives a machine on your tailnet a public `https://<machine>.<tailnet>.ts.net` URL without
opening a port or owning a domain:

```bash
bunx rechrome signal serve --port 8787
tailscale funnel --bg 8787     # Funnel must be allowed in your tailnet policy
```

If every client is on your tailnet anyway, skip WebRTC: `rech share new <profile> --via tailscale`.

## D. Docker

```dockerfile
FROM oven/bun:1-alpine
RUN bun add -g rechrome
USER bun
EXPOSE 8787
CMD ["bunx", "rechrome", "signal", "serve", "--host", "0.0.0.0", "--port", "8787"]
```

Run **one instance** (rooms live in memory, so a host and its client must reach the same
process), behind your platform's HTTPS.

## E. Quick tunnel (testing only)

```bash
bunx rechrome signal serve --port 8787 &
cloudflared tunnel --url http://127.0.0.1:8787   # → https://random-words.trycloudflare.com
```

The hostname changes on every run, and every link made with it dies with it.

## Point rech at it

Only the **host** chooses; the signal origin becomes the link, so clients need no setup:

```bash
rech share new you@example.com --signal https://signal.example.com/
# → https://signal.example.com/#rech1_…

export RECH_SIGNAL=https://signal.example.com/    # default for new shares on this machine
```

Check it: `curl https://signal.example.com/ping` answers `{"rech-signal":1}`, which is also how
`rech connect` tells a signal server from a rech daemon.

## Protocol: rech-signal-1

All a compatible server has to do (reference: [`signal-relay.ts`](../signal-relay.ts),
[`signal/cloudflare/worker.ts`](../signal/cloudflare/worker.ts)):

| Request | Response |
|---|---|
| `GET /ping` | `{"rech-signal":1}` |
| `GET /<room>` + `Upgrade: websocket`, subprotocol `rech-signal-1` | 101, echoing the subprotocol. `<room>` is 8–32 base58 characters |
| anything else | optional landing page (the `#fragment` never reaches the server) |

JSON text frames:

| Direction | Frame | The server |
|---|---|---|
| peer → server, first | `{type:"hello", role:"host"\|"client", auth}` | The first host opens the room and fixes `auth`; later peers must match it. A client with no host gets close **4404**. |
| server → peer | `{type:"welcome", peer, hostPresent}` | the host's id is `"host"`, clients get a random id |
| server → host | `{type:"peer-join"\|"peer-leave", peer}` | on client join and leave |
| server → clients | `{type:"host-leave"}` | when the host disconnects |
| client → host | `{type:"answer"\|"candidate", …}` | forwards to the host, adding `from:<peer>` |
| host → client | `{type:"offer"\|"candidate", …, to:<peer>}` | forwards to that client unchanged |
| any | `{"type":"ping"}` (exact bytes) | answers `{"type":"pong"}` (on Cloudflare via `setWebSocketAutoResponse`, so pings don't wake the object) |

Close codes: **1008** `expected hello` / `forbidden` (never echo the auth) · **1013** `room full`
(32 clients) · **4404** `host offline` · **1000** `replaced by a newer host connection`.

Room state lives only while someone is connected; a restarted relay loses nothing that matters.
Forward SDP and candidates unchanged, and never log them (they contain candidate IPs).

## Hardening checklist

- TLS for anything off-LAN.
- Don't log frames; access logs are fine.
- Limits: 32 clients per room, 64 KB per message, a 120 s idle timeout (hosts ping every 25 s).
- Per-IP rate limits on upgrades for a public relay (Caddy `rate_limit`, Cloudflare WAF rules).
- One process for the in-memory relay (or sticky routing); the Cloudflare version doesn't care.
- No TURN on the signal server. Hosts that need TURN mint short-lived credentials from their own
  Cloudflare TURN key (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` in the daemon's environment).
- Run unprivileged (the systemd unit and Dockerfile above do).
