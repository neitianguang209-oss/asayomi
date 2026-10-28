// あさよみ Edge Function(読み上げと質問)
// - ニュースの記事を Gemini の読み上げ(TTS)で声にする。返すのは生の音(PCM)で、mp3 にするのは端末側。
//   端末が mp3 を送り返すと公開バケット asayomi-audio に置き、ほかの端末はそれを取りに行くだけ(1本につき1回しか作らない)
// - 聞いている途中の質問に、記事をふまえて耳で聞いてわかる短さで答える
// - Gemini のキーはサーバー側(asayomi_secret)だけに置く。無料枠を使い切らないよう1日の回数に上限をつける
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const BUCKET = 'asayomi-audio';
const RATE = 24000;
const VOICE = 'Kore';
const KEEP_DAYS = 21;                       // 音声はこの日数だけ残す
const CAP = { tts: 40, ask: 80 } as const;  // 1日の回数上限
const TTS_FALLBACK = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];
const TEXT_FALLBACK = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const CATS: Record<string, string> = { world: '世界', japan: '日本', ai: 'AI' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isN = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 20;

async function getSecret(k: string): Promise<string | null> {
  const { data } = await db.from('asayomi_secret').select('v').eq('k', k).maybeSingle();
  return data?.v ?? null;
}
async function setSecret(k: string, v: string) {
  await db.from('asayomi_secret').upsert({ k, v, updated_at: new Date().toISOString() });
}
// 今日の回数を1つ進める。上限を超えたら false
async function count(action: keyof typeof CAP): Promise<boolean> {
  const day = todayJST();
  const { data } = await db.from('asayomi_voice_log').select('cnt').eq('day', day).eq('action', action).maybeSingle();
  const cnt = (data?.cnt ?? 0) + 1;
  if (cnt > CAP[action]) return false;
  await db.from('asayomi_voice_log').upsert({ day, action, cnt });
  return true;
}

/* ---------- モデル選び(入れ替わるので週1回は一覧を取り直す) ---------- */
function orderTts(names: string[]) {
  return names
    .map((n) => {
      const m = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)(-lite)?-(?:preview-)?tts(-preview)?$/.exec(n);
      return m ? { name: n, ver: parseFloat(m[1]), rank: (m[4] ? 2 : 0) + (m[3] ? 1 : 0) } : null;
    })
    .filter((m): m is { name: string; ver: number; rank: number } => !!m && m.ver >= 2.5)
    .sort((a, b) => b.ver - a.ver || a.rank - b.rank)
    .map((m) => m.name)
    .slice(0, 5);
}
function orderText(names: string[]) {
  return names
    .map((n) => {
      const m = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(n);
      return m ? { name: n, ver: parseFloat(m[1]), lite: m[2] ? 1 : 0 } : null;
    })
    .filter((m): m is { name: string; ver: number; lite: number } => !!m && m.ver >= 3)
    .sort((a, b) => a.lite - b.lite || b.ver - a.ver)
    .map((m) => m.name)
    .slice(0, 5);
}
type Models = { tts: string[]; text: string[]; checkedAt: number };
async function listModels(key: string): Promise<{ ok: boolean; status?: number; models?: Models }> {
  const res = await fetch(API + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json().catch(() => null);
  const names = ((data?.models ?? []) as any[]).map((m) => String(m.name ?? '').replace(/^models\//, ''));
  const tts = orderTts(names);
  const text = orderText(names);
  return { ok: true, models: { tts: tts.length ? tts : TTS_FALLBACK, text: text.length ? text : TEXT_FALLBACK, checkedAt: Date.now() } };
}
async function modelsFor(key: string): Promise<Models> {
  try {
    const raw = await getSecret('gemini_models');
    const st = raw ? JSON.parse(raw) : null;
    if (st?.tts?.length && st?.text?.length && Date.now() - (st.checkedAt ?? 0) < 7 * 864e5) return st;
  } catch { /* 取り直す */ }
  const r = await listModels(key).catch(() => ({ ok: false } as { ok: boolean; models?: Models }));
  if (r.ok && r.models) {
    await setSecret('gemini_models', JSON.stringify(r.models));
    return r.models;
  }
  return { tts: TTS_FALLBACK, text: TEXT_FALLBACK, checkedAt: 0 };
}

/* ---------- 記事 → 読み上げる文 ---------- */
function clean(s: unknown) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' } as Record<string, string>)[m])
    .replace(/==|\*\*|\[\[|\]\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
}
const stop = (s: string) => (/[。！？!?」』）)]$/.test(s) ? s : s + '。');
function secsOf(d: any) {
  const out: { h: string; ps: string[] }[] = [];
  for (const s of d.secs || d.sections || []) {
    if (Array.isArray(s)) out.push({ h: s[0], ps: [s[1]] });
    else if (s) out.push({ h: s.h, ps: Array.isArray(s.p) ? s.p : [s.p] });
  }
  return out;
}
function speechOf(d: any, n: number) {
  const cat = d.catn || CATS[d.cat] || '';
  const lines = [n + '本目。' + (cat ? cat + 'のニュースです。' : ''), stop(clean(d.title))];
  if (d.lede) lines.push(stop(clean(d.lede)));
  for (const s of secsOf(d)) {
    if (s.h) lines.push(stop(clean(s.h)));
    for (const p of s.ps) if (p) lines.push(stop(clean(p)));
  }
  if (d.life) lines.push(stop(clean(d.lifeLabel || '暮らしに効くポイント')), stop(clean(d.life)));
  return lines.filter((l) => l && l !== '。').join('\n');
}
// 質問に答えるとき用の、見出しつきの本文
function articleText(d: any) {
  const out = ['題: ' + clean(d.title)];
  if (d.lede) out.push(clean(d.lede));
  for (const s of secsOf(d)) {
    if (s.h) out.push('【' + clean(s.h) + '】');
    for (const p of s.ps) if (p) out.push(clean(p));
  }
  if (d.life) out.push('【' + clean(d.lifeLabel || '暮らしに効く') + '】' + clean(d.life));
  for (const t of d.terms || []) if (Array.isArray(t) && t[0]) out.push('用語「' + clean(t[0]) + '」: ' + clean(t[1]));
  return out.join('\n');
}
async function newsItem(date: string, n: number) {
  const { data } = await db.from('asayomi_items').select('data').eq('kind', 'news').eq('date', date).eq('n', n).maybeSingle();
  return data?.data ?? null;
}

/* ---------- Gemini ---------- */
type Res = { ok: true; data: any; model: string } | { ok: false; code: 'key' | 'quota' | 'ai'; status?: number; msg?: string };
async function tryModels(models: string[], call: (m: string) => Promise<Response>): Promise<Res> {
  let last: Res = { ok: false, code: 'ai' };
  for (const model of models) {
    const res = await call(model).catch(() => null);
    if (!res) { last = { ok: false, code: 'ai' }; continue; }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data) return { ok: true, data, model };
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID/i.test(text)) return { ok: false, code: 'key', status: res.status };
    last = { ok: false, code: res.status === 429 ? 'quota' : 'ai', status: res.status, msg: text.slice(0, 300) };
  }
  return last;
}
function audioOf(data: any): string | null {
  const steps = data?.steps ?? [];
  let found: string | null = null;
  for (const s of steps) for (const c of s?.content ?? []) if (c?.type === 'audio' && c.data) found = c.data;
  if (found) return found;
  // generateContent の形で返ってきた場合
  for (const c of data?.candidates ?? []) for (const p of c?.content?.parts ?? []) if (p?.inlineData?.data) return p.inlineData.data;
  return null;
}
async function synth(key: string, models: string[], text: string): Promise<Res> {
  return tryModels(models, (model) => fetch(API + 'interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: '落ち着いて聞き取りやすい、ニュースの読み上げ' }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: RATE },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
  }));
}

