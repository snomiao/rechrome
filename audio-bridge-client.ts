import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { parseAudioArgs, audioWireArgs, validateAudioUpload, AUDIO_UNSUPPORTED_CODES, AUDIO_MAX_WAV_BYTES } from './audio-bridge.ts';
import { saveAudioDrain } from './audio-bridge-files.ts';

type Serve = (args: string[], upload?: any) => Promise<{ status: number; stdout: string; stderr: string; audioOut?: unknown }>;
const MAX_WAV = AUDIO_MAX_WAV_BYTES;
const ID = /^b-[a-f0-9]{32}$/;
const PHASES = new Set(['ready', 'capturing', 'stopped', 'failed']);

async function readWav(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsupported input');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_WAV) throw new Error('unsupported input');
    const buffer = Buffer.alloc(MAX_WAV + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_WAV) throw new Error('input grew past limit');
    const upload = { name: 'input.wav', contentType: 'audio/wav', data: buffer.subarray(0, count).toString('base64') };
    buffer.fill(0);
    validateAudioUpload(upload);
    return upload;
  } finally { await file.close(); }
}

function safeStatus(stdout: string) {
  const value = JSON.parse(stdout);
  if (!value || !ID.test(value.id) || !PHASES.has(value.phase)) throw new Error('invalid reply');
  const result: Record<string, unknown> = { id: value.id, phase: value.phase };
  for (const key of ['bufferedBytes', 'droppedBytes', 'streamCount', 'queuedSeconds']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) throw new Error('invalid reply');
      result[key] = value[key];
    }
  }
  if (value.pending === true) result.pending = true;
  if (value.unsupported !== undefined) {
    if (!Array.isArray(value.unsupported) || value.unsupported.some((code: unknown)=>typeof code!=='string'||!AUDIO_UNSUPPORTED_CODES.includes(code as any))) throw new Error('invalid reply');
    result.unsupported=value.unsupported;
  }
  return result;
}

/** Does not print any daemon/browser output, including errors or echoed code. */
export async function runAudioCommand(args: string[], serve: Serve, defaultDirectory: string) {
  const session = args.filter(a => /^-s=/.test(a));
  if (session.some(a => /^-s=iso-/.test(a))) throw new Error('audio: use a stable --isolate=<name>, not a new session for each command');
  const command = parseAudioArgs(args.filter(a => !/^-s=/.test(a)));
  const upload = command.action === 'feed' ? await readWav(command.file) : undefined;
  let response = await serve([...session, ...audioWireArgs(command)], upload);
  let collected: Awaited<ReturnType<typeof saveAudioDrain>> | undefined;
  const directory = ('dir' in command ? command.dir : undefined) || defaultDirectory;
  for (let n = 0; n < 5; n++) {
    if (response.status !== 0) throw new Error('audio: command failed; verify the selected page and updated local daemon');
    const status = safeStatus(response.stdout);
    if (!response.audioOut) return { action: command.action, ...status, ...(collected ? { directory: collected.directory, files: collected.files } : {}) };
    if (command.action !== 'drain' && command.action !== 'stop') throw new Error('audio: unexpected output');
    collected = await saveAudioDrain(response.audioOut, directory);
    const acknowledged = await serve([...session, 'audio', 'ack', collected.receipt]);
    if (acknowledged.status !== 0) throw new Error('audio: output saved; retry drain to acknowledge it');
    if (command.action === 'drain') return { action: command.action, ...status, pending: false, directory: collected.directory, files: collected.files };
    // stop may first return an older unacknowledged batch, followed by final
    // recorder fragments. Collect all of them before reporting completion.
    response = await serve([...session, 'audio', 'drain']);
  }
  throw new Error('audio: remaining output is pending; run drain with the same directory');
}
