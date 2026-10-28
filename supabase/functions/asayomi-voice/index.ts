// あさよみ Edge Function(読み上げと質問)
// - ニュース・雑学の記事を Gemini の読み上げ(TTS)で声にする。返すのは生の音(PCM)で、mp3 にするのは端末側。
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
// 1本目には「今日のニュース、8本です」のような入りをつける(ニュース→雑学でも雑学→ニュースでも自然につながるように)
function speechOf(kind: Kind, d: any, n: number, total: number) {
  const lines: string[] = [];
  if (n === 1 && total) lines.push((kind === 'news' ? '今日のニュース' : '今日の雑学') + 'は、' + total + '本です。');
  if (kind === 'news') {
    const cat = d.catn || CATS[d.cat] || '';
    lines.push(n + '本目。' + (cat ? cat + 'のニュースです。' : ''), stop(clean(d.title)));
    if (d.lede) lines.push(stop(clean(d.lede)));
    for (const s of secsOf(d)) {
      if (s.h) lines.push(stop(clean(s.h)));
      for (const p of s.ps) if (p) lines.push(stop(clean(p)));
    }
    if (d.life) lines.push(stop(clean(d.lifeLabel || '暮らしに効くポイント')), stop(clean(d.life)));
  } else {
    const g = d.genreLabel || GENRE[d.genre] || '';
    lines.push('雑学の' + n + '本目。' + (g ? g + 'のお話です。' : ''), stop(clean(d.title)));
    if (d.gist) lines.push(stop(clean(d.gist)));
    for (const s of d.sections || []) {
      if (s.h) lines.push(stop(clean(s.h)));
      for (const p of Array.isArray(s.p) ? s.p : [s.p]) if (p) lines.push(stop(clean(p)));
    }
    if (d.talk) lines.push('会話で使える一言。', stop(clean(d.talk)));
    if (d.extra?.text) lines.push(stop(clean(d.extra.label || 'ひとこと')), stop(clean(d.extra.text)));
  }
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
type Kind = 'news' | 'trivia';
const kindOf = (k: unknown): Kind => (k === 'trivia' ? 'trivia' : 'news'); // 前の版の端末は kind を送らない(=ニュース)
async function itemOf(kind: Kind, date: string, n: number) {
  const { data } = await db.from('asayomi_items').select('data').eq('kind', kind).eq('date', date).eq('n', n).maybeSingle();
  return data?.data ?? null;
}
async function countOf(kind: Kind, date: string) {
  const { count } = await db.from('asayomi_items').select('n', { count: 'exact', head: true }).eq('kind', kind).eq('date', date);
  return count ?? 0;
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
// 返ってきた JSON のどこかにある音声(base64)を探す。interactions は steps[].content[]、generateContent は candidates[].content.parts[].inlineData
function audioOf(data: any): { data: string; mime: string } | null {
  let found: { data: string; mime: string } | null = null;
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const mime = String(o.mime_type ?? o.mimeType ?? '');
    if (typeof o.data === 'string' && o.data.length > 1000 && (o.type === 'audio' || /^audio\//.test(mime))) found = { data: o.data, mime };
    for (const k of Object.keys(o)) if (k !== 'data') walk(o[k], depth + 1);
  };
  walk(data, 0);
  return found;
}
// 失敗の中身を残しておく(あとで原因を調べるため。キーは含めない)
async function logErr(where: string, msg: string) {
  console.error('[asayomi-voice]', where, msg);
  await setSecret('last_error', JSON.stringify({ at: new Date().toISOString(), where, msg: msg.slice(0, 800) })).catch(() => {});
}
type Synth = { ok: true; pcm: string; rate: number; model: string } | { ok: false; code: 'key' | 'quota' | 'ai'; msg: string };
// 新しい呼び方(interactions)で作り、だめなら前からの呼び方(generateContent)でもう一度。モデルも順に試す
async function synth(key: string, models: string[], text: string, style: string): Promise<Synth> {
  const viaI = (model: string) => fetch(API + 'interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: RATE },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
  });
  const viaG = (model: string) => fetch(API + 'models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    }),
  });
  let last: Synth = { ok: false, code: 'ai', msg: 'no model' };
  for (const model of models.slice(0, 3)) {
    for (const [via, call] of [['interactions', viaI], ['generateContent', viaG]] as const) {
      const res = await call(model).catch((e) => { last = { ok: false, code: 'ai', msg: via + ' ' + model + ' network ' + e }; return null; });
      if (!res) continue;
      const txt = await res.text().catch(() => '');
      if (res.ok) {
        let data: any = null;
        try { data = JSON.parse(txt); } catch { /* 下で扱う */ }
        const au = audioOf(data);
        // 音の形は mime の rate= で分かればそれに従う(WAV のときは端末側で頭の部分を読む)
        if (au) return { ok: true, pcm: au.data, rate: Number((/rate=(\d+)/i.exec(au.mime) || [])[1]) || RATE, model: model + '/' + via };
        last = { ok: false, code: 'ai', msg: via + ' ' + model + ' no audio: ' + txt.slice(0, 400) };
        await logErr('tts', last.msg);
        continue;
      }
      if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID/i.test(txt)) return { ok: false, code: 'key', msg: txt.slice(0, 300) };
      last = { ok: false, code: res.status === 429 ? 'quota' : 'ai', msg: via + ' ' + model + ' ' + res.status + ' ' + txt.slice(0, 400) };
      await logErr('tts', last.msg);
      if (res.status === 429) break; // このモデルの枠は終わり。次のモデルへ
    }
  }
  return last;
}

