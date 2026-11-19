/** Decode captured files only; never opens an audio output device. */
import { readdir, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
export function analyzePcm(pcm: Float32Array, rate = 16000) {
  if (rate !== 16000 || pcm.length > rate * 65) throw Error("pcm-bounds");
  const hop = 320;
  let first: number | null = null,
    last: number | null = null,
    peak = 0,
    active = 0;
  for (let i = 0; i < pcm.length; i += hop) {
    let sum = 0;
    const count = Math.min(hop, pcm.length - i);
    for (let j = 0; j < count; j++) {
      const x = pcm[i + j]!;
      if (!Number.isFinite(x)) throw Error("pcm-finite");
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
    if (Math.sqrt(sum / count) > 0.01) {
      first ??= i / rate;
      last = (i + count) / rate;
      active += count / rate;
    }
  }
  return {
    durationSeconds: pcm.length / rate,
    firstActiveSeconds: first,
    lastActiveSeconds: last,
    activeSeconds: active,
    peak,
    thresholdRms: 0.01,
    resolutionMs: 20,
  };
}
async function main() {
  const folder = process.argv[2];
  if (!folder) throw Error("arguments");
  const streams = [];
  for (const name of (await readdir(folder))
    .filter((v) => /^s-[1-9][0-9]*\.webm$/.test(v))
    .sort()) {
    const stat = await lstat(join(folder, name));
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error("input-bounds");
    const p = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        join(folder, name),
        "-t",
        "65",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [raw, , exit] = await Promise.all([
      new Response(p.stdout).arrayBuffer(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (exit || raw.byteLength > 16000 * 65 * 4 || raw.byteLength % 4) throw Error("decode");
    streams.push({ name, bytes: stat.size, ...analyzePcm(new Float32Array(raw)) });
  }
  const result = { streams, naturalLanguageValidated: false, playback: false };
  await writeFile(join(folder, "signal-analysis.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
}
if (import.meta.main)
  await main().catch(() => {
    console.error("Captured signal analysis failed.");
    process.exitCode = 1;
  });
