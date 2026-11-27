# Interactive local audio pairing v2

Discovery: `http://127.0.0.1:13775/audio/pair/discovery` (the default management port).
Only the loopback management listener serves pairing. No public/shared listener does.
All Li requests use `credentials: omit` and JSON, with normal browser local-network
permission and CSP policy. CORS echoes only valid exact HTTPS or loopback Origins,
never `*` or credentials. `Origin` is authoritative, never a request-body origin.

GET discovery: `{version:2,requestUrl}`. POST requestUrl (fixed `/audio/pair/request`):
`{sourceId,destinationId?:null|"select-chat",input,output,frameMs:20}`. PCM is v1
PCM16 mono/stereo, 16/48kHz; input and output must match. Response:
`{requestId,requestNonce,expiresAt,approvalUrl,statusUrl,cancelUrl}`.
requestId is a public UUID (36 chars); requestNonce is a private random32-byte
base64url value (43 chars). No nonce/capability in URL queries. Pending requests
expire after120s, bounded globally/per Origin. Creating one never grants audio,
starts capture or exposes tabs. destinationId may be omitted/null/select-chat;
local approval chooses the real target and binds ticket.destinationId to a
`chat-<opaquehash>` route id, not the user-typed logical placeholder.

POST `/audio/pair/status` and `/audio/pair/cancel`:
`{requestId,requestNonce}`; exact originating Origin must match. Status returns
`{state:"pending"|"approved"|"denied"|"expired"|"cancelled",ticket?,approvedChat?:{title,origin}}`.
An approved response contains the v1 one-use30s StreamTicket; WS protocol unchanged.
Cancel wins races with approval: it revokes an unused capability or closes an active
gateway, including when minting completed after cancel. It is not client-side discard.

`approvalUrl` points at `/audio/pair/approve?requestId=<public-id>`. It serves public
static HTML only. No unauthenticated tab list or approval/mint operation exists.
Private targets/pending metadata and the approve/deny POST require an authenticated
HttpOnly, SameSite=Strict operator cookie, exact local Origin and JSON. The panel
sets frame-ancestors none and COOP same-origin. User selects an actual locally
installed chat title and clicks Approve/Reject; no opaque IDs or codes to type.

One-time trusted `rech audio approvals` opens/initializes the companion panel through
the existing management connection and local browser socket. Bootstrap grants are
one-use60s and travel in a body/socket, never argv/query/Li frontend. Operator cookie
expires after10min of inactivity; private panel polling renews it. The initial approval-page GET must remain public: a cross-site
top-level navigation from Li may omit a Strict cookie, but subsequent same-origin
panel fetches can carry it. If absent, the page shows a plain not-ready message and Retry; terminal setup
guidance appears only in Advanced diagnostics, never beside an unauthenticated tab list. The local companion must be initialized in an operator browser
profile; Li in another profile can remain pending until that companion approves.

Once registered by management, pending requests can wake/reuse the same companion
panel at most once every5s with one wake in flight. They cannot authorize audio.
Public JSON bodies are capped at4096bytes and2s. Setup remains a trusted local
operator operation; installing core v1 alone does not initialize or ship this v2 flow.

No files, JSON import or six-digit CLI-code UX in the ordinary Connect path.
No model calls, microphone activation, account changes or Chrome restart occurs.
Remote/mobile is unsupported without a separately authorized trusted gateway.
