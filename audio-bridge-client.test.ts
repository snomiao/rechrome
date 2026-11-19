import { test,expect } from 'bun:test';
import { mkdtemp,writeFile,readFile,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runAudioCommand } from './audio-bridge-client.ts';

const id='b-'+'a'.repeat(32);
const status=(phase='ready')=>({id,phase,bufferedBytes:0,droppedBytes:0,streamCount:1,queuedSeconds:0,unsupported:[]});
const reply=(value:any,audioOut?:any)=>({status:0,stdout:JSON.stringify(value),stderr:'',...(audioOut?{audioOut}:{})});
function wav(){const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);return b;}

test('input bytes travel only in the upload body and retain the explicit session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-feed-'));const path=join(dir,'fixture.wav');await writeFile(path,wav());let calls:any[]=[];
 const output=await runAudioCommand(['-s=iso_media','audio','feed',path],async(args,upload)=>{calls.push({args,upload});return reply(status());},dir);
 expect(calls[0].args).toEqual(['-s=iso_media','audio','feed']);expect(calls[0].upload.data).toBe(wav().toString('base64'));
 expect(JSON.stringify(calls[0].args)).not.toContain(path);expect(JSON.stringify(output)).not.toContain(calls[0].upload.data);
});
test('rejects invalid/symlink inputs before contacting the daemon and never relays daemon text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-invalid-'));const path=join(dir,'bad.wav');await writeFile(path,'bad');let calls=0;
 const serve=async()=>{calls++;return reply(status());};await expect(runAudioCommand(['audio','feed',path],serve,dir)).rejects.toThrow();expect(calls).toBe(0);
 const valid=join(dir,'valid.wav');await writeFile(valid,wav());const linked=join(dir,'linked.wav');await symlink(valid,linked);
 await expect(runAudioCommand(['audio','feed',linked],serve,dir)).rejects.toThrow();expect(calls).toBe(0);
 const error=await runAudioCommand(['audio','status'],async()=>({status:1,stdout:'fixture-private-response',stderr:'fixture-private-error'}),dir).catch(e=>e.message);
 expect(error).not.toContain('fixture-private');
});
test('stop saves and acknowledges an older batch then final fragments in order',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-stop-'));let drains=0;const calls:string[][]=[];
 const make=(seq:number,text:string,final:boolean)=>({...status('stopped'),receipt:randomUUID(),streams:[{id:'s-1',mimeType:'audio/webm',seq,chunks:[Buffer.from(text).toString('base64')],final}]});
 const first=make(0,'first',false),last=make(1,'last',true);
 const result=await runAudioCommand(['-s=media','audio','stop','--dir',dir],async(args)=>{calls.push(args);if(args.includes('ack'))return reply({acknowledged:true});if(args.includes('stop'))return reply({id,phase:'stopped',pending:true},first);return ++drains===1?reply({id,phase:'stopped',pending:true},last):reply(status('stopped'));},dir);
 expect(await readFile(result.files![0]!.path,'utf8')).toBe('firstlast');expect(calls.filter(a=>a.includes('ack'))).toHaveLength(2);expect(calls.every(a=>a[0]==='-s=media')).toBe(true);
});
test('does not acknowledge a batch when local saving fails',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rech-audio-no-ack-'));const path=join(dir,'file');await writeFile(path,'keep');let acked=false;
 const batch={...status('capturing'),receipt:randomUUID(),streams:[{id:'s-1',mimeType:'audio/webm',seq:0,chunks:[Buffer.from('fixture').toString('base64')],final:false}]};
 await expect(runAudioCommand(['audio','drain','--dir',path],async(args)=>{if(args.includes('ack'))acked=true;return reply({id,phase:'capturing',pending:true},batch);},dir)).rejects.toThrow();expect(acked).toBe(false);
});
