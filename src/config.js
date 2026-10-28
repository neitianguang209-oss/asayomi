// 接続先と決めごと。ここにあるキーは公開用(読むだけ＋決まった関数だけ呼べる)。
export const VERSION = '1.5.0';
export const SB_URL = 'https://gzayrjlhruhvklsidraw.supabase.co';
export const SB_KEY = 'sb_publishable_-sNQxpwsU7JxhPF9S2vn5A_-CCTqQZL';

// 思考メモへ送るリンクに使う(どの端末・どのURLで開いていても同じ行き先にする)
export const APP_URL = 'https://neitianguang209-oss.github.io/asayomi/';
// 思考メモの「知識」タグ
export const MEMO_TAG = 'b4db2c80-e9d3-46b5-9d4d-62b58c051e4b';

export const GENRES = {
  food: { label: '食べ物', color: '#e07a1f' },
  word: { label: '言葉', color: '#4757c9' },
  thing: { label: 'モノ', color: '#16877f' },
  psych: { label: '心理学', color: '#c43d6a' },
  season: { label: '季語', color: '#4a8a33' },
  history: { label: '歴史', color: '#8c5a2e' },
  science: { label: '科学', color: '#2a72c2' },
  culture: { label: '文化', color: '#7a4bc4' },
  sports: { label: 'スポーツ', color: '#d13b30' },
};
export const CATS = {
  world: { label: '世界', color: '#0f9b8e' },
  japan: { label: '日本', color: '#e8384f' },
  ai: { label: 'AI', color: '#7a55f0' },
};

// 復習の間隔(日)。正解するたびに1段上がり、4段目から「覚えた」に数える。
export const INTERVALS = [1, 2, 5, 12, 30, 90];
export const MASTERED = 4;
