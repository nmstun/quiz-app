/**
 * 咲登クイズ 回帰テスト
 *
 *   node test.js
 *
 * ブラウザを使わず、index.html と同じ構造の DOM スタブ上で script.js を実行し、
 * 出題ロジック・採点・画面状態の遷移をまとめて検証する。
 * ビルド不要のアプリなので、依存を増やさず素の Node だけで動くようにしている。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + extra : '')); }
}

// ---------- DOM スタブ ----------
function makeEl(id, classes = []) {
  const el = {
    id, _text: '', _html: '', value: '', disabled: false, style: {},
    inputMode: '', placeholder: '', offsetWidth: 0,
    _listeners: {}, _children: [], dataset: {}, _attrs: {},
    classList: {
      _set: new Set(classes),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return el._attrs[k]; },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    click() { if (el.disabled) return; (el._listeners['click'] || []).forEach(fn => fn({})); },
    focus() { (el._listeners['focus'] || []).forEach(fn => fn({})); },
    blur() { (el._listeners['blur'] || []).forEach(fn => fn({})); },
    appendChild(c) { el._children.push(c); },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el.classList._set).join(' '); },
    set(v) { el.classList._set = new Set(String(v).split(' ').filter(Boolean)); }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el._html = String(v); el._children = []; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); el._text = ''; if (v === '') el._children = []; }
  });
  Object.defineProperty(el, 'children', { get() { return el._children; } });
  return el;
}

function seg(dataKey, dataVal, active) {
  const b = makeEl('seg-' + dataVal, active ? ['segmented-btn', 'active'] : ['segmented-btn']);
  b.dataset[dataKey] = dataVal;
  return b;
}

const CATEGORY_TYPES = ['arith', 'kanji', 'pref', 'map', 'riddle', 'ms', 'kara', 'smash', 'master'];

// index.html と同じ構成のスタブを組み立てて script.js を実行する
function buildApp(opts = {}) {
  const ids = ['appVersion', 'progress', 'progressCount', 'questionBox', 'question', 'statusLine',
    'answerDisplay', 'controls', 'micBtn', 'micIcon', 'micLabel', 'textInput', 'submitBtn',
    'choiceList', 'note', 'courseView', 'quizView', 'resultView', 'scoreText', 'scoreMsg',
    'timeText', 'bestScoreText', 'resultLabel', 'resultList', 'retryBtn', 'courseChangeBtn',
    'quitBtn', 'clearScoresBtn', 'clearScoresMsg', 'seToggleBtn', 'categoryRow',
    'arithGradeField', 'arithGradeRow', 'kanjiGradeField', 'kanjiGradeRow'];
  const els = {};
  ids.forEach(id => els[id] = makeEl(id));
  els.quizView.classList.add('hidden');
  els.resultView.classList.add('hidden');
  els.choiceList.classList.add('hidden');
  els.kanjiGradeField.classList.add('hidden');

  const cats = {};
  CATEGORY_TYPES.forEach((t, i) => cats[t] = seg('type', t, i === 0));
  els.categoryRow.querySelectorAll = () => Object.values(cats);

  const aGrades = {}, kGrades = {};
  ['low', 'mid', 'high'].forEach(g => aGrades[g] = seg('grade', g, g === 'mid'));
  ['low', 'mid', 'high'].forEach(g => kGrades[g] = seg('grade', g, g === 'mid'));
  els.arithGradeRow.querySelectorAll = () => Object.values(aGrades);
  els.kanjiGradeRow.querySelectorAll = () => Object.values(kGrades);

  const courses = {};
  [5, 10, 20].forEach(n => {
    const b = makeEl('course-' + n, ['course-btn']);
    b.dataset.count = String(n);
    courses[n] = b;
  });

  const timers = [];
  let seq = 1;
  const document = {
    getElementById: id => els[id],
    createElement: () => makeEl('dyn'),
    querySelectorAll: sel => sel === '.course-btn' ? Object.values(courses) : [],
    addEventListener() {},
    hidden: false,
    body: makeEl('body')
  };
  const store = opts.store || {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  let now = 0;
  const sandbox = {
    document, window: opts.window || {}, Math, console,
    setTimeout: (fn, ms) => { timers.push({ id: seq, fn, ms, cleared: false }); return seq++; },
    clearTimeout: id => { const t = timers.find(t => t.id === id); if (t) t.cleared = true; },
    parseInt, Array, JSON, String, Set,
    localStorage, confirm: () => true,
    Date: { now: () => now }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return {
    els, cats, aGrades, kGrades, courses, store,
    setNow: v => { now = v; },
    // 保留中(未クリア)のタイマーだけを発火させる
    runTimers() {
      const pending = timers.splice(0, timers.length).filter(t => !t.cleared);
      pending.forEach(t => t.fn());
      return pending.length;
    },
    pendingTimers: () => timers.filter(t => !t.cleared).length
  };
}

// ---------- script.js から正解データを取り出す ----------
const grab = (re, wrap) => { const m = code.match(re); return eval(wrap ? '(' + m[1] + ')' : m[1]); };
const KANJI = grab(/const KANJI_DATA = (\[.*?\]\]);/);
const RIDDLES = grab(/const RIDDLES = (\[[\s\S]*?\]);/);
const PREF = grab(/const PREF_DATA = (\[[\s\S]*?\]);/);
const REGIONS = grab(/const REGIONS = (\{[\s\S]*?\});/, true);
const SYMBOLS = grab(/const MAP_SYMBOLS = (\[[\s\S]*?\]);/);
const MS = grab(/const MS_DATA = (\[[\s\S]*?\]);/);
const KARA = grab(/const KARAPICHI_MEMBERS = (\[[\s\S]*?\]);/);
const SMASH = grab(/const SMASH_FIGHTERS = (\[[\s\S]*?\n  \]);/);
const SMASH_TRIVIA = grab(/const SMASH_TRIVIA = (\[[\s\S]*?\n  \]);/);
const KARA_TRIVIA = grab(/const KARAPICHI_TRIVIA = (\[[\s\S]*?\]);/);

const kanjiBy = {}; KANJI.forEach(k => kanjiBy[k[0]] = k);
const riddleBy = {}; RIDDLES.forEach(r => riddleBy[r.q] = r);
const prefBy = {}; PREF.forEach(p => prefBy[p[0]] = p);
const msByQ = {}; MS.forEach(m => msByQ[m.q] = m);
const msByName = {}; MS.forEach(m => msByName[m.a] = m);
const karaByName = {}; KARA.forEach(m => karaByName[m.name] = m);
const karaTriviaBy = {}; KARA_TRIVIA.forEach(t => karaTriviaBy[t.q] = t.a);
// 「属性値 → その値を持つメンバー」の逆引き。値が重複するものは出題されない想定
const karaByValue = {};
['color', 'birthday', 'zodiac', 'blood', 'like', 'weak'].forEach(key => {
  karaByValue[key] = {};
  KARA.forEach(m => {
    const v = m[key];
    karaByValue[key][v] = karaByValue[key][v] === undefined ? m.name : null; // 重複したら null
  });
});

// からぴちの設問文から「正解」と「どの属性・向きか」を割り出す
const KARA_FORWARD = [
  [/^「(.+?)」のメンバーカラーは\?$/, 'color'],
  [/^「(.+?)」の誕生日は\?$/, 'birthday'],
  [/^「(.+?)」の星座は\?$/, 'zodiac'],
  [/^「(.+?)」の血液型は\?$/, 'blood'],
];
const KARA_REVERSE = [
  [/^メンバーカラーが「(.+?)」なのは\?$/, 'color'],
  [/^(.+?)生まれのメンバーは\?$/, 'birthday'],
  [/^星座が「(.+?)」なのは\?$/, 'zodiac'],
  [/^血液型が「(.+?)」なのは\?$/, 'blood'],
  [/^「(.+?)」が好きなメンバーは\?$/, 'like'],
  [/^「(.+?)」が苦手なメンバーは\?$/, 'weak'],
];
const smashByName = {}; SMASH.forEach(([n, sr]) => smashByName[n] = sr);
const smashBySeries = {};
SMASH.forEach(([n, sr]) => { smashBySeries[sr] = smashBySeries[sr] === undefined ? n : null; });
const smashTriviaBy = {}; SMASH_TRIVIA.forEach(t => smashTriviaBy[t.q] = t.a);
function solveSmash(text) {
  if (smashTriviaBy[text]) return { value: smashTriviaBy[text], kind: 'trivia' };
  let m;
  if ((m = text.match(/^「(.+?)」が出ているゲームシリーズは\?$/)) && smashByName[m[1]]) {
    return { value: smashByName[m[1]], kind: 'fighter/forward' };
  }
  if ((m = text.match(/^「(.+?)」から参戦しているファイターは\?$/)) && smashBySeries[m[1]]) {
    return { value: smashBySeries[m[1]], kind: 'fighter/reverse' };
  }
  return null;
}

function solveKarapichi(text, html) {
  // カラーを色そのもので見せる問題は、SVGのfill(16進カラー)から答えを引く
  if (html && html.includes('symbol-svg')) {
    const m = html.match(/fill="(#[0-9a-fA-F]{6})"/);
    const member = m && KARA.find(x => x.hex.toLowerCase() === m[1].toLowerCase());
    return member ? { value: member.name, kind: 'color/swatch' } : null;
  }
  if (karaTriviaBy[text]) return { value: karaTriviaBy[text], kind: 'trivia' };
  for (const [re, key] of KARA_FORWARD) {
    const m = text.match(re);
    if (m && karaByName[m[1]]) return { value: karaByName[m[1]][key], kind: key + '/forward' };
  }
  for (const [re, key] of KARA_REVERSE) {
    const m = text.match(re);
    if (m && karaByValue[key][m[1]]) return { value: karaByValue[key][m[1]], kind: key + '/reverse' };
  }
  return null;
}

function arithAnswer(t) {
  const m = t.match(/^(-?\d+)\s*([+\-×÷])\s*(-?\d+)\s*=$/);
  if (!m) return null;
  const a = +m[1], b = +m[3];
  return m[2] === '+' ? a + b : m[2] === '-' ? a - b : m[2] === '×' ? a * b : a / b;
}

// 表示中の設問を解析して、正解の入力値(選択式は選ぶべき選択肢)を返す
function solve(app) {
  const text = app.els.question.textContent;
  const html = app.els.question.innerHTML;
  let m;

  if (!app.els.choiceList.classList.contains('hidden')) {
    const kara = solveKarapichi(text, html);
    if (kara) return { kind: 'choice', value: kara.value, karaKind: kara.kind };
    const smash = solveSmash(text);
    if (smash) return { kind: 'choice', value: smash.value, smashKind: smash.kind };
    if ((m = text.match(/^「(.+?)」の型番は\?$/))) return { kind: 'choice', value: msByName[m[1]].code };
    if (msByQ[text]) return { kind: 'choice', value: msByQ[text].a };
    return null;
  }
  if (html.includes('symbol-svg')) {
    const inner = html.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
    const s = SYMBOLS.find(s => inner === s.svg);
    return s ? { kind: 'text', value: s.name } : null;
  }
  if (arithAnswer(text) !== null) return { kind: 'text', value: String(arithAnswer(text)) };
  if ((m = text.match(/^「(.+?)」は何画\?$/))) return { kind: 'text', value: String(kanjiBy[m[1]][2]) };
  if ((m = text.match(/^「(.+?)」の読み方は\?$/))) return { kind: 'text', value: kanjiBy[m[1]][3][0] };
  if ((m = text.match(/^「(.+?)」の県庁所在地は\?$/))) return { kind: 'text', value: prefBy[m[1]][1] };
  if ((m = text.match(/^「(.+?)」があるのは何地方\?$/))) return { kind: 'text', value: REGIONS[prefBy[m[1]][3]][0] };
  if (riddleBy[text]) return { kind: 'text', value: riddleBy[text].a[0] };
  return null;
}

function answerCurrent(app, correct = true) {
  const sol = solve(app);
  if (!sol) return { ok: false, reason: '設問を解析できない: ' + app.els.question.textContent };
  if (sol.kind === 'choice') {
    const btns = app.els.choiceList.children;
    (correct ? btns.find(b => b.dataset.choice === sol.value)
             : btns.find(b => b.dataset.choice !== sol.value)).click();
  } else {
    app.els.textInput.value = correct ? sol.value : (sol.value + 'zz9');
    app.els.submitBtn.click();
  }
  return { ok: true, expected: sol.value };
}

const start = (app, type, count) => { app.cats[type].click(); app.courses[count].click(); };

// ================= テスト =================
console.log('=== 1. 算数: 学年別の出題範囲と採点 ===');
{
  const specs = {
    low:  { ops: ['+', '-', '×'],      check: (op, a, b) => op === '×' ? (a <= 9 && b <= 9) : (a <= 100 && b <= 100) },
    mid:  { ops: ['+', '-', '×', '÷'], check: (op, a, b) => op === '÷' ? (b >= 2 && b <= 9) : true },
    high: { ops: ['+', '-', '×', '÷'], check: (op, a, b) => op === '÷' ? (b >= 2 && b <= 99) : true }
  };
  for (const [grade, spec] of Object.entries(specs)) {
    const app = buildApp();
    app.cats.arith.click(); app.aGrades[grade].click(); app.courses[20].click();
    let correct = 0, rangeOk = true, opsOk = true, divExact = true;
    for (let i = 0; i < 20; i++) {
      const m = app.els.question.textContent.match(/^(-?\d+)\s*([+\-×÷])\s*(-?\d+)\s*=$/);
      const a = +m[1], op = m[2], b = +m[3];
      if (!spec.ops.includes(op)) opsOk = false;
      if (!spec.check(op, a, b)) rangeOk = false;
      if (op === '÷' && a % b !== 0) divExact = false;
      answerCurrent(app, true);
      if (app.els.statusLine.textContent.startsWith('正解')) correct++;
      app.runTimers();
    }
    check(`${grade}: 演算子が範囲内`, opsOk);
    check(`${grade}: 数値が範囲内`, rangeOk);
    check(`${grade}: わり算が割り切れる`, divExact);
    check(`${grade}: 全問正解`, correct === 20, correct);
  }
}

console.log('=== 2. 漢字: 学年帯別の出題範囲と採点 ===');
{
  for (const [grade, [lo, hi]] of Object.entries({ low: [1, 2], mid: [3, 4], high: [5, 6] })) {
    const app = buildApp();
    app.cats.kanji.click(); app.kGrades[grade].click(); app.courses[20].click();
    let correct = 0, gradeOk = true;
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const k = kanjiBy[app.els.question.textContent.match(/「(.+?)」/)[1]];
      seen.add(k[0]);
      if (!(k[1] >= lo && k[1] <= hi)) gradeOk = false;
      answerCurrent(app, true);
      if (app.els.statusLine.textContent.startsWith('正解')) correct++;
      app.runTimers();
    }
    check(`${grade}: 学年範囲内のみ出題`, gradeOk);
    check(`${grade}: 全問正解`, correct === 20, correct);
    check(`${grade}: 重複なし`, seen.size === 20, seen.size);
  }
}

console.log('=== 3. 他カテゴリの採点 ===');
{
  for (const type of ['pref', 'map', 'riddle', 'ms', 'kara', 'smash']) {
    const app = buildApp();
    start(app, type, 20);
    let correct = 0, parsed = true;
    for (let i = 0; i < 20; i++) {
      const r = answerCurrent(app, true);
      if (!r.ok) { parsed = false; check(type + ': 設問を解析できる', false, r.reason); break; }
      if (app.els.statusLine.textContent.startsWith('正解')) correct++;
      app.runTimers();
    }
    if (parsed) check(`${type}: 全問正解`, correct === 20, correct);
  }
}

console.log('=== 4. からぴち: 出題の内訳が事実と一致する ===');
{
  // 出題プール全体を1問ずつ検証する(取りこぼしを防ぐため20問コースを繰り返し回す)
  const kinds = {};
  let dataOk = true, choiceOk = true, answerInChoices = true, unsolved = null;
  const seen = new Set();
  for (let round = 0; round < 12; round++) {
    const app = buildApp();
    start(app, 'kara', 20);
    for (let i = 0; i < 20; i++) {
      const text = app.els.question.textContent;
      const html = app.els.question.innerHTML;
      const labels = app.els.choiceList.children.map(b => b.dataset.choice);
      if (labels.length !== 4 || new Set(labels).size !== 4) choiceOk = false;
      const sol = solveKarapichi(text, html);
      if (!sol) { dataOk = false; unsolved = unsolved || (text || html).slice(0, 60); }
      else {
        seen.add(sol.kind === 'color/swatch' ? 'swatch:' + sol.value : text);
        kinds[sol.kind] = (kinds[sol.kind] || 0) + 1;
        // 正解が選択肢に1つだけ含まれること(誤答に正解と同じ値が紛れていない)
        if (labels.filter(l => l === sol.value).length !== 1) answerInChoices = false;
      }
      answerCurrent(app, true);
      app.runTimers();
    }
  }
  check('選択肢は常に4つで重複なし', choiceOk);
  check('全設問がデータから解ける', dataOk, unsolved);
  check('正解がちょうど1つ選択肢に入る', answerInChoices);
  check('カラー(名前→値)が出る', kinds['color/forward'] > 0);
  check('カラー(値→名前)が出る', kinds['color/reverse'] > 0);
  check('カラー(色を見せる問題)が出る', kinds['color/swatch'] > 0);
  check('誕生日が出る', kinds['birthday/forward'] > 0);
  check('好きなことが出る', kinds['like/reverse'] > 0);
  check('苦手なことが出る', kinds['weak/reverse'] > 0);
  check('トリビアが出る', kinds['trivia'] > 0);
  check('全メンバーに hex カラーがある',
    KARA.every(m => /^#[0-9a-f]{6}$/i.test(m.hex)) && new Set(KARA.map(m => m.hex)).size === 12);

  // データの整合性
  check('メンバーは12人', KARA.length === 12, KARA.length);
  check('名前が全員異なる', new Set(KARA.map(m => m.name)).size === 12);
  check('カラーが全員異なる', new Set(KARA.map(m => m.color)).size === 12);
  check('全員に6項目そろっている',
    KARA.every(m => ['name', 'color', 'birthday', 'zodiac', 'blood', 'like', 'weak'].every(k => m[k])));
  check('トリビアの選択肢は正解を含まない誤答3つ',
    KARA_TRIVIA.every(t => t.d.length === 3 && !t.d.includes(t.a)));

  // 逆引きは答えが一意に定まるものだけが出題される
  const dupBirthday = KARA.filter(m => KARA.filter(x => x.birthday === m.birthday).length > 1);
  check('重複する誕生日の逆引きは出題されない',
    dupBirthday.length > 0 && ![...seen].some(t => t === `${dupBirthday[0].birthday}生まれのメンバーは?`),
    dupBirthday.map(m => m.name).join(','));

  const bank = Object.values(kinds).length;
  console.log('  (出題プール内訳) ' + JSON.stringify(kinds));
  check('出題プールは100問以上', seen.size >= 100, seen.size + '問');
}

console.log('=== 4b. スマブラ: 出題の内訳が事実と一致する ===');
{
  const kinds = {};
  let dataOk = true, choiceOk = true, answerInChoices = true, unsolved = null;
  const seen = new Set();
  for (let round = 0; round < 12; round++) {
    const app = buildApp();
    start(app, 'smash', 20);
    for (let i = 0; i < 20; i++) {
      const text = app.els.question.textContent;
      const labels = app.els.choiceList.children.map(b => b.dataset.choice);
      if (labels.length !== 4 || new Set(labels).size !== 4) choiceOk = false;
      const sol = solveSmash(text);
      if (!sol) { dataOk = false; unsolved = unsolved || text; }
      else {
        seen.add(text);
        kinds[sol.kind] = (kinds[sol.kind] || 0) + 1;
        if (labels.filter(l => l === sol.value).length !== 1) answerInChoices = false;
      }
      answerCurrent(app, true);
      app.runTimers();
    }
  }
  check('選択肢は常に4つで重複なし', choiceOk);
  check('全設問がデータから解ける', dataOk, unsolved);
  check('正解がちょうど1つ選択肢に入る', answerInChoices);
  check('ファイター→シリーズが出る', kinds['fighter/forward'] > 0);
  check('シリーズ→ファイターが出る', kinds['fighter/reverse'] > 0);
  check('トリビアが出る', kinds['trivia'] > 0);
  check('ファイター名の重複なし', new Set(SMASH.map(f => f[0])).size === SMASH.length);
  check('トリビアの選択肢は正解を含まない誤答3つ',
    SMASH_TRIVIA.every(t => t.d.length === 3 && !t.d.includes(t.a)));

  // 複数体が参戦しているシリーズの逆引きは、答えが定まらないので出題しない
  const perSeries = {};
  SMASH.forEach(([, s]) => { perSeries[s] = (perSeries[s] || 0) + 1; });
  const multi = Object.keys(perSeries).filter(s => perSeries[s] > 1);
  check('複数体いるシリーズの逆引きは出題されない',
    multi.length > 0 && !multi.some(s => seen.has(`「${s}」から参戦しているファイターは?`)),
    multi.slice(0, 3).join(','));

  console.log('  (出題プール内訳) ' + JSON.stringify(kinds));
  check('出題プールは100問以上', seen.size >= 100, seen.size + '問');
}

console.log('=== 5. 達人コース: 全カテゴリが混ざる ===');
{
  const kinds = new Set();
  let correct = 0, total = 0;
  for (let round = 0; round < 5; round++) {
    const app = buildApp();
    start(app, 'master', 20);
    for (let i = 0; i < 20; i++) {
      const text = app.els.question.textContent;
      const html = app.els.question.innerHTML;
      if (!app.els.choiceList.classList.contains('hidden')) {
        // 選択式は「からぴち」と「モビルスーツ」の2カテゴリが共用しているので、
        // からぴちのデータから解けるかどうかで見分ける
        kinds.add(solveKarapichi(text, html) ? 'kara' : solveSmash(text) ? 'smash' : 'ms');
      } else if (html.includes('symbol-svg')) kinds.add('map');
      else if (arithAnswer(text) !== null) kinds.add('arith');
      else if (/読み方|何画/.test(text)) kinds.add('kanji');
      else if (/県庁所在地|何地方/.test(text)) kinds.add('pref');
      else kinds.add('riddle');
      total++;
      answerCurrent(app, true);
      if (app.els.statusLine.textContent.startsWith('正解')) correct++;
      app.runTimers();
    }
  }
  check('8カテゴリすべて出現', kinds.size === 8, [...kinds].sort().join(','));
  check('全問正解', correct === total, correct + '/' + total);
}

console.log('=== 6. 連打防止 ===');
{
  const app = buildApp();
  start(app, 'arith', 5);
  answerCurrent(app, true);
  const graded = () => app.els.progress.children.filter(d =>
    d.classList.contains('done') || d.classList.contains('wrong')).length;
  const first = graded();
  for (let i = 0; i < 5; i++) app.els.submitBtn.click();
  check('連打しても採点は1回だけ', graded() === first, graded());
  check('連打してもタイマーは1本', app.pendingTimers() === 1, app.pendingTimers());
  check('入力が無効化される', app.els.submitBtn.disabled === true);
  app.runTimers();
  check('次の設問で再度有効化', app.els.submitBtn.disabled === false);
}

console.log('=== 7. 中断(やめる)でタイマーが止まる ===');
{
  const app = buildApp();
  start(app, 'arith', 5);
  answerCurrent(app, true);
  check('遷移待ちのタイマーがある', app.pendingTimers() === 1);
  app.els.quitBtn.click();
  check('やめる後は保留タイマーが無い', app.pendingTimers() === 0, app.pendingTimers());
  check('コース選択に戻る', !app.els.courseView.classList.contains('hidden'));
  check('クイズ画面は非表示', app.els.quizView.classList.contains('hidden'));
  check('残タイマーは発火しない', app.runTimers() === 0);
  check('戻ったままクイズ画面は非表示', app.els.quizView.classList.contains('hidden'));
}

console.log('=== 8. 四択の正誤マーキング ===');
{
  for (const type of ['ms', 'kara', 'smash']) {
    const app = buildApp();
    start(app, type, 5);
    const want = solve(app).value;
    answerCurrent(app, false);
    const btns = app.els.choiceList.children;
    check(`${type}: 正解ボタンに is-correct`,
      btns.find(b => b.dataset.choice === want).classList.contains('is-correct'));
    check(`${type}: 選んだ誤答に is-wrong が1つだけ`,
      btns.filter(b => b.classList.contains('is-wrong')).length === 1);
    check(`${type}: 全ボタンが無効化`, btns.every(b => b.disabled === true));
    check(`${type}: 選択式では認識結果を繰り返さない`, app.els.answerDisplay.textContent === '');

    const app2 = buildApp();
    start(app2, type, 5);
    answerCurrent(app2, true);
    check(`${type}: 正答時は is-wrong が付かない`,
      app2.els.choiceList.children.filter(b => b.classList.contains('is-wrong')).length === 0);
  }
}

console.log('=== 9. 進捗表示と問題文サイズの段階 ===');
{
  const app = buildApp();
  start(app, 'arith', 10);
  check('進捗カウンタ 1/10', app.els.progressCount.textContent === '1 / 10', app.els.progressCount.textContent);
  check('算数は大サイズ(サイズ用クラス無し)',
    !app.els.question.classList.contains('medium-text') && !app.els.question.classList.contains('long-text'),
    app.els.question.className);
  answerCurrent(app, true); app.runTimers();
  check('進捗カウンタ 2/10', app.els.progressCount.textContent === '2 / 10', app.els.progressCount.textContent);

  const app2 = buildApp();
  start(app2, 'kanji', 20);
  check('漢字の短い問いは medium-text', app2.els.question.classList.contains('medium-text'), app2.els.question.className);

  const app3 = buildApp();
  start(app3, 'riddle', 20);
  let sawLong = false;
  for (let i = 0; i < 20; i++) {
    if (app3.els.question.textContent.length > 18) {
      sawLong = app3.els.question.classList.contains('long-text');
      break;
    }
    answerCurrent(app3, true); app3.runTimers();
  }
  check('長いなぞなぞは long-text', sawLong);
}

console.log('=== 10. カテゴリ切替でUIが追随する ===');
{
  const app = buildApp();
  check('初期は算数の学年行が表示', !app.els.arithGradeField.classList.contains('hidden'));
  check('初期は漢字の学年行が非表示', app.els.kanjiGradeField.classList.contains('hidden'));
  app.cats.kanji.click();
  check('漢字選択で漢字の行が表示', !app.els.kanjiGradeField.classList.contains('hidden'));
  check('漢字選択で算数の行が非表示', app.els.arithGradeField.classList.contains('hidden'));
  check('aria-pressed が更新される',
    app.cats.kanji.getAttribute('aria-pressed') === 'true' && app.cats.arith.getAttribute('aria-pressed') === 'false');
  app.cats.master.click();
  check('達人では両方表示',
    !app.els.arithGradeField.classList.contains('hidden') && !app.els.kanjiGradeField.classList.contains('hidden'));
  app.cats.kara.click();
  check('からぴちでは両方非表示',
    app.els.arithGradeField.classList.contains('hidden') && app.els.kanjiGradeField.classList.contains('hidden'));

  const app2 = buildApp();
  start(app2, 'kara', 5);
  check('選択式ではマイク/入力欄を隠す', app2.els.controls.classList.contains('hidden'));
  check('選択式では選択肢を表示', !app2.els.choiceList.classList.contains('hidden'));
  answerCurrent(app2, true); app2.runTimers();
  check('選択肢は毎回4つ', app2.els.choiceList.children.length === 4, app2.els.choiceList.children.length);

  const app3 = buildApp();
  start(app3, 'arith', 5);
  check('記述式では選択肢を隠す', app3.els.choiceList.classList.contains('hidden'));
  check('記述式ではマイク/入力欄を表示', !app3.els.controls.classList.contains('hidden'));
}

console.log('=== 11. ベストスコアの保存キー ===');
{
  const store = {};
  const play = (type, gradeKey, gradeVal, count) => {
    const app = buildApp({ store });
    app.cats[type].click();
    if (gradeKey) app[gradeKey][gradeVal].click();
    app.courses[count].click();
    app.setNow(1000);
    for (let i = 0; i < count; i++) { answerCurrent(app, true); app.runTimers(); }
    return app;
  };
  const a = play('arith', 'aGrades', 'high', 5);
  const keysOf = () => Object.keys(JSON.parse(store.sakitoQuizBestScores));
  check('算数は学年込みのキー', keysOf().includes('arith-high-5'), keysOf().join(','));
  check('結果ラベルにコース名', a.els.resultLabel.textContent === '算数・4年生・5問', a.els.resultLabel.textContent);
  check('ベスト表示が1行の短さ', a.els.bestScoreText.textContent.length <= 24, a.els.bestScoreText.textContent);
  check('新記録クラスが付く', a.els.bestScoreText.classList.contains('is-new'));
  check('満点で is-perfect', a.els.scoreText.classList.contains('is-perfect'));

  play('kanji', 'kGrades', 'low', 5);
  const k = play('kara', null, null, 5);
  check('漢字/からぴちも別枠で保存',
    keysOf().includes('kanji-low-5') && keysOf().includes('kara-5') && keysOf().includes('arith-high-5'),
    keysOf().join(','));
  check('からぴちの結果ラベル', k.els.resultLabel.textContent === 'からぴち・5問', k.els.resultLabel.textContent);
}

console.log('=== 12. 効果音のオン/オフ ===');
{
  const played = [];
  class Osc {
    constructor() { this.frequency = { value: null }; }
    connect() { return this; } start() { played.push(this.frequency.value); } stop() {}
  }
  class Ctx {
    constructor() { this.state = 'suspended'; this.currentTime = 0; }
    resume() { this.state = 'running'; }
    createOscillator() { return new Osc(); }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() { return this; } }; }
  }
  const store = {};
  const app = buildApp({ store, window: { AudioContext: Ctx } });
  start(app, 'arith', 5);
  answerCurrent(app, true);
  check('オン時は音が鳴る', played.length > 0, played.length);
  app.runTimers();

  played.length = 0;
  app.els.seToggleBtn.click();
  check('ラベルがオフに', app.els.seToggleBtn.textContent === '効果音: オフ', app.els.seToggleBtn.textContent);
  check('localStorage に off', store.sakitoQuizSeEnabled === 'off', store.sakitoQuizSeEnabled);
  answerCurrent(app, true);
  check('オフ時は鳴らない', played.length === 0, played.length);

  const app2 = buildApp({ store, window: { AudioContext: Ctx } });
  check('再読込でオフが復元', app2.els.seToggleBtn.textContent === '効果音: オフ', app2.els.seToggleBtn.textContent);
}

console.log('=== 13. マイクの解放 ===');
{
  let rec = null;
  class FakeRec {
    constructor() { this.aborted = false; rec = this; }
    start() { if (this.onstart) this.onstart(); }
    abort() { this.aborted = true; if (this.onerror) this.onerror({ error: 'aborted' }); if (this.onend) this.onend(); }
    stop() { if (this.onend) this.onend(); }
  }
  const app = buildApp({ window: { SpeechRecognition: FakeRec } });
  start(app, 'arith', 5);
  app.els.micBtn.click();
  check('マイク起動で listening', app.els.micBtn.classList.contains('listening'));
  answerCurrent(app, true);
  check('回答時にマイクが止まる', rec.aborted === true);
  check('listening が外れる', !app.els.micBtn.classList.contains('listening'));
}

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + `pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
