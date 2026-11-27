import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pcmFormat, type PcmFormat, type StreamTicket } from './audio-stream.ts';
export type PairTarget = {
    id: string;
    title: string;
    origin: string;
};
type Grant = {
    ticket: StreamTicket;
    isActive: () => boolean;
    revoke: () => void | Promise<void>;
};
type Pending = {
    id: string;
    nonce: string;
    origin: string;
    sourceId: string;
    pcm: PcmFormat;
    expiresAt: number;
    state: 'pending' | 'approving' | 'approved' | 'denied' | 'expired' | 'cancelled';
    grant?: Grant;
    chat?: PairTarget;
};
const secret = () => randomBytes(32).toString('base64url');
const same = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function readPairResult(text: string): any {
    if (Buffer.byteLength(text) > 8192)
        throw Error('pair result too large');
    let result: any;
    try {
        result = JSON.parse(text);
    }
    catch {
        const m = /### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/.exec(text);
        if (!m)
            throw Error('pair result');
        result = JSON.parse(m[1]!);
    }
    for (let i = 0; i < 5; i++) {
        if (typeof result === 'string') {
            result = JSON.parse(result);
            continue;
        }
        if (result?.isError || result?.error)
            throw Error('pair result');
        if (result && Object.hasOwn(result, 'result')) {
            result = result.result;
            continue;
        }
        return result;
    }
    throw Error('pair result');
}
function clientOrigin(value: string | null) {
    if (!value)
        return null;
    try {
        const u = new URL(value);
        return u.origin === value && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) ? value : null;
    }
    catch {
        return null;
    }
}
export function createAudioPairing(deps: {
    targets: () => Promise<PairTarget[]>;
    grant: (target: string, options: {
        sourceId: string;
        origin: string;
        pcm: PcmFormat;
    }) => Promise<Grant>;
    now?: () => number;
}) {
    const now = deps.now ?? Date.now, requests = new Map<string, Pending>(), bootstraps = new Map<string, number>(), operators = new Map<string, number>();
    let active = true;
    let operatorWake: (() => Promise<void>) | undefined;
    let lastWake = -Infinity;
    let waking = false;
    const revoke = async (p: Pending) => {
        const grant = p.grant;
        p.grant = undefined;
        if (grant)
            await grant.revoke();
    };
    const sweep = () => {
        for (const [id, p] of requests) {
            if ((['pending', 'approving'].includes(p.state) && now() >= p.expiresAt) || (p.state === 'approved' && p.grant && now() >= p.grant.ticket.expiresAt && !p.grant.isActive())) {
                p.state = 'expired';
                void revoke(p).catch(() => { });
            }
            if (['cancelled', 'denied', 'expired'].includes(p.state) && now() > p.expiresAt + 120000)
                requests.delete(id);
        }
        for (const [k, t] of bootstraps)
            if (now() >= t)
                bootstraps.delete(k);
        for (const [k, t] of operators)
            if (now() >= t)
                operators.delete(k);
    };
    const expiry = setInterval(sweep, 1000);
    expiry.unref?.();
    const bootstrap = () => {
        sweep();
        if (bootstraps.size >= 8)
            throw Error('local approval busy');
        const token = secret();
        bootstraps.set(token, now() + 60000);
        return token;
    };
    const handle = async (req: Request, base: string): Promise<Response> => {
        sweep();
        const path = new URL(req.url).pathname;
        const incoming = clientOrigin(req.headers.get('origin'));
        const localOrigin = new URL(base).origin;
        const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Vary': 'Origin', 'Referrer-Policy': 'no-referrer' };
        if (incoming) {
            headers['Access-Control-Allow-Origin'] = incoming;
            headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
            headers['Access-Control-Allow-Headers'] = 'Content-Type';
            headers['Access-Control-Allow-Private-Network'] = 'true';
        }
        const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
        const unavailable = () => json({ error: 'Local audio connection unavailable' }, 403);
        if (!active)
            return unavailable();
        if (req.method === 'OPTIONS')
            return incoming ? new Response(null, { status: 204, headers }) : unavailable();
        if (path === '/audio/pair/approve' && req.method === 'GET')
            return new Response(PANEL, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'Cross-Origin-Opener-Policy': 'same-origin', 'X-Frame-Options': 'DENY' } });
        if (path === '/audio/pair/discovery' && req.method === 'GET')
            return incoming ? json({ version: 2, requestUrl: base + '/audio/pair/request' }) : unavailable();
        if (req.method !== 'POST' && path !== '/audio/pair/targets')
            return json({ error: 'Not found' }, 404);
        const cookie = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('rech_audio_operator='))?.slice('rech_audio_operator='.length);
        const operator = (incoming === localOrigin || (!incoming && req.method === 'GET' && req.headers.get('sec-fetch-site') === 'same-origin')) && cookie && (operators.get(cookie) ?? 0) > now();
        if (path === '/audio/pair/targets' && req.method === 'GET') {
            if (!operator)
                return unavailable();
            operators.set(cookie!, now() + 600000);
            return json({ targets: await deps.targets(), requests: [...requests.values()].filter(p => p.state === 'pending').map(p => ({ requestId: p.id, origin: p.origin, expiresAt: p.expiresAt })) }, 200, { 'Set-Cookie': `rech_audio_operator=${cookie}; HttpOnly; SameSite=Strict; Path=/audio/pair; Max-Age=600${localOrigin.startsWith('https:') ? '; Secure' : ''}` });
        }
        let data: any;
        try {
            if (!req.headers.get('content-type')?.startsWith('application/json'))
                return unavailable();
            const reader = req.body?.getReader();
            if (!reader)
                throw Error();
            let text = '', bytes = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('request timeout')), 2000); });
            try {
                for (;;) {
                    const part = await Promise.race([reader.read(), deadline]);
                    if (part.done)
                        break;
                    if ((bytes += part.value.byteLength) > 4096)
                        throw Error('large body');
                    text += new TextDecoder().decode(part.value);
                }
            }
            finally {
                clearTimeout(timer);
                void reader.cancel().catch(() => { });
            }
            data = JSON.parse(text);
            if (!data || typeof data !== 'object' || Array.isArray(data))
                throw Error();
        }
        catch {
            return json({ error: 'Invalid request' }, 400);
        }
        if (path === '/audio/pair/operator') {
            if (incoming !== localOrigin || typeof data.token !== 'string' || (bootstraps.get(data.token) ?? 0) <= now())
                return unavailable();
            bootstraps.delete(data.token);
            const token = secret();
            if (operators.size >= 16)
                operators.delete(operators.keys().next().value!);
            operators.set(token, now() + 600000);
            return json({ ready: true }, 200, { 'Set-Cookie': `rech_audio_operator=${token}; HttpOnly; SameSite=Strict; Path=/audio/pair; Max-Age=600${localOrigin.startsWith('https:') ? '; Secure' : ''}` });
        }
        if (path === '/audio/pair/request') {
            if (!incoming)
                return unavailable();
            try {
                if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.sourceId) || !(data.destinationId === undefined || data.destinationId === null || data.destinationId === 'select-chat') || data.frameMs !== 20)
                    throw Error();
                const pcm = pcmFormat(data.input);
                if (JSON.stringify(pcm) !== JSON.stringify(pcmFormat(data.output)))
                    throw Error();
                if (requests.size >= 32 || [...requests.values()].filter(p => !['cancelled', 'denied', 'expired'].includes(p.state)).length >= 8 || [...requests.values()].filter(p => p.origin === incoming && !['cancelled', 'denied', 'expired'].includes(p.state)).length >= 2)
                    return json({ error: 'Local approval busy' }, 429);
                const p: Pending = { id: randomUUID(), nonce: secret(), origin: incoming, sourceId: data.sourceId, pcm, expiresAt: now() + 120000, state: 'pending' };
                requests.set(p.id, p);
                if (operatorWake && !waking && now() - lastWake >= 5000) {
                    lastWake = now();
                    waking = true;
                    void operatorWake().catch(() => { }).finally(() => { waking = false; });
                }
                return json({ requestId: p.id, requestNonce: p.nonce, expiresAt: p.expiresAt, approvalUrl: base + '/audio/pair/approve?requestId=' + p.id, statusUrl: base + '/audio/pair/status', cancelUrl: base + '/audio/pair/cancel' });
            }
            catch {
                return json({ error: 'Unsupported audio connection' }, 400);
            }
        }
        const p = requests.get(data.requestId);
        if (path === '/audio/pair/status' || path === '/audio/pair/cancel') {
            if (!p || incoming !== p.origin || !same(data.requestNonce, p.nonce))
                return unavailable();
            if (path.endsWith('/cancel')) {
                p.state = 'cancelled';
                await revoke(p);
                return json({ state: 'cancelled' });
            }
            if (p.state === 'approved' && p.grant && now() >= p.grant.ticket.expiresAt && !p.grant.isActive()) {
                p.state = 'expired';
                await revoke(p);
            }
            return json({ state: p.state === 'approving' ? 'pending' : p.state, ...(p.state === 'approved' && p.grant ? { ticket: p.grant.ticket, approvedChat: { title: p.chat!.title, origin: p.chat!.origin } } : {}) });
        }
        if (path === '/audio/pair/approve') {
            if (!operator || !p || p.state !== 'pending')
                return unavailable();
            if (data.action === 'deny') {
                p.state = 'denied';
                return json({ state: 'denied' });
            }
            if (data.action !== 'approve' || typeof data.targetId !== 'string')
                return json({ error: 'Select a local chat' }, 400);
            p.state = 'approving';
            const target = (await deps.targets()).find(t => t.id === data.targetId);
            if (p.state !== 'approving' || now() >= p.expiresAt)
                return json({ state: p.state });
            if (!target) {
                p.state = 'denied';
                return json({ error: 'Chat unavailable' }, 409);
            }
            try {
                const grant = await deps.grant(target.id, { sourceId: p.sourceId, origin: p.origin, pcm: p.pcm });
                if (p.state !== 'approving' || now() >= p.expiresAt) {
                    await grant.revoke();
                    if (p.state === 'approving')
                        p.state = 'expired';
                    return json({ state: p.state });
                }
                p.grant = grant;
                p.chat = target;
                p.state = 'approved';
                return json({ state: 'approved' });
            }
            catch {
                if (p.state === 'approving')
                    p.state = 'denied';
                return json({ error: 'Chat could not connect' }, 409);
            }
        }
        return json({ error: 'Not found' }, 404);
    };
    return { handle, bootstrap, setOperatorWake(wake: () => Promise<void>) { operatorWake = wake; }, close() { active = false; clearInterval(expiry); for (const p of requests.values()) {
            p.state = 'cancelled';
            void revoke(p).catch(() => { });
        } requests.clear(); operators.clear(); bootstraps.clear(); } };
}
export function buildOpenApprovalPanel(base: string, token: string) {
    return `async page=>{const panel=page.context().pages().find(p=>p.url().split('?')[0]===${JSON.stringify(base + '/audio/pair/approve')})||await page.context().newPage();await panel.goto(${JSON.stringify(base + '/audio/pair/approve')});const response=await panel.evaluate(async token=>{const r=await fetch('/audio/pair/operator',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});return r.ok},${JSON.stringify(token)});if(!response)throw new Error('local approval unavailable');await panel.reload();await panel.bringToFront();return JSON.stringify({opened:true})}`;
}
const PANEL = `<!doctype html><meta charset="utf-8"><title>Rechrome audio connections</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:740px;margin:48px auto;padding:24px}button,select{font:inherit;margin:8px;padding:10px}section{padding:16px;border:1px solid #aaa;border-radius:12px;margin:16px 0}p{line-height:1.5}</style><h1>Connect a local audio chat</h1><p>Choose the chat you want to connect. Approval shares only its audio stream with the displayed website. It does not start a model call or turn on a microphone.</p><p id="status">Checking local approval…</p><div id="requests"></div><script>
const root=document.getElementById('requests'),status=document.getElementById('status');
async function refresh(){try{const r=await fetch('/audio/pair/targets',{credentials:'same-origin'});if(!r.ok){status.textContent='The local connection assistant is not ready. Open Rechrome on this computer, then retry.';root.replaceChildren();const retry=document.createElement('button');retry.textContent='Retry connection';retry.onclick=refresh;root.append(retry);const details=document.createElement('details'),summary=document.createElement('summary'),help=document.createElement('p');summary.textContent='Advanced diagnostics';help.textContent='A local operator can initialize the companion with: rech audio approvals';details.append(summary,help);root.append(details);return}const data=await r.json();const selected=new Map([...root.querySelectorAll('section')].map(box=>[box.dataset.requestId,box.querySelector('select')?.value]));status.textContent=data.requests.length?'Select a chat and approve the website below.':'Waiting for a website to request Connect…';root.replaceChildren();for(const request of data.requests){const box=document.createElement('section');box.dataset.requestId=request.requestId;const title=document.createElement('h2');title.textContent=request.origin;box.append(title);const select=document.createElement('select');for(const t of data.targets){const option=document.createElement('option');option.value=t.id;option.selected=selected.get(request.requestId)===t.id;option.textContent=t.title+' — '+t.origin;select.append(option)}box.append(select);for(const action of ['approve','deny']){const button=document.createElement('button');button.textContent=action==='approve'?'Connect selected chat':'Reject';button.disabled=action==='approve'&&!data.targets.length;button.onclick=async()=>{button.disabled=true;const response=await fetch('/audio/pair/approve',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:request.requestId,action,targetId:select.value})});status.textContent=response.ok?'Decision saved. Return to the requesting page.':'The chat is unavailable; retry Connect.';await refresh()};box.append(button)}root.append(box)}}catch{status.textContent='The local companion is unavailable.'}}
refresh();setInterval(()=>{if(!document.querySelector('select:focus'))refresh()},2000);
</script>`;
