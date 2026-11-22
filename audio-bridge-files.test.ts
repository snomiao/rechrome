import { expect,test } from 'bun:test';
import { mkdtemp,readFile,writeFile,symlink,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveAudioDrain } from './audio-bridge-files.ts';

const id='b-'+'a'.repeat(32);
const batch=(text:string,seq=0,receipt=randomUUID())=>({id,phase:'capturing',bufferedBytes:0,droppedBytes:0,streamCount:1,queuedSeconds:0,unsupported:[],receipt,streams:[{id:'s-1',mimeType:'audio/webm',seq,chunks:[Buffer.from(text).toString('base64')],final:false}]});
test('writes private ordered fragments and retries the same receipt without duplication',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-output-'));const first=batch('first');
 const out=await saveAudioDrain(first,dir);expect((await stat(out.files[0]!.path)).mode&0o777).toBe(0o600);
 expect((await saveAudioDrain(first,dir)).retried).toBe(true);
 await saveAudioDrain(batch('second',1),dir);
 expect(await readFile(out.files[0]!.path,'utf8')).toBe('firstsecond');
 await expect(saveAudioDrain(batch('bad',9),dir)).rejects.toThrow('sequence mismatch');
 expect(await readFile(out.files[0]!.path,'utf8')).toBe('firstsecond');
});
test('recovers a partial uncommitted write by using the prior durable offset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-recovery-'));const first=await saveAudioDrain(batch('first'),dir);
 await writeFile(first.files[0]!.path,'firstsec');
 await saveAudioDrain(batch('second',1),dir);
 expect(await readFile(first.files[0]!.path,'utf8')).toBe('firstsecond');
});
test('does not follow a stream symlink or accept changed receipt contents',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-symlink-'));const first=batch('first');const out=await saveAudioDrain(first,dir);
 const target=join(dir,'elsewhere');await writeFile(target,'keep');await symlink(target,join(out.directory,'s-2.webm'));
 await expect(saveAudioDrain({...batch('second'),streams:[{id:'s-2',mimeType:'audio/webm',seq:0,chunks:[Buffer.from('second').toString('base64')],final:false}]},dir)).rejects.toThrow();
 expect(await readFile(target,'utf8')).toBe('keep');
 await expect(saveAudioDrain(batch('changed',0,first.receipt),dir)).rejects.toThrow('receipt changed');
});
