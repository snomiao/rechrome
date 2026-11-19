# Muted live voice experiment

This operator harness exercises the bounded audio bridge with generated speech.
It does not use a physical microphone or play captured audio. It never selects an
API key, signs in, changes billing, or changes a browser profile. Use only newly
created, named isolated sessions; never point it at an existing personal session.

## Setup

Use a trusted local management connection and the same worktree/profile throughout.
Open **two owned blank tabs first**, with stable isolate names:

```sh
rech --isolate=voice-aistudio open about:blank
rech --isolate=voice-chatgpt open about:blank
```

Copy each explicit session ID from its open result into the corresponding environment
variable. Both must contain `-iso_`; default sessions are refused. The IDs must differ.

```sh
export RECH_VOICE_AISTUDIO_SESSION='<owned-aistudio-isolated-session>'
export RECH_VOICE_CHATGPT_SESSION='<owned-chatgpt-isolated-session>'
# Optional: private result directory; otherwise .rechrome/live-voice-results.
export RECH_VOICE_OUT='/private/tmp/live-voice-results'
bun scripts/live-voice-compare.ts mute aistudio
bun scripts/live-voice-compare.ts mute chatgpt
```

The mute command requires an owned blank selected tab. It uses the installed
extension's `chrome.tabs.getCurrent/update/get` APIs to mute that exact tab, returns
it to blank, and creates a separate owned, muted extension controller tab. The
controller remutes the target if its muted flag changes. A per-tab initialization
marker fences later page selection even when duplicate same-origin tabs exist.
It does not inspect
credentials or modify other tabs. Keep the controller open. If the app opens another
tab, verify ownership and mute it before using it; a target mute is not a profile-wide
mute. `mute-group` explicitly mutes the target's current isolated group after checking
that the known target has a group, and does not install a profile-wide policy.

Install before starting any voice interaction:

```sh
rech --isolate=voice-aistudio audio install 'https://aistudio.google.com/live?model=gemini-3.8-live' --max-seconds 50
rech --isolate=voice-chatgpt audio install https://chatgpt.com/ --max-seconds 50
bun scripts/live-voice-compare.ts inspect aistudio
bun scripts/live-voice-compare.ts inspect chatgpt
```

`inspect` verifies the original browser tab is still muted. It saves safe controls,
bridge status, and the owned AI Studio conversation turns. A signed-out ChatGPT page
requires the human to sign in in **that owned tab**. No credential automation is
provided. The current `probe` adapter is for AI Studio; ChatGPT inspection is a
readiness check, not a completed ChatGPT Voice measurement.

## Silent spoken fixtures

On macOS, the generator uses `AVSpeechSynthesizer.write` into a file, never `speak`.
Use existing installed voices. The English, Chinese, and Japanese prompts request
a short arithmetic answer followed by a greeting in another language.

```sh
swift scripts/live-voice-fixture.swift en-US /private/tmp/voice-en.caf
swift scripts/live-voice-fixture.swift zh-CN /private/tmp/voice-zh.caf
swift scripts/live-voice-fixture.swift ja-JP /private/tmp/voice-ja.caf
swift scripts/live-voice-fixture.swift interrupt /private/tmp/voice-interrupt.caf
ffmpeg -nostdin -i /private/tmp/voice-en.caf -ar 16000 -ac 1 -c:a pcm_s16le /private/tmp/voice-en.wav
# Convert the other CAF files in the same way. No output audio device is opened.
```

Feed only synthetic fixtures. Input must pass the bridge's strict PCM validation:
at most 2 MiB and 30 seconds. Probe calls verify the browser mute, origin, and bridge
generation before starting. The general model starts through the audio-only
`Microphone` button; the translation model uses `Talk`. Webcam/screen controls are
never clicked. Capture and the UI call stop after a bounded wait.

```sh
bun scripts/live-voice-compare.ts probe aistudio /private/tmp/voice-en.wav
rech --isolate=voice-aistudio audio stop --dir /private/tmp/live-voice-capture
bun scripts/live-voice-analyze.ts /private/tmp/live-voice-capture/<bridge-id>
```

Stop and drain before installing another generation. For an interruption test, pass
the interrupt WAV as the final argument. It is injected 500 ms after the third output
recorder starts, provided the virtual input queue is empty. That recorder order is an
observed AI Studio implementation detail, not a universal barge-in detector. Confirm
the injected input overlapped non-silent captured output before interpreting results.

The analyzer decodes local capture files with FFmpeg, capped at 65 seconds. It reports
20 ms RMS activity windows without playback. A non-silent sound alone is not evidence
of a spoken answer. Use the owned page's transcript as separate semantic evidence.
The main-thread WebSocket counters do not observe worker/WebRTC transports.

## Observed limits

In one existing-account experiment, the general Gemini 3.8 Live model accepted the
English fixture and displayed `2 + 3 is 5. Konnichiwa.` The captured response began
approximately 1.32 seconds after the fixture ended. A spoken interruption produced
`Blue.`; the preceding output stream ended approximately 0.57 seconds after the
interruption feed. These are single-run capture-timeline estimates, not network TTFB
measurements or a comparative ranking.

The Live Translate model transcribed Chinese and produced a matching English
translation. With English selected as its target and target-language echo disabled,
English-only input produced no translated reply. Combined English/Chinese/Japanese
input was transcribed, but the translated output repeated some final wording.
The general conversation model handled the English request and a final Japanese
request for a Chinese greeting, but its displayed turns omitted the Chinese segment
and started the Japanese segment mid-sentence. This does not establish reliable
complete transcription of that combined fixture.

ChatGPT was signed out in its owned isolated tab, so ChatGPT latency, interruption,
and mixed-language results remain **unmeasured**. Spoken naturalness is also unmeasured:
the experiment did not play any captured audio. The bridge reports `existing-graph`
and `html-autoplay`; browser-level mute is required independently of its capture hooks.

Run local tests with `bun test scripts/live-voice-compare.test.ts`. These tests do not
open a browser, contact a service, record a microphone, or play audio.
