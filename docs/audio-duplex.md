# PCM duplex v1 contract

This is a same-machine streaming connection, not a remote/mobile gateway. A trusted
local operator uses the existing authenticated management connection to mint a ticket:

```
rech audio install https://example.com/voice
rech audio stream ticket --source li-synthetic --destination browser-live \
  --client-origin https://li.example --ticket-file /private/tmp/audio-ticket.json
```

Import the private ticket locally in the authorized client; do not upload it to a
website backend. No unauthenticated mint endpoint exists. The ticket lives 30 seconds
and is usable once, for one pinned session/page origin/generation. It grants audio
streaming only. The management key never travels to the frontend. CLI tickets use
clientOrigin `null` (absent Origin); browser tickets require exact HTTPS Origin.
Do not disable mixed-content, CSP, or private-network controls. Hosted pages must
permit loopback WS under their CSP/browser policy; unsupported browsers fail closed.
An isolated Chrome check of the hosted Li page was blocked by the default local-network
permission prompt; allowing local-network access through the standard browser permission
made the same synthetic duplex connection work. The operator must explicitly allow that
access in their own browser when prompted. No browser security flags or real profile
permissions are changed by this feature. If the 30-second ticket expires while importing
or authorizing local-network access, mint a fresh ticket.
Phones and remote clients require a separately authorized trusted WSS gateway;
localhost on a phone is not the host Mac. This implementation does not deploy one.

## Ticket and handshake

Ticket JSON (control authorization only, never audio):
`{version:1,url,capability,clientOrigin,expiresAt,sourceId,destinationId,input,output,frameMs:20,maxFrameBytes,inputWindowBytes}`.
`url` is `ws://127.0.0.1:<ephemeral-port>/stream`; capability is a random one-use value,
never a query parameter. `input` and `output` each are
`{sampleRate:16000|48000,channels:1|2,format:"s16le"}`. Both directions currently use
the same negotiated format. Frames are exactly 20ms: sampleRate/50 interleaved
little-endian signed PCM16 samples per channel. `maxFrameBytes` is the exact frame
size. Both windows are eight frames (160ms). No WAV, WebM, or frame header bytes.

Open WS from the ticket's exact configured Origin. Within two seconds send JSON:
`{type:"hello",version:1,capability,sourceId,destinationId,input,output,frameMs:20}`.
All fields must match the ticket. The capability is consumed atomically. The server
starts the renderer only after authentication, then sends:
`{type:"ready",version:1,sourceId,destinationId,input,output,frameMs:20,maxFrameBytes,inputWindowBytes,outputWindowBytes}`.
No input before ready. No automatic reconnect; obtain a fresh ticket explicitly.

## Input, output and backpressure

* Input: binary frames contain exactly `maxFrameBytes` PCM bytes. No preceding
  descriptor is required: sequence starts at zero and advances per binary frame;
  sample offset = sequence*sampleRate/50. Never exceed `inputWindowBytes` in flight.
* Server credit: `{type:"credit",bytes,inputSequence}` acknowledges one frame
  accepted by the bounded renderer queue and restores that many **bytes** of credit.
* Output: JSON `{type:"frame",sequence,sampleOffset,byteLength,sourceId,destinationId}`
  describes exactly the next binary frame. Sequence starts at zero. Output source
  is the browser target (`ticket.destinationId`), destination is the feeding source
  (`ticket.sourceId`). PCM bytes and format/route metadata are separate.
* After consuming an output frame, send JSON `{type:"output-ack",sequence}` in order.
  No audio/control interleaving may break the descriptor/binary pair. The output
  window is eight frames. A consumer stalled beyond two seconds is cancelled.
* Independent pumps allow output before input EOF. End input with
  `{type:"end-input"}` after the last complete frame. The server acknowledges
  `{type:"input-ended"}` after queued input is accepted, then supplies silence to
  the virtual mic; output stays active. Further input is rejected.
* `{type:"stop"}` or `{type:"cancel"}` immediately cancels both directions,
  independently of output acknowledgements/input credit. Terminal control is
  `{type:"closed",reason}` then WS close. Protocol, overflow, duration, navigation,
  generation mismatch, lost renderer and disconnect errors close the stream rather
  than grow memory or redirect audio. Reuse of a stopped generation requires an
  explicitly confirmed renderer stop. An error or cleanup deadline leaves it
  non-retired; confirm a later `audio stop` and an empty drain before reinstalling.
  If navigation destroyed that generation, use a fresh named isolated session rather
  than pretending the old stop was confirmed. Reasons contain no page/credential excerpts.

Renderer PCM output is capped at 64KiB; queued input is capped at 200ms plus the
160ms transport window. The gateway caps requests and WS payloads; its output and
input windows are separately bounded. Default duration is 60s; explicit durations
up to 300s are accepted. This is a bounded stream, not an unlimited recorder.

## FFmpeg and Li routing

```
ffmpeg -i fixture.wav -f s16le -ar 16000 -ac 1 pipe:1 | \
  rech audio stream --source ffmpeg --destination browser-live --rate 16000 --channels 1 \
  | ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 response.wav
```

stdin/stdout contain only PCM. Status/errors go to stderr. Input EOF sends end-input;
output remains until cancellation, the page ending, or the duration limit. SIGINT,
SIGTERM, output pipe failure and disconnect cancel both pumps. A final partial
20ms input frame is zero-padded; a partial sample is rejected.

Li mixing belongs to an explicit routing bus: retain source/target IDs, resample to
the negotiated PCM format and mix separately per destination. Exclude each destination's
own source (mix-minus). Do not route browser output back to its own virtual microphone.
Browser speechSynthesis is not a PCM source. Ticket-file import is authorization,
not file-fed audio. This contract does not claim default TTS or phone routing works.
