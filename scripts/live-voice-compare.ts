/** Explicit, owned-tab live voice experiment. Never reads credentials or uses a physical mic. */
import { runCodeOnSession } from "../fill-secret.ts";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { validateAudioUpload, validatePcmWav } from "../audio-bridge.ts";

export const TARGETS = {
  aistudio: {
    session: process.env.RECH_VOICE_AISTUDIO_SESSION || "",
    origin: "https://aistudio.google.com",
    url: "https://aistudio.google.com/live",
  },
  chatgpt: {
    session: process.env.RECH_VOICE_CHATGPT_SESSION || "",
    origin: "https://chatgpt.com",
    url: "https://chatgpt.com/",
  },
} as const;
const extension = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html";
const cwd = process.cwd();
const out = resolve(process.env.RECH_VOICE_OUT || ".rechrome/live-voice-results");

export function unwrap(text: string): unknown {
  if (Buffer.byteLength(text) > 512 * 1024) throw Error("result-size");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const matches = [...text.matchAll(/(?:^|\n)### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/g)];
    if (matches.length !== 1) throw Error("result-wrapper");
    value = JSON.parse(matches[0]![1]!);
  }
  for (let n = 0; n < 5; n++) {
    if (typeof value === "string") {
      value = JSON.parse(value);
      continue;
    }
    if (value && typeof value === "object" && "result" in value) {
      value = value.result;
      continue;
    }
    return value;
  }
  throw Error("result-depth");
}
export function isolatedSession(session: string, other: string) {
  if (!/^[A-Za-z0-9_-]+-iso_[A-Za-z0-9_-]+$/.test(session) || session.length > 128)
    throw Error("isolated-session-required");
  if (other && session === other) throw Error("distinct-sessions-required");
  return session;
}
export async function run(target: keyof typeof TARGETS, code: string, timeoutMs = 20000) {
  const session = isolatedSession(
    TARGETS[target].session,
    TARGETS[target === "aistudio" ? "chatgpt" : "aistudio"].session,
  );
  const response = await runCodeOnSession({
    socketRoot: "/private/tmp",
    session,
    cwd,
    code,
    json: true,
    timeoutMs,
  });
  if (response.isError) throw Error("browser-operation");
  return unwrap(response.text);
}
export function buildMuteCode() {
  const marker = crypto.randomUUID();
  return `async page => {
    if(page.url()!=='about:blank')throw new Error('owned-blank-required');
    await page.goto(${JSON.stringify(extension)});
    const proof=await page.evaluate(async()=>{
      const tab=await chrome.tabs.getCurrent();
      if(!Number.isInteger(tab?.id))throw new Error('owned-tab');
      await chrome.tabs.update(tab.id,{muted:true});
      const verified=await chrome.tabs.get(tab.id);
      if(verified.mutedInfo?.muted!==true)throw new Error('mute-required');
      return {tabId:tab.id,muted:true};
    });
    await page.addInitScript({content:${JSON.stringify(`Object.defineProperty(window,'__rechVoiceOwnedTabMarker',{value:${JSON.stringify(marker)}});`)}});
    await page.goto('about:blank');
    const control=await page.context().newPage();
    await control.goto(${JSON.stringify(extension)});
    const verified=await control.evaluate(async id=>{
      const self=await chrome.tabs.getCurrent();
      if(self?.id)await chrome.tabs.update(self.id,{muted:true});
      const tab=await chrome.tabs.get(id);
      if(tab.url!=='about:blank'||tab.mutedInfo?.muted!==true)throw new Error('mute-lost');
      chrome.tabs.onUpdated.addListener((changedId,change)=>{
        if(changedId===id&&change.mutedInfo?.muted===false)void chrome.tabs.update(id,{muted:true});
      });
      return {tabId:id,muted:true,guardInstalled:true};
    },proof.tabId);
    await page.bringToFront();
    return JSON.stringify({...verified,marker:${JSON.stringify(marker)}});
  }`;
}
export function buildInspectCode(target: keyof typeof TARGETS, tabId: number, marker: string) {
  if (!Number.isSafeInteger(tabId) || tabId < 1 || !isMarker(marker))
    throw Error("owned-tab-proof");
  const expected = TARGETS[target];
  return `async foreground => {
    const control=foreground.context().pages().find(p=>p.url()===${JSON.stringify(extension)});
    if(!control)throw new Error('mute-controller');
    const muted=await control.evaluate(async id=>{const t=await chrome.tabs.get(id);return t.mutedInfo?.muted===true;},${tabId});
    if(!muted)throw new Error('mute-required');
    let target;
    for(const candidate of foreground.context().pages().filter(p=>p.url().startsWith(${JSON.stringify(expected.url)}))){
      if(await candidate.evaluate(()=>window.__rechVoiceOwnedTabMarker).catch(()=>null)===${JSON.stringify(marker)}){if(target)throw new Error('ambiguous-owned-target');target=candidate;}
    }
    if(!target)throw new Error('owned-target');
    return JSON.stringify(await target.evaluate(()=>({
      mutedVerified:true,
      ready:document.readyState,visibility:document.visibilityState,
      buttonCount:document.querySelectorAll('button').length,
      selectedModels:[...document.querySelectorAll('button')].filter(b=>/^Gemini [0-9]/.test(b.getAttribute('aria-label')||b.innerText.trim())).map(b=>({label:(b.getAttribute('aria-label')||b.innerText.trim()).slice(0,250),disabled:b.disabled,expanded:b.getAttribute('aria-expanded')})),
      modelChoices:[...document.querySelectorAll('[role="option"],[role="menuitem"],mat-option')].map(b=>b.textContent?.trim().slice(0,300)).filter(t=>/Gemini|live|audio/i.test(t||'')),
      availableLiveModels:[...document.querySelectorAll('button')].filter(b=>/live|native.audio/i.test(b.textContent||'')).map(b=>({label:b.textContent?.trim().slice(0,600),disabled:b.disabled})),
      conversationTags:[...new Set([...document.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()).filter(n=>/chat|turn|transcript|message/.test(n)))],
      conversationTurns:[...document.querySelectorAll('ms-bidi-turn')].map(e=>e.innerText?.slice(0,3000)),
      bridge:window.__rechAudioBridge?.status(),
      buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({text:b.innerText.trim().slice(0,100),aria:b.getAttribute('aria-label')||''})).filter(b=>/voice|talk|speak|audio|stream|microphone|resume|agree|allow|continue|sign in|log in|privacy|accept|start|stop|close|send|end|录音|语音/i.test(b.text+' '+b.aria)),
      live:document.body.innerText.includes('Stream is live'),
      visibleDialogCount:[...document.querySelectorAll('[role="dialog"]')].filter(d=>d.getClientRects().length).length,
    })));
  }`;
}
export function buildProbeCode(
  tabId: number,
  marker: string,
  bridgeId: string,
  data: string,
  seconds: number,
  interruption?: { data: string; seconds: number },
) {
  if (
    !Number.isSafeInteger(tabId) ||
    tabId < 1 ||
    !isMarker(marker) ||
    !/^b-[a-f0-9]{32}$/.test(bridgeId) ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 30
  )
    throw Error("probe-input");
  if (
    interruption &&
    (!Number.isFinite(interruption.seconds) ||
      interruption.seconds <= 0 ||
      seconds + interruption.seconds > 30)
  )
    throw Error("probe-input");
  return `async foreground=>{
    const control=foreground.context().pages().find(p=>p.url()===${JSON.stringify(extension)});
    if(!control)throw new Error('mute-controller');
    if(!await control.evaluate(async id=>(await chrome.tabs.get(id)).mutedInfo?.muted===true,${tabId}))throw new Error('mute-required');
    let page;
    for(const candidate of foreground.context().pages().filter(p=>p.url().startsWith('https://aistudio.google.com/live'))){
      if(await candidate.evaluate(()=>window.__rechVoiceOwnedTabMarker).catch(()=>null)===${JSON.stringify(marker)}){if(page)throw new Error('ambiguous-owned-target');page=candidate;}
    }
    if(!page)throw new Error('owned-target');
    return JSON.stringify(await page.evaluate(async p=>{
      const bridge=window.__rechAudioBridge;
      if(location.origin!=='https://aistudio.google.com'||bridge?.status().id!==p.id)throw new Error('bridge-generation');
      const start=performance.now(),metrics={virtualMicRequests:0,wsSent:0,wsReceived:0,live:false,feedAtMs:null,inputEndMs:null,recorders:[],text:[],stopped:false,interruption:null};
      const gum=navigator.mediaDevices.getUserMedia,send=WebSocket.prototype.send,recStart=MediaRecorder.prototype.start;
      const seen=new WeakSet();
      const stopUi=()=>{[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.getAttribute('aria-label')==='Disconnect')?.click();};
      navigator.mediaDevices.getUserMedia=function(c){if(c?.audio)metrics.virtualMicRequests++;return Reflect.apply(gum,this,[c]);};
      WebSocket.prototype.send=function(d){
        metrics.wsSent++;
        if(!seen.has(this)){
          seen.add(this);this.addEventListener('message',e=>{
            metrics.wsReceived++;
            if(typeof e.data!=='string'||e.data.length>1000000)return;
            try{const r=JSON.parse(e.data),s=r.serverContent;
              for(const [kind,text]of [['input',s?.inputTranscription?.text],['output',s?.outputTranscription?.text],...((s?.modelTurn?.parts||[]).map(v=>['model',v.text]))]){
                if(typeof text==='string'&&metrics.text.length<100)metrics.text.push({kind,text:text.slice(0,1000),atMs:performance.now()-start});
              }
            }catch{}
          });
        }
        return Reflect.apply(send,this,[d]);
      };
      MediaRecorder.prototype.start=function(...args){
        metrics.recorders.push({atMs:performance.now()-start});
        if(p.interruption&&metrics.recorders.length===3)setTimeout(async()=>{
          try{
            if(bridge.status().phase!=='capturing'||bridge.status().queuedSeconds>0){metrics.interruption={blocked:true};return;}
            metrics.interruption={atMs:performance.now()-start,durationSeconds:p.interruption.seconds};
            await bridge.feedWav(p.interruption.data);
          }catch{metrics.interruption={failed:true};}
        },500);
        return Reflect.apply(recStart,this,args);
      };
      let timer;
      const cleanup=async()=>{stopUi();await bridge.stop();for(let n=0;n<20&&document.body.innerText.includes('Stream is live');n++)await new Promise(r=>setTimeout(r,100));metrics.stopped=true;};
      try{
        timer=setTimeout(()=>void cleanup(),45000);
        await bridge.startCapture();
        const buttons=[...document.querySelectorAll('button')];
        const talk=buttons.find(b=>b.getClientRects().length&&(['Talk','Resume stream','Start audio','Start talking'].includes(b.getAttribute('aria-label'))||/^(?:mic\\s+)?Speak$/.test(b.innerText.trim())))||
          (buttons.some(b=>b.textContent?.includes('gemini-3.8-live'))?buttons.find(b=>b.getClientRects().length&&b.getAttribute('aria-label')==='Microphone'):null);
        if(!talk)throw new Error('talk-control');talk.click();
        for(let n=0;n<40;n++){if(document.body.innerText.includes('Stream is live')){metrics.live=true;break;}await new Promise(r=>setTimeout(r,150));}
        if(!metrics.live)throw new Error('live-not-ready');
        metrics.feedAtMs=performance.now()-start;metrics.inputEndMs=metrics.feedAtMs+p.seconds*1000;
        await bridge.feedWav(p.data);
        await new Promise(r=>setTimeout(r,Math.min(35000,p.seconds*1000+14000)));
      }finally{
        await cleanup();clearTimeout(timer);navigator.mediaDevices.getUserMedia=gum;WebSocket.prototype.send=send;MediaRecorder.prototype.start=recStart;
      }
      const transcript=label=>{const e=[...document.querySelectorAll('h1,h2,h3,div,p')].find(e=>e.textContent?.trim()===label);return e?.parentElement?.innerText?.slice(0,4000)||'';};
      return{metrics,transcripts:{input:transcript('Input transcript'),output:transcript('Output transcript')},conversationTurns:[...document.querySelectorAll('ms-bidi-turn')].map(e=>e.innerText?.slice(0,3000)),stillLive:document.body.innerText.includes('Stream is live'),status:bridge.status()};
    },${JSON.stringify({ id: bridgeId, data, seconds, interruption })}));
  }`;
}
async function main() {
  const [action, target, fixture, interruptFixture, ...extra] = process.argv.slice(2);
  if (extra.length || ((fixture || interruptFixture) && action !== "probe"))
    throw Error("arguments");
  if (
    !["mute", "inspect", "probe", "mute-group"].includes(action || "") ||
    !(target && Object.hasOwn(TARGETS, target))
  )
    throw Error("arguments");
  const proof =
    action !== "mute" ? JSON.parse(await readFile(join(out, `${target}-mute.json`), "utf8")) : null;
  let code =
    action === "mute"
      ? buildMuteCode()
      : buildInspectCode(target as keyof typeof TARGETS, proof.tabId, proof.marker);
  if (action === "mute-group")
    code = `async p=>{
    const c=p.context().pages().find(v=>v.url()===${JSON.stringify(extension)});if(!c)throw new Error('controller');
    return JSON.stringify(await c.evaluate(async id=>{const owned=await chrome.tabs.get(id);if(owned.groupId<0)throw new Error('owned-group');const tabs=await chrome.tabs.query({groupId:owned.groupId});for(const t of tabs)await chrome.tabs.update(t.id,{muted:true});return{groupId:owned.groupId,tabs:tabs.map(t=>({id:t.id,muted:true}))};},${proof.tabId}));
  }`;
  if (action === "probe") {
    if (target !== "aistudio" || !fixture) throw Error("probe-target");
    const upload = {
      name: "input.wav" as const,
      contentType: "audio/wav" as const,
      data: (await readFile(fixture)).toString("base64"),
    };
    validateAudioUpload(upload);
    const wav = validatePcmWav(Buffer.from(upload.data, "base64"));
    const state = JSON.parse(await readFile(join(out, `${target}-inspect.json`), "utf8"));
    let interruption;
    if (interruptFixture) {
      const bytes = await readFile(interruptFixture),
        info = validatePcmWav(bytes);
      interruption = { data: bytes.toString("base64"), seconds: info.durationSeconds };
    }
    code = buildProbeCode(
      proof.tabId,
      proof.marker,
      state.bridge.id,
      upload.data,
      wav.durationSeconds,
      interruption,
    );
  }
  const result = await run(
    target as keyof typeof TARGETS,
    code,
    action === "probe" ? 50000 : 20000,
  );
  await mkdir(out, { recursive: true, mode: 0o700 });
  const suffix =
    action === "probe"
      ? "-" +
        basename(fixture!).replace(/[^a-zA-Z0-9_.-]/g, "_") +
        (interruptFixture ? "-interrupted" : "")
      : "";
  await writeFile(join(out, `${target}-${action}${suffix}.json`), JSON.stringify(result), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ target, result }));
}
function isMarker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
if (import.meta.main)
  await main().catch(() => {
    console.error("Voice comparison stopped; no page or credential excerpts were logged.");
    process.exitCode = 1;
  });