const ASK_SYSTEM = [
  'あなたは朝のニュースアプリ「あさよみ」の解説役です。聞き手は通勤・通学で歩きながら、ニュースを音声で聞いている大学生です。',
  '記事を聞いていてわからなかったことを質問されるので、その記事をふまえて答えてください。',
  '答えは耳で聞いてすぐわかる日本語の話し言葉で、2〜4文・200字以内。箇条書き・記号・URL・英語の略語の羅列は使わない。',
  '記事に書いていないことは一般的な知識で補ってよいが、最近の出来事で確かでないことは「記事の時点では」などと断る。',
  '質問の聞き取りが崩れていても、記事の内容から意図をくみ取って答える。',
].join('\n');

/* ---------- 入口 ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  try {
    switch (body.action) {
      // その日の音声の一覧(できているもの・作っている最中のもの)
      case 'status': {
        if (!isDate(body.date)) return json({ error: 'bad date' }, 400);
        const [{ data: rows }, key] = await Promise.all([
          db.from('asayomi_audio').select('n,path,dur,claimed_at').eq('date', body.date),
          getSecret('gemini_key'),
        ]);
        const pub = (p: string) => db.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
        return json({
          ready: !!key,
          items: (rows ?? []).map((r) => ({
            n: r.n,
            url: r.path ? pub(r.path) : null,
            dur: r.dur,
            busy: !r.path && !!r.claimed_at && Date.now() - Date.parse(r.claimed_at) < 4 * 60e3,
          })),
        });
      }

      // キーを登録する(使えるか確かめてから)
      case 'set-key': {
        const key = String(body.key ?? '').trim();
        if (!/^[A-Za-z0-9_-]{30,60}$/.test(key)) return json({ error: 'キーの形がちがうようです', code: 'key' }, 400);
        const r = await listModels(key);
        if (!r.ok) return json({ error: 'このキーは使えないようです', code: 'key', status: r.status }, 400);
        await setSecret('gemini_key', key);
        await setSecret('gemini_models', JSON.stringify(r.models));
        return json({ ok: true });
      }

      // 1本ぶんの声を作って、生の音(24kHz・16bit・1ch)を base64 で返す
      case 'tts': {
        const { date, n } = body;
        if (!isDate(date) || !isN(n)) return json({ error: 'bad item' }, 400);
        const { data: row } = await db.from('asayomi_audio').select('path,claimed_at').eq('date', date).eq('n', n).maybeSingle();
        if (row?.path) return json({ done: true });
        if (row?.claimed_at && Date.now() - Date.parse(row.claimed_at) < 4 * 60e3 && !body.force) return json({ busy: true });
        const d = await newsItem(date, n);
        if (!d) return json({ error: 'no item' }, 404);
        const key = await getSecret('gemini_key');
        if (!key) return json({ error: 'キーが未登録です', code: 'nokey' }, 400);
        if (!(await count('tts'))) return json({ error: '今日の読み上げの回数の上限です', code: 'cap' }, 429);
        await db.from('asayomi_audio').upsert({ date, n, claimed_at: new Date().toISOString() });
        const models = await modelsFor(key);
        const r = await synth(key, models.tts, speechOf(d, n));
        const pcm = r.ok ? audioOf(r.data) : null;
        if (!r.ok || !pcm) {
          await db.from('asayomi_audio').update({ claimed_at: null }).eq('date', date).eq('n', n).is('path', null);
          const code = r.ok ? 'ai' : r.code;
          return json({ error: code === 'quota' ? 'Gemini の無料枠を使い切りました' : code === 'key' ? 'キーが使えなくなりました' : '声を作れませんでした', code, detail: r.ok ? 'no audio' : r.msg }, code === 'quota' ? 429 : 502);
        }
        return json({ pcm, rate: RATE, model: r.model });
      }

      // 端末が作った mp3 を置く
      case 'put': {
        const { date, n } = body;
        const dur = Number(body.dur);
        if (!isDate(date) || !isN(n) || !(dur > 0 && dur < 1200) || typeof body.mp3 !== 'string') return json({ error: 'bad put' }, 400);
        const { data: row } = await db.from('asayomi_audio').select('path').eq('date', date).eq('n', n).maybeSingle();
        if (!row) return json({ error: 'not claimed' }, 409);
        if (row.path) return json({ ok: true, dup: true });
        const bytes = Uint8Array.from(atob(body.mp3), (c) => c.charCodeAt(0));
        if (bytes.length < 1000 || bytes.length > 6 * 1024 * 1024) return json({ error: 'bad size' }, 400);
        const path = 'news/' + date + '/' + n + '-' + crypto.randomUUID().slice(0, 8) + '.mp3';
        const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'audio/mpeg', cacheControl: '31536000' });
        if (up.error) return json({ error: up.error.message }, 500);
        await db.from('asayomi_audio').update({ path, dur, bytes: bytes.length, model: String(body.model ?? '').slice(0, 60), claimed_at: null }).eq('date', date).eq('n', n);
        // 古い音声を片づける
        const old = new Date(Date.now() + 9 * 3600e3 - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
        const { data: olds } = await db.from('asayomi_audio').select('date,n,path').lt('date', old).limit(50);
        if (olds?.length) {
          const paths = olds.map((o) => o.path).filter(Boolean) as string[];
          if (paths.length) await db.storage.from(BUCKET).remove(paths);
          await db.from('asayomi_audio').delete().lt('date', old);
        }
        return json({ ok: true, url: db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl });
      }

      // 聞いている途中の質問に答える
      case 'ask': {
        const { date, n } = body;
        const q = String(body.q ?? '').trim().slice(0, 400);
        if (!isDate(date) || !isN(n) || !q) return json({ error: 'bad ask' }, 400);
        const d = await newsItem(date, n);
        if (!d) return json({ error: 'no item' }, 404);
        const key = await getSecret('gemini_key');
        if (!key) return json({ error: 'キーが未登録です', code: 'nokey' }, 400);
        if (!(await count('ask'))) return json({ error: '今日の質問の回数の上限です', code: 'cap' }, 429);
        const near = clean(body.near ?? '').slice(0, 600);
        const prev = (Array.isArray(body.history) ? body.history : []).slice(-4)
          .map((x: any) => 'Q: ' + clean(x?.q).slice(0, 200) + '\nA: ' + clean(x?.a).slice(0, 300)).join('\n');
        const prompt = [
          '記事(' + date + ' 配信):', articleText(d), '',
          near ? 'いま聞いていたあたり: ' + near + '\n' : '',
          prev ? 'この記事についてのこれまでのやりとり:\n' + prev + '\n' : '',
          '質問: ' + q,
        ].join('\n');
        const models = await modelsFor(key);
        const r = await tryModels(models.text, (model) => fetch(API + 'models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: ASK_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
          }),
        }));
        if (!r.ok) return json({ error: r.code === 'quota' ? 'Gemini の無料枠を使い切りました' : '答えを作れませんでした', code: r.code }, r.code === 'quota' ? 429 : 502);
        const parts = r.data?.candidates?.[0]?.content?.parts ?? [];
        const a = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('').trim();
        if (!a) return json({ error: '答えを作れませんでした', code: 'ai' }, 502);
        return json({ a, model: r.model });
      }
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
