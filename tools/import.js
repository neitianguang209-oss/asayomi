// 過去分の取り込み(1回きりの作業用)。
//   雑学  : OneDrive に残っていたテキスト版(trivia-YYYY-MM-DD.md)＋履歴(trivia-history.md)＋最新のJSON
//   ニュース: これまでに公開したページ(HTML)
// tools/data/ にコピーしたファイルを読み、アプリ用の形に直して Supabase へ送る。
import { SB_URL, SB_KEY } from '../src/config.js';

const Imp = (window.Imp = { token: null, built: {}, log: [] });
const HEAD = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const jDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + DOW[d.getUTCDay()] + '）'; };
const text = async (path) => { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw new Error(path + ' ' + r.status); return r.text(); };

try { Imp.token = sessionStorage.getItem('imp-token'); } catch (e) { /* なければ newToken で作る */ }
Imp.newToken = async () => {
  Imp.token = crypto.randomUUID() + crypto.randomUUID();
  sessionStorage.setItem('imp-token', Imp.token);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Imp.token));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
};
async function post(p) {
  const res = await fetch(SB_URL + '/rest/v1/rpc/asayomi_import', { method: 'POST', headers: HEAD, body: JSON.stringify({ p_token: Imp.token, p }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || 'HTTP ' + res.status);
  return j;
}
Imp.send = async (name) => {
  const out = [];
  for (const p of Imp.built[name] || []) {
    try { const r = await post(p); out.push(p.date + ':' + r.items + (r.warnings && r.warnings.length ? '!' : '')); }
    catch (e) { out.push(p.date + ':ERR ' + e.message); }
  }
  return out;
};

/* =====================================================================
   雑学(以前のテキスト版)
   ===================================================================== */
function genreOf(label) {
  const rules = [
    [/花言葉|季語|美しい|暦/, 'season'], // 「花言葉」「美しい言葉」を「言葉」より先に見る
    [/食べ物|飲み物/, 'food'], [/言葉|語源|カタカナ|和製英語|慣用/, 'word'], [/モノ|身近/, 'thing'], [/心理/, 'psych'],
    [/歴史|偉人/, 'history'], [/科学|自然|宇宙|人体|動物|植物/, 'science'],
    [/文化|世界/, 'culture'], [/スポーツ|エンタメ|芸能|映画/, 'sports'],
  ];
  const first = label.split(/[・（(／/]/)[0];
  for (const [re, g] of rules) if (re.test(first)) return g;
  for (const [re, g] of rules) if (re.test(label)) return g;
  return 'word';
}
function parseHistory(md) {
  const days = [];
  let cur = null;
  for (const line of md.replace(/\r/g, '').split('\n')) {
    let m = /^## (\d{4}-\d{2}-\d{2})(?:（.）)?\s*(②)?/.exec(line);
    if (m) { cur = { date: m[1], second: !!m[2], lines: [] }; days.push(cur); continue; }
    m = /^(\d)\.\s*(.+)$/.exec(line);
    if (m && cur) cur.lines[+m[1] - 1] = m[2].trim();
  }
  return days;
}
function splitHistory(line) {
  const i = line.indexOf('：');
  const label = i > 0 ? line.slice(0, i).trim() : '雑学';
  const topic = i > 0 ? line.slice(i + 1).trim() : line;
  return { label, topic };
}
const LABELS = [
  [/^[＋+]\s*one\s*[：:]\s*/i, '＋one'],
  [/^会話で使える一言\s*[：:]\s*/, 'talk'],
  [/^考えてみると…?\s*[：:]?\s*/, '考えてみると…'],
  [/^英語表現\s*[：:]\s*/, '英語表現'],
  [/^ミニ雑学\s*[：:]\s*/, 'ミニ雑学'],
];
function parseMd(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const headRe = /^#{2,3}\s*(\d)\s*[\.．、]\s*(.+?)\s*$/;
  const pickRe = /^(?:#{1,4}\s*|\*\*|【)?\s*今日のひとこと\s*(?:\*\*|】)?\s*[：:]?\s*(.*)$/;
  const out = { intro: [], items: [], pick: [] };
  let mode = 'head';
  let cur = null;
  let seenFirst = false;
  for (const raw of lines) {
    const line = raw.trim();
    const hm = headRe.exec(line);
    if (hm) { cur = { title: hm[2].replace(/\*\*/g, ''), body: [] }; out.items.push(cur); mode = 'item'; continue; }
    const pm = pickRe.exec(line);
    if (pm && mode !== 'head') { mode = 'pick'; if (pm[1]) out.pick.push(pm[1].replace(/^\*\*|\*\*$/g, '')); continue; }
    if (!line || /^-{3,}$/.test(line)) continue;
    if (mode === 'head') {
      // 題とあいさつの行は作り直すので読み飛ばす
      if (!seenFirst || /^#\s/.test(line) || (/おはようございます/.test(line) && /雑学/.test(line))) { seenFirst = true; continue; }
      out.intro.push(line);
    } else if (mode === 'item') cur.body.push(line);
    else out.pick.push(line);
  }
  for (const it of out.items) {
    it.paras = [];
    it.talk = null;
    it.extra = null;
    for (const b of it.body) {
      let hit = null;
      for (const [re, label] of LABELS) if (re.test(b)) { hit = [label, b.replace(re, '').trim()]; break; }
      if (!hit) { it.paras.push(b); continue; }
      if (hit[0] === 'talk') it.talk = hit[1];
      else if (!it.extra) it.extra = { label: hit[0], text: hit[1] };
      else it.extra.text += '\n' + hit[1];
    }
    // 1段落に詰まっている長い本文は、スマホで読みやすいよう真ん中あたりの文の切れ目で2つに分ける
    if (it.paras.length === 1 && it.paras[0].length > 230) it.paras = splitPara(it.paras[0]);
  }
  return out;
}
function splitPara(s) {
  const cuts = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('「『（('.indexOf(c) >= 0) depth++;
    else if ('」』）)'.indexOf(c) >= 0) depth = Math.max(0, depth - 1);
    else if (c === '。' && depth === 0 && i < s.length - 1) cuts.push(i + 1);
  }
  if (!cuts.length) return [s];
  const mid = s.length / 2;
  const at = cuts.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best), cuts[0]);
  if (at < 70 || s.length - at < 70) return [s];
  return [s.slice(0, at).trim(), s.slice(at).trim()];
}

Imp.buildTriviaLegacy = async () => {
  const hist = parseHistory(await text('data/trivia/trivia-history.md'));
  const byDate = new Map();
  const notes = [];
  for (const hd of hist) {
    if (hd.date >= '2026-10-09') continue; // 10/9 以降は絵つきのJSONから入れる
    let md = null;
    try { md = parseMd(await text('data/trivia/trivia-' + hd.date + (hd.second ? '-b' : '') + '.md')); }
    catch (e) { md = null; }
    if (md && !md.items.length) md = null; // ファイルが無いと別のページが返ってくるので、中身で確かめる
    if (!md) notes.push(hd.date + ': テキスト版なし(履歴だけ取り込み)');
    if (md && md.items.length !== hd.lines.filter(Boolean).length) notes.push(hd.date + ': 本数が合わない md=' + md.items.length + ' hist=' + hd.lines.length);
    const count = md ? md.items.length : hd.lines.length;
    const items = [];
    for (let i = 0; i < count; i++) {
      const hl = hd.lines[i] ? splitHistory(hd.lines[i]) : { label: '雑学', topic: '' };
      const mi = md ? md.items[i] : null;
      const title = mi ? mi.title : hl.topic.replace(/（.*$/, '');
      if (mi && !mi.paras.length) notes.push(hd.date + '#' + (i + 1) + ': 本文なし');
      items.push({
        genre: genreOf(hl.label), genreLabel: hl.label.replace(/（.*?）/g, ''), keyword: null, title,
        gist: hl.topic || null,
        sections: mi && mi.paras.length ? [{ h: null, p: mi.paras }] : [],
        talk: mi ? mi.talk : null, extra: mi ? mi.extra : null,
        legacy: true, history: hd.lines[i] || title,
      });
    }
    let p = byDate.get(hd.date);
    if (!p) {
      p = {
        kind: 'trivia', date: hd.date,
        day: { greeting: 'おはようございます、ひかるさん。' + jDate(hd.date) + 'の雑学です。', intro: md ? md.intro.join(' ') : null,
          pick: md && md.pick.length ? { title: ((/「(.{2,24}?)」/.exec(md.pick[0]) || [])[1] || '').replace(/^\d+[\.．]\s*/, '') || null, text: md.pick.join(' ') } : null, legacy: true },
        items: [],
      };
      byDate.set(hd.date, p);
    }
    for (const it of items) { it.n = p.items.length + 1; p.items.push(it); } // 同じ日に2回配信があった日(8/19)は続き番号で足す
  }
  Imp.built.triviaLegacy = Array.from(byDate.values());
  return { days: byDate.size, items: Imp.built.triviaLegacy.reduce((a, p) => a + p.items.length, 0), notes };
};

// 絵つきのJSON(10/9=テンプレートに入っていた分、10/10=today.json)。quiz と history を足して入れる。
Imp.buildTriviaJson = async (extras) => {
  const hist = parseHistory(await text('data/trivia/trivia-history.md'));
  const tpl = await text('data/trivia/template.html');
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(tpl);
  const sets = [JSON.parse(m[1])];
  try { sets.push(JSON.parse(await text('data/trivia/today.json'))); } catch (e) { /* 無ければ 10/9 だけ */ }
  Imp.built.triviaJson = sets.map((D) => {
    const hd = hist.find((x) => x.date === D.date);
    const ex = (extras && extras[D.date]) || [];
    return {
      kind: 'trivia', date: D.date,
      day: { greeting: D.greeting, pick: D.pick || null },
      items: D.items.map((it, i) => Object.assign({}, it, { history: hd && hd.lines[i] ? hd.lines[i] : it.title, quiz: ex[i] || undefined })),
    };
  });
  return Imp.built.triviaJson.map((p) => p.date + ':' + p.items.length + ' svg=' + p.items.filter((x) => x.svg).length);
};

/* =====================================================================
   ニュース
   ===================================================================== */
// <mark> <em class="kw"> <b> を、アプリの記法(== ** [[ ]])へ
function toMarkup(html) {
  return String(html || '')
    .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '[[$1]]')
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}
// いまの形(10/9〜)のページ: 中のデータ(A・ILL・RANK・EARN)を、外に触れない枠の中で動かして受け取る
function runPage(html) {
  return new Promise((resolve, reject) => {
    const probe = '<script>try{parent.postMessage({ok:1,A:A,ILL:ILL,RANK:RANK,EARN:EARN,lead:(function(){render("top");var e=document.querySelector(".leadline");return e?e.innerHTML:""})(),src:(function(){var a=document.querySelectorAll("details.src a"),o=[];for(var i=0;i<a.length;i++)o.push([a[i].textContent,a[i].getAttribute("href")]);return o})()},"*")}catch(e){parent.postMessage({ok:0,err:String(e)},"*")}<\/script>';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.display = 'none';
    const done = (e) => {
      if (e.source !== f.contentWindow) return;
      window.removeEventListener('message', done);
      f.remove();
      if (e.data && e.data.ok) resolve(e.data); else reject(new Error((e.data && e.data.err) || 'page error'));
    };
    window.addEventListener('message', done);
    f.srcdoc = html.replace(/<\/body>/i, probe + '</body>');
    document.body.append(f);
    setTimeout(() => { window.removeEventListener('message', done); f.remove(); reject(new Error('timeout')); }, 8000);
  });
}
function parseEarn(html) {
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const events = Array.from(doc.querySelectorAll('.ev')).map((ev) => ({
    when: (ev.querySelector('.evd') || {}).textContent || '',
    name: (ev.querySelector('.evn') || {}).textContent || '',
    hot: !!ev.querySelector('.hot'),
    points: Array.from(ev.querySelectorAll('li')).map((li) => toMarkup(li.innerHTML)),
  }));
  const sub = doc.querySelector('.es');
  const note = doc.querySelector('.enote');
  return { sub: sub ? sub.textContent : null, events, note: note ? toMarkup(note.innerHTML) : null };
}
Imp.buildNewsNew = async (files, extras) => {
  const out = [];
  for (const [file, date] of files) {
    const d = await runPage(await text('data/news/' + file + '.html'));
    const ex = (extras && extras[date]) || {};
    const itemLinks = new Set();
    const items = d.A.map((a, i) => {
      (a.links || []).forEach((l) => itemLinks.add(l[1]));
      const x = (ex.items && ex.items[i]) || {};
      return {
        cat: a.cat, catn: a.catn, role: a.role, isNew: !!a.isNew, src: a.src, title: a.title,
        gist: x.gist || null, lede: toMarkup(a.lede),
        secs: (a.secs || []).map((s) => ({ h: s[0], p: toMarkup(s[1]) })),
        terms: a.terms || [], life: toMarkup(a.life), links: a.links || [],
        thread: x.thread || null, keywords: x.keywords || undefined,
        svg: d.ILL[a.ill] || null,
      };
    });
    const earn = parseEarn(d.EARN);
    (ex.earnDates || []).forEach((iso, i) => { if (earn.events[i] && iso) earn.events[i].date = iso; });
    out.push({
      kind: 'news', date,
      day: { lead: toMarkup(d.lead.replace(/^<b>[\s\S]*?<\/b>/, '')), rank: d.RANK, earn, sources: d.src.filter((l) => !itemLinks.has(l[1])) },
      items,
    });
  }
  Imp.built.newsNew = out;
  return out.map((p) => p.date + ':' + p.items.length + ' svg=' + p.items.filter((x) => x.svg).length + ' ev=' + p.day.earn.events.length + ' | ' + p.items.map((x, i) => (i + 1) + '.' + x.title).join(' / '));
};

// ---------------------------------------------------------------------
// 以前の形のページ(9/18〜10/8)。日によって作りが違うので、共通している手がかりで読む:
//   「01」〜「08」の番号 → その番号だけを含むいちばん外側の箱が1本分 → 見出し(h要素)・役割(chip)・
//   本文(p)・用語(gloss/note)・暮らしに効く(callout)・出典(a)。
// イラストは無い時期なので、文章だけ取り込む。
// ---------------------------------------------------------------------
Imp.doc = async (file) => new DOMParser().parseFromString(await text('data/news/' + file + '.html'), 'text/html');
const cls = (e) => String(e.getAttribute('class') || '');
const insideClass = (e, re, stop) => { for (let p = e; p && p !== stop; p = p.parentElement) if (re.test(cls(p))) return true; return false; };
const RE_NOTE = /(^|[\s-])(gloss|note|term|terms)($|[\s-])/;
const RE_LIFE = /(^|[\s-])(call|callout|life)($|[\s-])/;
const RE_LABEL = /(^|[\s-])(lbl|lab|lb|label|tl)($|[\s-])/;
function inline(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  c.querySelectorAll('b,strong').forEach((b) => b.replaceWith('**' + b.textContent + '**'));
  c.querySelectorAll('mark').forEach((b) => b.replaceWith('==' + b.textContent + '=='));
  return c.textContent.replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
function splitTerms(s) {
  const out = [];
  for (const part of s.split(/\n|／|(?<=。)\s+/)) {
    const m = /^[・\s]*(.{1,28}?)\s*(?:＝|=|：|:|…|とは、?)\s*(.{4,})$/.exec(part.trim());
    if (m) out.push([m[1].replace(/^[「『]|[」』]$/g, ''), m[2].trim()]);
  }
  return out;
}
function legacyItems(doc) {
  const all = Array.from(doc.body.querySelectorAll('*'));
  const nums = all.filter((e) => !e.children.length && /^0[1-8]$/.test(e.textContent.trim()));
  const items = [];
  for (let k = 1; k <= 8; k++) {
    const mine = nums.filter((e) => +e.textContent.trim() === k);
    const others = nums.filter((e) => +e.textContent.trim() !== k);
    const scopes = [];
    for (const lf of mine) {
      let c = lf;
      while (c.parentElement && c.parentElement !== doc.body && !others.some((o) => c.parentElement.contains(o))) c = c.parentElement;
      if (scopes.indexOf(c) < 0) scopes.push(c);
      const sib = c.nextElementSibling; // 詳細が隣に置かれている形
      if (c.textContent.trim().length < 160 && sib && !nums.some((o) => sib.contains(o)) && sib.textContent.trim().length > 80 && scopes.indexOf(sib) < 0) scopes.push(sib);
    }
    if (!scopes.length) continue;
    const q = (sel) => { for (const s of scopes) { const e = s.matches(sel) ? s : s.querySelector(sel); if (e) return e; } return null; };
    const qa = (sel) => scopes.reduce((a, s) => a.concat(Array.from(s.querySelectorAll(sel))), []);
    const skipRe = /(^|[\s-])(meta|rmeta|smeta|secmeta|metaline|metatxt|chip|role|tag|sect|src|date|num|no|thumb|badge|cat|kw|new)($|[\s-])/;
    const leafish = (e) => !e.querySelector('div,p,ul,ol,li,section,article,h1,h2,h3,h4,details');
    const plainLen = (e) => e.textContent.replace(/\s+/g, ' ').trim().length;
    const fenced = (e) => scopes.some((s) => s.contains(e) && (insideClass(e, RE_NOTE, s.parentElement) || insideClass(e, RE_LIFE, s.parentElement)));
    // 見出し: h要素 → それらしいクラス名 → 12〜80字の短い一文、の順に探す
    const okTitle = (e) => e && plainLen(e) >= 8 && plainLen(e) <= 90 && !nums.some((o) => e.contains(o));
    const headRe = /(^|\s)([a-z]+-)?(h|hl|title|ttl|headline|rh|rhead|rttl|rowtitle)(\s|$)/;
    let titleEl = [q('h1,h2,h3,h4')].concat(qa('*').filter((e) => headRe.test(cls(e)))).find(okTitle) || null;
    if (!titleEl) {
      titleEl = qa('*').find((e) => leafish(e) && e.tagName !== 'P' && !e.closest('p') && !skipRe.test(cls(e)) && !fenced(e) &&
        !e.querySelector('[class*="chip"],[class*="badge"],[class*="num"]') &&
        plainLen(e) >= 12 && plainLen(e) <= 80 && !/^(暮らしに効く|用語)/.test(e.textContent.trim())) || null;
    }
    const roleEl = qa('[class*="chip"],[class*="role"],[class*="tag"]').find((e) => {
      const tx = e.textContent.trim();
      return !e.children.length && tx && !/^NEW$/i.test(tx) && !/^\d+$/.test(tx) && !/^LEAD$/i.test(tx);
    });
    const isNew = qa('*').some((e) => !e.children.length && /^NEW$/i.test(e.textContent.trim()));
    const paras = [];
    for (const s of scopes) {
      for (const p of s.querySelectorAll('p')) {
        if (insideClass(p, RE_NOTE, s.parentElement) || insideClass(p, RE_LIFE, s.parentElement) || p === titleEl || p.contains(titleEl)) continue;
        const tx = inline(p);
        if (tx.length > 12) tx.split('\n').forEach((x) => { if (x.trim()) paras.push(x.trim()); });
      }
    }
    if (!paras.length) { // 本文が p でない日: 80字を超える文のかたまりを本文として読む
      for (const e of qa('*')) {
        if (e === titleEl || fenced(e) || skipRe.test(cls(e)) || (titleEl && e.contains(titleEl))) continue;
        const own = e.cloneNode(true); // 中に入っている用語・暮らしに効くの箱などは外して、その要素じかの文だけを見る
        own.querySelectorAll('div,p,ul,ol,section,details,h1,h2,h3,h4').forEach((x) => x.remove());
        const tx = inline(own);
        if (tx.length > 80) tx.split('\n').forEach((x) => { if (x.trim().length > 12) paras.push(x.trim()); });
      }
    }
    const terms = [];
    const notes = [];
    for (const e of qa('*')) {
      if (!RE_NOTE.test(cls(e)) || e.closest('p')) continue; // 本文の中に埋め込まれた補足は本文のまま読む
      if (e.parentElement && scopes.some((s) => s.contains(e.parentElement) && insideClass(e.parentElement, RE_NOTE, s.parentElement))) continue;
      const tx = e.textContent.replace(/[ \t\u3000]+/g, ' ').trim().replace(/^(用語メモ|用語|ことば|メモ)\s*[：:]?\s*/, '');
      const got = splitTerms(tx);
      if (got.length) got.forEach((x) => terms.push(x)); else if (tx.length > 8) notes.push(tx);
    }
    let life = null;
    let lifeLabel = null;
    const lifeEl = qa('*').find((e) => RE_LIFE.test(cls(e)));
    if (lifeEl) {
      const c = lifeEl.cloneNode(true);
      let lab = Array.from(c.querySelectorAll('*')).find((e) => RE_LABEL.test(cls(e)));
      if (!lab) { // クラス名の無いラベル: 先頭にある短い太字だけをラベルとみなす
        const first = c.firstElementChild;
        const lead = c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.textContent.trim() : '';
        if (first && !lead && /^(B|STRONG|SPAN)$/.test(first.tagName) && first.textContent.trim().length <= 14) lab = first;
      }
      if (lab) { lifeLabel = lab.textContent.replace(/^[◆●■▶\s]+/, '').trim(); lab.remove(); }
      life = inline(c).replace(/\n+/g, ' ').replace(/^[：:\s]+/, '');
    }
    // カテゴリ: 6〜8本目はいつもAI。1〜5本目は日によって並びが違うので、クラス名や「世界 · 9/23」のような表示から読む
    let cat = k >= 6 ? 'ai' : null;
    if (!cat) {
      const tokens = new Set();
      for (const s of scopes) for (const e of [s].concat(Array.from(s.querySelectorAll('*')))) cls(e).split(/\s+/).forEach((x) => tokens.add(x));
      const has = (list) => list.some((x) => tokens.has(x));
      if (has(['world', 't-world', 'th-world', 'role-w', 'w', 's-world'])) cat = 'world';
      else if (has(['japan', 't-japan', 'th-japan', 'role-j', 'j', 's-japan', 't-econ', 'th-econ'])) cat = 'japan';
    }
    if (!cat) {
      const sec = scopes[0].closest('[class*="s-world"],[class*="s-japan"]');
      if (sec) cat = /s-world/.test(cls(sec)) ? 'world' : 'japan';
    }
    if (!cat) {
      const metaText = qa('*').filter((e) => /sect|secmeta|sec-date|metaline|metatxt|smeta|hero-meta|src-meta|msrc/.test(cls(e))).map((e) => e.textContent).join(' ') + ' ' + (roleEl ? roleEl.textContent : '');
      if (/世界|国際|WORLD|海外|中東|南米|アフリカ|欧州|北欧/i.test(metaText)) cat = 'world';
      else if (/日本|国内|JAPAN|経済|政治|社会|スポーツ|産業|業界|セクター|暮らし|生活/i.test(metaText)) cat = 'japan';
    }
    if (!cat) cat = k <= 2 ? 'world' : 'japan';
    const links = qa('a[href^="http"]').map((a) => [a.textContent.trim() || a.getAttribute('href'), a.getAttribute('href')]);
    items.push({
      cat,
      k, title: titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim().replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').replace(/^［[^］]{1,14}］\s*/, '') : '', role: roleEl ? roleEl.textContent.replace(/^[\u2460-\u2473]\s*/, '').trim() : '',
      isNew, paras, terms, notes, life, lifeLabel, links,
    });
  }
  return items;
}
function legacyDay(doc) {
  const leadEl = doc.querySelector('[class*="lede"],[class*="lead"],[class*="intro"]');
  const links = Array.from(doc.querySelectorAll('details a[href^="http"], [class*="source"] a[href^="http"], [class*="src"] a[href^="http"]'))
    .map((a) => [a.textContent.trim() || a.getAttribute('href'), a.getAttribute('href')]);
  return { lead: leadEl ? leadEl.textContent.replace(/\s+/g, ' ').trim() : null, links };
}
// files: [[ファイル名, 配信日(日本時間)], ...]  threads: (見出し) => 話題の名前 か null
Imp.buildNewsLegacy = async (files, threadOf) => {
  const out = [];
  const report = [];
  for (const [file, date] of files) {
    const doc = await Imp.doc(file);
    const raw = legacyItems(doc);
    const day = legacyDay(doc);
    const used = new Set();
    const items = raw.map((r) => {
      r.links.forEach((l) => used.add(l[1]));
      const cat = r.cat;
      const catn = { world: '世界', japan: '日本', ai: 'AI' }[cat];
      const paras = r.paras.slice();
      return {
        n: r.k, cat, catn, role: r.role, isNew: r.isNew, src: null, title: r.title, gist: null,
        lede: null, secs: paras.length ? [{ h: null, p: paras }] : [],
        terms: r.terms, note: r.notes.join(' ') || null, life: r.life, lifeLabel: r.lifeLabel && r.lifeLabel !== '暮らしに効く' ? r.lifeLabel : undefined,
        links: r.links, thread: threadOf ? threadOf(r.title) : null, legacy: true,
      };
    });
    out.push({ kind: 'news', date, day: { lead: day.lead, sources: day.links.filter((l) => !used.has(l[1])), legacy: true }, items });
    report.push(file + '→' + date.slice(5) + ' n=' + items.length + ' lead=' + (day.lead ? day.lead.length : 0) + ' src=' + day.links.length + '\n' +
      raw.map((r) => '  ' + r.k + ' [' + r.role + '] ' + r.title.slice(0, 26) + ' | p=' + r.paras.length + '/' + r.paras.join('').length + ' t=' + r.terms.length + ' n=' + r.notes.length + ' life=' + (r.life ? r.life.length : 0) + (r.lifeLabel ? '(' + r.lifeLabel + ')' : '') + ' a=' + r.links.length).join('\n'));
  }
  Imp.built.newsLegacy = out;
  return report.join('\n');
};