const ASK_SYSTEM = [
  'あなたは朝のアプリ「あさよみ」の解説役です。聞き手は通勤・通学で歩きながら、ニュースや雑学を音声で聞いている大学生です。',
  '記事を聞いていてわからなかったことを質問されるので、その記事をふまえて答えてください。',
  '答えは耳で聞いてすぐわかる日本語の話し言葉で、2〜4文・200字以内。箇条書き・記号・URL・英語の略語の羅列は使わない。',
  '記事に書いていないことは一般的な知識で補ってよいが、最近の出来事で確かでないことは「記事の時点では」などと断る。',
  '質問の聞き取りが崩れていても、記事の内容から意図をくみ取って答える。',
].join('\n');

// Claude との会話用: その日の記事を素の文字で返す(GET ?k=news|trivia &d=日付 [&n=番号])。
// Claude アプリにこの URL を渡すと、読んでから音声で話し相手になってくれる。中身はアプリで公開している記事と同じ
const GENRE: Record<string, string> = { food: '食べ物', word: '言葉', thing: 'モノ', psych: '心理学', season: '季語', history: '歴史', science: '科学', culture: '文化', sports: 'スポーツ' };
function triviaText(d: any) {
  const out = ['題: ' + clean(d.title)];
  if (d.gist) out.push('ひとことで: ' + clean(d.gist));
  for (const s of d.sections || []) out.push((s.h ? '【' + clean(s.h) + '】' : '') + (Array.isArray(s.p) ? s.p : [s.p]).filter(Boolean).map(clean).join(''));
  if (d.talk) out.push('会話で使える一言: ' + clean(d.talk));
  if (d.extra?.text) out.push('【' + clean(d.extra.label || 'ひとこと') + '】' + clean(d.extra.text));
  const q = d.quiz;
  if (q?.q && Array.isArray(q.choices)) out.push('クイズ: ' + clean(q.q) + ' 選択肢: ' + q.choices.map((c: string, i: number) => (i + 1) + '.' + clean(c)).join(' ') + ' 答え: ' + clean(q.choices[q.answer] ?? '') + (q.why ? '(' + clean(q.why) + ')' : ''));
  return out.join('\n');
}
async function newsText(url: URL) {
  const kind = url.searchParams.get('k') === 'trivia' ? 'trivia' : 'news';
  const name = kind === 'news' ? 'ニュース' : '雑学';
  let date = url.searchParams.get('d') || '';
  const n = parseInt(url.searchParams.get('n') || '', 10);
  if (!isDate(date)) {
    const { data } = await db.from('asayomi_days').select('date').eq('kind', kind).order('date', { ascending: false }).limit(1).maybeSingle();
    date = data?.date ?? todayJST();
  }
  let q = db.from('asayomi_items').select('n,data').eq('kind', kind).eq('date', date).order('n');
  if (isN(n)) q = q.eq('n', n);
  const { data: rows } = await q;
  const head = 'あさよみ ' + date + ' の' + name + (isN(n) ? '(' + n + '本目)' : '(' + (rows?.length ?? 0) + '本)');
  const body = (rows ?? []).map((r: any) => {
    const d = r.data || {};
    const tag = kind === 'news' ? (d.catn || CATS[d.cat] || '') : (d.genreLabel || GENRE[d.genre] || '');
    return '■ ' + name + r.n + '本目 [' + tag + ']\n' + (kind === 'news' ? articleText(d) : triviaText(d));
  }).join('\n\n');
  return new Response(head + '\n\n' + (body || 'この日の' + name + 'は見つかりませんでした。') + '\n', {
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

/* ---------- 入口 ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method === 'GET') return newsText(new URL(req.url));
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  try {
    switch (body.action) {
      // その日の音声の一覧(できているもの・作っている最中のもの)
      case 'status': {
        if (!isDate(body.date)) return json({ error: 'bad date' }, 400);
        const [{ data: rows }, key, lastErr] = await Promise.all([
          db.from('asayomi_audio').select('n,path,dur,claimed_at').eq('kind', kindOf(body.kind)).eq('date', body.date),
          getSecret('gemini_key'),
          getSecret('last_error'),
        ]);
        const pub = (p: string) => db.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
        return json({
          ready: !!key,
          lastError: (() => { try { const e = JSON.parse(lastErr || 'null'); return e ? { at: e.at, where: e.where } : null; } catch { return null; } })(),
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
        if (!/^[A-Za-z0-9_.-]{20,120}$/.test(key)) return json({ error: 'キーの形がちがうようです', code: 'key' }, 400);
        const r = await listModels(key);
        if (!r.ok) { await logErr('set-key', 'status ' + r.status); return json({ error: 'このキーは使えないようです(' + r.status + ')', code: 'key', status: r.status }, 400); }
        await setSecret('gemini_key', key);
        await setSecret('gemini_models', JSON.stringify(r.models));
        return json({ ok: true });
      }

      // 1本ぶんの声を作って、生の音(24kHz・16bit・1ch)を base64 で返す
      case 'tts': {
        const { date, n } = body;
        const kind = kindOf(body.kind);
        if (!isDate(date) || !isN(n)) return json({ error: 'bad item' }, 400);
        const { data: row } = await db.from('asayomi_audio').select('path,claimed_at').eq('kind', kind).eq('date', date).eq('n', n).maybeSingle();
        if (row?.path) return json({ done: true });
        if (row?.claimed_at && Date.now() - Date.parse(row.claimed_at) < 4 * 60e3 && !body.force) return json({ busy: true });
        const d = await itemOf(kind, date, n);
        if (!d) return json({ error: 'no item' }, 404);
        const key = await getSecret('gemini_key');
        if (!key) return json({ error: 'キーが未登録です', code: 'nokey' }, 400);
        if (!(await count('tts'))) return json({ error: '今日の読み上げの回数の上限です', code: 'cap' }, 429);
        await db.from('asayomi_audio').upsert({ kind, date, n, claimed_at: new Date().toISOString() });
        const models = await modelsFor(key);
        const r = await synth(key, models.tts, speechOf(kind, d, n, n === 1 ? await countOf(kind, date) : 0),
          kind === 'news' ? '落ち着いて聞き取りやすい、ニュースの読み上げ' : '友だちに話すような、明るく楽しい語り');
        if (!r.ok) {
          await db.from('asayomi_audio').update({ claimed_at: null }).eq('kind', kind).eq('date', date).eq('n', n).is('path', null);
          return json({ error: r.code === 'quota' ? 'Gemini の無料枠を使い切りました' : r.code === 'key' ? 'キーが使えなくなりました' : '声を作れませんでした', code: r.code }, r.code === 'quota' ? 429 : 502);
        }
        await setSecret('last_ok', JSON.stringify({ at: new Date().toISOString(), where: 'tts', model: r.model }));
        await db.from('asayomi_secret').delete().eq('k', 'last_error'); // うまくいったので、前のエラーの表示は消す
        return json({ pcm: r.pcm, rate: r.rate, model: r.model });
      }

      // 端末が作った mp3 を置く
      case 'put': {
        const { date, n } = body;
        const kind = kindOf(body.kind);
        const dur = Number(body.dur);
        if (!isDate(date) || !isN(n) || !(dur > 0 && dur < 1200) || typeof body.mp3 !== 'string') return json({ error: 'bad put' }, 400);
        const { data: row } = await db.from('asayomi_audio').select('path').eq('kind', kind).eq('date', date).eq('n', n).maybeSingle();
        if (!row) return json({ error: 'not claimed' }, 409);
        if (row.path) return json({ ok: true, dup: true });
        const bytes = Uint8Array.from(atob(body.mp3), (c) => c.charCodeAt(0));
        if (bytes.length < 1000 || bytes.length > 6 * 1024 * 1024) return json({ error: 'bad size' }, 400);
        const path = kind + '/' + date + '/' + n + '-' + crypto.randomUUID().slice(0, 8) + '.mp3';
        const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'audio/mpeg', cacheControl: '31536000' });
        if (up.error) return json({ error: up.error.message }, 500);
        await db.from('asayomi_audio').update({ path, dur, bytes: bytes.length, model: String(body.model ?? '').slice(0, 60), claimed_at: null }).eq('kind', kind).eq('date', date).eq('n', n);
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
        const kind = kindOf(body.kind);
        const q = String(body.q ?? '').trim().slice(0, 400);
        if (!isDate(date) || !isN(n) || !q) return json({ error: 'bad ask' }, 400);
        const d = await itemOf(kind, date, n);
        if (!d) return json({ error: 'no item' }, 404);
        const key = await getSecret('gemini_key');
        if (!key) return json({ error: 'キーが未登録です', code: 'nokey' }, 400);
        if (!(await count('ask'))) return json({ error: '今日の質問の回数の上限です', code: 'cap' }, 429);
        const near = clean(body.near ?? '').slice(0, 600);
        const prev = (Array.isArray(body.history) ? body.history : []).slice(-4)
          .map((x: any) => 'Q: ' + clean(x?.q).slice(0, 200) + '\nA: ' + clean(x?.a).slice(0, 300)).join('\n');
        const prompt = [
          (kind === 'news' ? 'ニュースの記事' : '雑学の記事') + '(' + date + ' 配信):', kind === 'news' ? articleText(d) : triviaText(d), '',
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
            generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }, // 考える分も枠に入るので多めに
          }),
        }));
        if (!r.ok) {
          await logErr('ask', r.code + ' ' + (r.status ?? '') + ' ' + (r.msg ?? ''));
          return json({ error: r.code === 'quota' ? 'Gemini の無料枠を使い切りました' : r.code === 'key' ? 'キーが使えなくなりました' : '答えを作れませんでした', code: r.code }, r.code === 'quota' ? 429 : 502);
        }
        const parts = r.data?.candidates?.[0]?.content?.parts ?? [];
        const a = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('').trim();
        if (!a) { await logErr('ask', 'empty ' + JSON.stringify(r.data).slice(0, 400)); return json({ error: '答えを作れませんでした', code: 'ai' }, 502); }
        return json({ a, model: r.model });
      }
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    await logErr(String(body.action), String((e as Error)?.stack ?? e));
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
