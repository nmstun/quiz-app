(function () {
  const APP_VERSION = '0.9.2';
  let TOTAL = 5;
  const NEXT_QUESTION_DELAY_MS = 2000;
  let questions = [];
  let current = 0;
  let results = []; // {q, correctAnswer, userAnswer, correct}
  let recognition = null;
  let recognizing = false;
  let awaitingNext = false; // 正誤判定後、次の設問に移るまでの間は新たな回答を受け付けない
  let nextTimer = null; // 次の設問へ進めるタイマー。中断時に確実に止めるため保持する
  let quizStartTime = 0;
  let currentType = 'arith'; // CATEGORIES の id、または 'master'(達人)

  const $ = id => document.getElementById(id);
  // 動作確認・問い合わせ時にどのビルドを見ているか分かるようにするため、
  // 画面右上に常時表示するアプリバージョン
  const appVersionEl = $('appVersion');
  if (appVersionEl) appVersionEl.textContent = 'v' + APP_VERSION;
  const progressEl = $('progress');
  const progressCountEl = $('progressCount');
  const questionBoxEl = $('questionBox');
  const questionEl = $('question');
  const statusLineEl = $('statusLine');
  const answerDisplayEl = $('answerDisplay');
  const controlsEl = $('controls');
  const micBtn = $('micBtn');
  const micIcon = $('micIcon');
  const micLabel = $('micLabel');
  const textInput = $('textInput');
  const submitBtn = $('submitBtn');
  const choiceListEl = $('choiceList');
  const noteEl = $('note');
  const courseView = $('courseView');
  const quizView = $('quizView');
  const resultView = $('resultView');
  const scoreText = $('scoreText');
  const scoreMsg = $('scoreMsg');
  const timeTextEl = $('timeText');
  const bestScoreEl = $('bestScoreText');
  const resultLabelEl = $('resultLabel');
  const resultList = $('resultList');
  const retryBtn = $('retryBtn');
  const courseChangeBtn = $('courseChangeBtn');
  const quitBtn = $('quitBtn');
  const courseBtns = document.querySelectorAll('.course-btn');
  const categoryBtns = $('categoryRow').querySelectorAll('.segmented-btn');
  const clearScoresBtn = $('clearScoresBtn');
  const clearScoresMsgEl = $('clearScoresMsg');
  const seToggleBtn = $('seToggleBtn');
  const arithGradeFieldEl = $('arithGradeField');
  const arithGradeBtns = $('arithGradeRow').querySelectorAll('.segmented-btn');
  const kanjiGradeFieldEl = $('kanjiGradeField');
  const kanjiGradeBtns = $('kanjiGradeRow').querySelectorAll('.segmented-btn');

  const ARITH_GRADE_LABELS = { low: '1〜2年生', mid: '3年生', high: '4年生' };
  let kanjiGrade = 'mid'; // 'low'(1〜2年生) | 'mid'(3〜4年生) | 'high'(5〜6年生)
  const KANJI_GRADE_LABELS = { low: '1〜2年生', mid: '3〜4年生', high: '5〜6年生' };
  const KANJI_GRADE_RANGES = { low: [1, 2], mid: [3, 4], high: [5, 6] };

  // 問題データは data.js に分離してある(index.html で先に読み込む)
  const {
    RIDDLES, MS_DATA, KANJI_DATA, PREF_DATA, REGIONS, MAP_SYMBOLS,
    KARAPICHI_MEMBERS, KARAPICHI_ATTRS, KARAPICHI_TRIVIA,
    SMASH_FIGHTERS, SMASH_TRIVIA
  } = QUIZ_DATA;

  // 値ごとの出現数を数える。「値→名前」の逆引きは、その値を持つ項目が1つだけの
  // ときしか答えが一意に定まらないため、出題可否の判定にこれを使う
  function countValues(items, pick) {
    const counts = {};
    items.forEach(x => { const v = pick(x); counts[v] = (counts[v] || 0) + 1; });
    return counts;
  }

  // 出題できる設問をあらかじめ列挙する。逆引き(属性値→メンバー名)は、その値を持つ
  // メンバーが1人だけのときしか答えが一意に定まらないため、重複する値はスキップする。
  const KARAPICHI_BANK = (function () {
    const list = [];
    KARAPICHI_ATTRS.forEach(attr => {
      const seen = countValues(KARAPICHI_MEMBERS, m => m[attr.key]);
      KARAPICHI_MEMBERS.forEach(m => {
        if (attr.forward) {
          list.push({ kind: 'attr', dir: 'forward', key: attr.key, member: m, text: attr.forward(m.name) });
        }
        if (attr.reverse && seen[m[attr.key]] === 1) {
          list.push({ kind: 'attr', dir: 'reverse', key: attr.key, member: m, text: attr.reverse(m[attr.key]) });
        }
      });
    });
    // 色そのものを見せて誰のカラーかを当てる問題。文字で「みどり」と書くより
    // 直感的で、グループ名どおり「色」が主役になる
    KARAPICHI_MEMBERS.forEach(m => {
      list.push({ kind: 'attr', dir: 'swatch', key: 'color', member: m, text: 'このメンバーカラーは誰?' });
    });
    KARAPICHI_TRIVIA.forEach(t => list.push({ kind: 'trivia', t }));
    return list;
  })();

  // 出題プール。「シリーズ→ファイター」の逆引きは、そのシリーズからの参戦が
  // 1体だけのときしか答えが定まらないためスキップする
  const SMASH_BANK = (function () {
    const perSeries = countValues(SMASH_FIGHTERS, f => f[1]);
    const list = [];
    SMASH_FIGHTERS.forEach(f => {
      list.push({ kind: 'fighter', dir: 'forward', f });
      if (perSeries[f[1]] === 1) list.push({ kind: 'fighter', dir: 'reverse', f });
    });
    SMASH_TRIVIA.forEach(t => list.push({ kind: 'trivia', t }));
    return list;
  })();

  // ---- 問題生成 ----
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // bankから重複しにくい順でn件取り出す(bankを使い切ったらシャッフルし直して継ぎ足す)
  function sampleFromBank(bank, n) {
    let pool = [];
    while (pool.length < n) pool = pool.concat(shuffle(bank));
    return pool.slice(0, n);
  }

  // 四択の設問を組み立てる。誤答は候補から正解と同じ値を除き、重複も潰してから3つ選ぶ
  // (星座・血液型・出典シリーズのように値が重複するデータでも、同じ選択肢が並ばない)
  function choiceQuestion(text, answer, distractorPool, extra) {
    const distractors = shuffle([...new Set(distractorPool)].filter(v => v !== answer)).slice(0, 3);
    return Object.assign(
      { type: 'choice', text, choices: shuffle([answer, ...distractors]), accepted: [answer] },
      extra
    );
  }

  // 学年ごとの出題範囲(学習指導要領の各学年の学習内容を目安に設定)
  let arithGrade = 'mid'; // 'low'(1〜2年生) | 'mid'(3年生) | 'high'(4年生)
  const ARITH_OPS = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '×': (a, b) => a * b,
    '÷': (a, b) => a / b,
  };

  const ARITH_GRADES = {
    low: {
      ops: ['+', '-', '×'], // わり算は3年生からのため対象外
      pair(op) {
        if (op === '×') return [randInt(1, 9), randInt(1, 9)]; // 九九の範囲
        return [randInt(1, 100), randInt(1, 100)];
      }
    },
    mid: {
      ops: ['+', '-', '×', '÷'],
      pair(op) {
        if (op === '×') return [randInt(2, 99), randInt(2, 9)]; // 2桁×1桁
        if (op === '÷') {
          const b = randInt(2, 9); // 1桁の数でわる(あまりなし)
          return [b * randInt(2, 20), b];
        }
        return [randInt(1, 999), randInt(1, 999)]; // 3桁までの加減算
      }
    },
    high: {
      ops: ['+', '-', '×', '÷'],
      pair(op) {
        if (op === '×') return [randInt(10, 999), randInt(10, 99)]; // 2〜3桁×2桁
        if (op === '÷') {
          const b = randInt(2, 99); // 2桁の数でわる(あまりなし)
          return [b * randInt(2, 50), b];
        }
        return [randInt(1, 9999), randInt(1, 9999)]; // 4桁までの加減算
      }
    }
  };

  function generateArithQuestion() {
    const grade = ARITH_GRADES[arithGrade];
    const op = grade.ops[randInt(0, grade.ops.length - 1)];
    let [a, b] = grade.pair(op);
    if (op === '-' && a < b) [a, b] = [b, a]; // 引き算の答えが負にならないようにする
    // ÷ は pair() が割り切れる組み合わせだけを返すので、ここでは素直に割ればよい
    return { type: 'arith', text: `${a} ${op} ${b} =`, answer: ARITH_OPS[op](a, b) };
  }

  const STROKE_QUESTION_RATIO = 0.3; // 漢字クイズのうち画数問題を混ぜる割合

  function generateKanjiQuestion(item) {
    const [kanji, , strokes, readings] = item;
    if (Math.random() < STROKE_QUESTION_RATIO) {
      return { type: 'kanji-stroke', text: `「${kanji}」は何画?`, answer: strokes };
    }
    return { type: 'kanji-reading', text: `「${kanji}」の読み方は?`, accepted: readings };
  }

  function generateRiddleQuestion(item) {
    return { type: 'riddle', text: item.q, accepted: item.a };
  }

  const PREF_REGION_QUESTION_RATIO = 0.3; // 都道府県クイズのうち地方問題を混ぜる割合

  function generatePrefQuestion(item) {
    const [pref, capital, capitalHira, regionKey] = item;
    if (Math.random() < PREF_REGION_QUESTION_RATIO) {
      return { type: 'pref-region', text: `「${pref}」があるのは何地方?`, accepted: REGIONS[regionKey] };
    }
    return { type: 'pref-capital', text: `「${pref}」の県庁所在地は?`, accepted: [capital, capitalHira, capital.replace(/[市区]$/, '')] };
  }

  function generateSymbolQuestion(item) {
    return { type: 'symbol', text: 'この地図記号は何?', svg: item.svg, accepted: [item.name] };
  }

  const MS_CODE_QUESTION_RATIO = 0.3; // モビルスーツクイズのうち型番問題を混ぜる割合

  // 誤答の選択肢が固定で用意されている問題(グループや作品についての雑学)
  const triviaQuestion = t => choiceQuestion(t.q, t.a, t.d);

  function generateMsQuestion(item) {
    if (Math.random() < MS_CODE_QUESTION_RATIO) {
      return choiceQuestion(`「${item.a}」の型番は?`, item.code, MS_DATA.map(x => x.code));
    }
    return choiceQuestion(item.q, item.a, MS_DATA.map(x => x.a));
  }

  const memberNames = () => KARAPICHI_MEMBERS.map(m => m.name);

  function generateKarapichiQuestion(item) {
    if (item.kind === 'trivia') return triviaQuestion(item.t);
    if (item.dir === 'swatch') {
      // 「しろ」は明るい背景に、「くろ」は暗い背景に溶けてしまうため、
      // どちらのテーマでもはっきり見える色で必ず輪郭線を描く
      const svg = `<circle cx="50" cy="50" r="38" fill="${item.member.hex}" stroke="var(--muted)" stroke-width="3"/>`;
      return choiceQuestion(item.text, item.member.name, memberNames(), { svg });
    }
    // forward は同じ属性の他の値、reverse は他メンバーの名前を誤答にする
    return item.dir === 'forward'
      ? choiceQuestion(item.text, item.member[item.key], KARAPICHI_MEMBERS.map(m => m[item.key]))
      : choiceQuestion(item.text, item.member.name, memberNames());
  }

  function generateSmashQuestion(item) {
    if (item.kind === 'trivia') return triviaQuestion(item.t);
    const [name, series] = item.f;
    return item.dir === 'forward'
      ? choiceQuestion(`「${name}」が出ているゲームシリーズは?`, series, SMASH_FIGHTERS.map(f => f[1]))
      : choiceQuestion(`「${series}」から参戦しているファイターは?`, name, SMASH_FIGHTERS.map(f => f[0]));
  }

  // 選択中の学年帯(kanjiGrade)に含まれる漢字だけを抽出したバンクを返す
  function getKanjiBank() {
    const [lo, hi] = KANJI_GRADE_RANGES[kanjiGrade];
    return KANJI_DATA.filter(item => item[1] >= lo && item[1] <= hi);
  }

  // カテゴリの定義はここ1か所に集約する。
  // bank は出題プールを返す関数(学年で中身が変わるものがあるので関数にしている)。
  // 算数だけは決まったプールを持たず毎回その場で作るので bank を持たない。
  // カテゴリを増やすときに触るのは、この配列と index.html のボタンだけ。
  const CATEGORIES = [
    { id: 'arith',  label: '算数',         generate: generateArithQuestion },
    { id: 'kanji',  label: '漢字',         bank: getKanjiBank,          generate: generateKanjiQuestion },
    { id: 'pref',   label: '都道府県',     bank: () => PREF_DATA,       generate: generatePrefQuestion },
    { id: 'map',    label: '地図記号',     bank: () => MAP_SYMBOLS,     generate: generateSymbolQuestion },
    { id: 'riddle', label: 'なぞなぞ',     bank: () => RIDDLES,         generate: generateRiddleQuestion },
    { id: 'ms',     label: 'モビルスーツ', bank: () => MS_DATA,         generate: generateMsQuestion },
    { id: 'kara',   label: 'からぴち',     bank: () => KARAPICHI_BANK,  generate: generateKarapichiQuestion },
    { id: 'smash',  label: 'スマブラ',     bank: () => SMASH_BANK,      generate: generateSmashQuestion },
  ];
  const CATEGORY_BY_ID = {};
  CATEGORIES.forEach(c => { CATEGORY_BY_ID[c.id] = c; });
  const CATEGORY_LABELS = { master: '達人' };
  CATEGORIES.forEach(c => { CATEGORY_LABELS[c.id] = c.label; });

  function generateSet() {
    const category = CATEGORY_BY_ID[currentType];
    if (category) {
      questions = category.bank
        ? sampleFromBank(category.bank(), TOTAL).map(item => category.generate(item))
        : Array.from({ length: TOTAL }, () => category.generate());
      return;
    }
    // 達人コース: すべてのカテゴリを設問ごとにランダムに混ぜて出題。
    // 各カテゴリのプールを先にTOTAL件ずつ確保しておき、抽選されるたびに先頭から
    // 消費することで、1回のセット内で同じ設問が重複しないようにする
    const pools = {};
    CATEGORIES.forEach(c => {
      if (c.bank) pools[c.id] = { items: sampleFromBank(c.bank(), TOTAL), used: 0 };
    });
    questions = Array.from({ length: TOTAL }, () => {
      const c = CATEGORIES[randInt(0, CATEGORIES.length - 1)];
      const pool = pools[c.id];
      return pool ? c.generate(pool.items[pool.used++]) : c.generate();
    });
  }

  // ---- 進捗UI ----
  function renderProgress() {
    progressEl.innerHTML = '';
    for (let i = 0; i < TOTAL; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot';
      if (i < results.length) {
        dot.classList.add(results[i].correct ? 'done' : 'wrong');
      } else if (i === current) {
        dot.classList.add('current');
      }
      progressEl.appendChild(dot);
    }
    // ドットだけでは残り問題数が読み取りにくいため、数字でも示す
    progressCountEl.textContent = `${Math.min(current + 1, TOTAL)} / ${TOTAL}`;
  }

  // 直前のクラスを消してから付け直し、同じアニメーションを毎問再生させる
  function replayAnimation(el, className) {
    el.classList.remove('q-enter', 'feedback-correct', 'feedback-wrong');
    void el.offsetWidth; // リフローを挟んでアニメーションをリセット
    el.classList.add(className);
  }

  function renderQuestion() {
    awaitingNext = false;
    setInputsDisabled(false);
    statusLineEl.textContent = '';
    statusLineEl.className = 'status-line';
    answerDisplayEl.innerHTML = '&nbsp;';
    textInput.value = '';
    replayAnimation(questionBoxEl, 'q-enter');
    const q = questions[current];
    questionEl.classList.remove('medium-text', 'long-text');
    // svg を持つ設問は図を主役にして、問題文はその下のキャプションに置く
    // (地図記号は記述式、からぴちのカラーは選択式と、回答方法は別々に決まる)
    if (q.svg) {
      questionEl.innerHTML = `<svg class="symbol-svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${q.svg}</svg><div class="symbol-caption">${q.text}</div>`;
    } else {
      questionEl.textContent = q.text;
      // 文字数だけでは算数の式(「655 + 396 =」など)と日本語の文を区別できないため、
      // 算数は常に大きく、それ以外は長さに応じて2段階に落とす
      if (q.type !== 'arith') {
        questionEl.classList.add(q.text.length > 18 ? 'long-text' : 'medium-text');
      }
    }
    if (q.type === 'arith' || q.type === 'kanji-stroke') {
      textInput.inputMode = 'numeric';
      textInput.placeholder = '数字で入力';
    } else {
      textInput.inputMode = 'text';
      textInput.placeholder = '答えを入力';
    }
    if (q.type === 'choice') {
      controlsEl.classList.add('hidden');
      choiceListEl.classList.remove('hidden');
      choiceListEl.innerHTML = '';
      q.choices.forEach(choice => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.textContent = choice;
        btn.dataset.choice = choice; // 回答後に正解／誤答を色付けするため保持
        btn.addEventListener('click', () => {
          unlockAudio();
          submitAnswer(choice, 'choice');
        });
        choiceListEl.appendChild(btn);
      });
    } else {
      controlsEl.classList.remove('hidden');
      choiceListEl.classList.add('hidden');
      choiceListEl.innerHTML = '';
    }
    renderProgress();
  }

  // 次の設問へ進むタイマーを止める。中断や再スタートのときに残しておくと、
  // コース選択に戻った直後に発火してクイズ画面へ引き戻されてしまう
  function cancelNextTimer() {
    if (nextTimer !== null) {
      clearTimeout(nextTimer);
      nextTimer = null;
    }
  }

  // ---- 連打防止 ----
  function setInputsDisabled(disabled) {
    submitBtn.disabled = disabled;
    textInput.disabled = disabled;
    if (SpeechRecognition) micBtn.disabled = disabled;
    Array.from(choiceListEl.children).forEach(btn => { btn.disabled = disabled; });
    // 入力を受け付けない間はマイクも必ずオフにする(テキスト回答時に音声認識が
    // 聞き取り中のまま残る、最終問題後もマイクがオンのままになる、等を防ぐ)
    if (disabled && recognition && recognizing) {
      recognition.abort();
    }
  }

  // ---- 正誤音(Web Audio APIで生成、音声ファイル不要) ----
  const SE_ENABLED_KEY = 'sakitoQuizSeEnabled';
  let seEnabled = true;
  try {
    seEnabled = localStorage.getItem(SE_ENABLED_KEY) !== 'off';
  } catch (e) {
    // 保存できない環境ではデフォルト(オン)のまま
  }
  let audioCtx = null;

  function updateSeToggleLabel() {
    seToggleBtn.textContent = `効果音: ${seEnabled ? 'オン' : 'オフ'}`;
  }
  updateSeToggleLabel();

  seToggleBtn.addEventListener('click', () => {
    seEnabled = !seEnabled;
    try {
      localStorage.setItem(SE_ENABLED_KEY, seEnabled ? 'on' : 'off');
    } catch (e) {
      // 保存できない環境では今回のセッション内でのみ有効
    }
    updateSeToggleLabel();
  });

  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playTone(freq, startOffset, duration, type, peakGain) {
    if (!seEnabled || !audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = audioCtx.currentTime + startOffset;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playCorrectSound() {
    playTone(880, 0, 0.12, 'sine', 0.2);
    playTone(1320, 0.1, 0.18, 'sine', 0.2);
  }

  function playWrongSound() {
    playTone(220, 0, 0.25, 'square', 0.12);
  }

  // ---- 回答テキストから数値を抽出 ----
  const kanjiDigits = { '零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'百':100 };

  function kanjiToNumber(str) {
    // ごく簡単な漢数字パーサ(0-999程度を想定)
    if (!/^[零〇一二三四五六七八九十百]+$/.test(str)) return null;
    let total = 0, section = 0, num = 0;
    for (const ch of str) {
      const val = kanjiDigits[ch];
      if (val === 100) {
        section += (num || 1) * 100;
        num = 0;
      } else if (val === 10) {
        section += (num || 1) * 10;
        num = 0;
      } else {
        num = val;
      }
    }
    total = section + num;
    return total;
  }

  function extractNumber(raw) {
    if (!raw) return null;
    let s = raw.trim();
    // マイナス表現を数字に
    s = s.replace(/マイナス|ー(?=\d)/g, '-');
    // 全角数字を半角に
    s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    // まず数字を直接抽出
    const m = s.match(/-?\d+/);
    if (m) return parseInt(m[0], 10);
    // 漢数字を試す
    const kanjiMatch = s.match(/[零〇一二三四五六七八九十百]+/);
    if (kanjiMatch) {
      const n = kanjiToNumber(kanjiMatch[0]);
      if (n !== null) return n;
    }
    return null;
  }

  // ---- なぞなぞ・漢字クイズの回答テキスト照合 ----
  function normalizeAnswerText(s) {
    return s
      .replace(/[\s、。！？!?・「」『』]/g, '')
      .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
      .toLowerCase();
  }

  // 音声認識やテキスト入力は言い回しがぶれるため、部分一致も正解とみなす
  // (「こたえは、とうじ、だとおもいます」→「とうじ」)
  function isTextAnswerCorrect(rawText, accepted) {
    const norm = normalizeAnswerText(rawText);
    if (!norm) return false;
    return accepted.some(ans => {
      const a = normalizeAnswerText(ans);
      return norm === a || norm.includes(a);
    });
  }

  // 四択は提示した選択肢そのものが答えなので完全一致で判定する。
  // 部分一致のままだと、正解が「ガンダム」のときに選択肢の「ユニコーンガンダム」を
  // 選んでも正解になってしまう
  function isChoiceAnswerCorrect(rawText, accepted) {
    const norm = normalizeAnswerText(rawText);
    return !!norm && accepted.some(ans => normalizeAnswerText(ans) === norm);
  }

  // ---- 回答処理 ----
  function submitAnswer(rawText, source) {
    if (awaitingNext) return; // 次の設問への遷移待ち中は連打を無視

    // 選択式はボタンの色分けで選んだ答えが分かるので、あえて繰り返さない
    answerDisplayEl.textContent = (rawText && source !== 'choice')
      ? `${source === 'voice' ? '認識結果' : '入力'}: 「${rawText}」`
      : '';

    const question = questions[current];
    let isCorrect, userAnswerDisplay, correctAnswerDisplay;

    if (question.type === 'arith' || question.type === 'kanji-stroke') {
      const userNum = extractNumber(rawText);
      if (userNum === null) {
        statusLineEl.textContent = '数字が聞き取れませんでした。もう一度お願いします。';
        statusLineEl.className = 'status-line wrong';
        return;
      }
      isCorrect = userNum === question.answer;
      const unit = question.type === 'kanji-stroke' ? '画' : '';
      userAnswerDisplay = `${userNum}${unit}`;
      correctAnswerDisplay = `${question.answer}${unit}`;
    } else {
      if (!rawText || !rawText.trim()) {
        statusLineEl.textContent = '聞き取れませんでした。もう一度お願いします。';
        statusLineEl.className = 'status-line wrong';
        return;
      }
      isCorrect = question.type === 'choice'
        ? isChoiceAnswerCorrect(rawText, question.accepted)
        : isTextAnswerCorrect(rawText, question.accepted);
      userAnswerDisplay = rawText.trim();
      correctAnswerDisplay = question.accepted[0];
    }

    awaitingNext = true;
    setInputsDisabled(true);

    results.push({
      q: question.text,
      correctAnswer: correctAnswerDisplay,
      userAnswer: userAnswerDisplay,
      correct: isCorrect
    });

    statusLineEl.textContent = isCorrect
      ? `正解！ (${userAnswerDisplay})`
      : `不正解… 正解は ${correctAnswerDisplay}`;
    statusLineEl.className = 'status-line ' + (isCorrect ? 'correct' : 'wrong');

    // 選択式は、どれが正解でどれを選んだのかをボタン自体にも示す
    Array.from(choiceListEl.children).forEach(btn => {
      if (btn.dataset.choice === String(correctAnswerDisplay)) btn.classList.add('is-correct');
      else if (!isCorrect && btn.dataset.choice === String(userAnswerDisplay)) btn.classList.add('is-wrong');
    });

    replayAnimation(questionBoxEl, isCorrect ? 'feedback-correct' : 'feedback-wrong');
    isCorrect ? playCorrectSound() : playWrongSound();

    renderProgress();

    nextTimer = setTimeout(() => {
      nextTimer = null;
      current++;
      if (current >= TOTAL) {
        showResult();
      } else {
        renderQuestion();
      }
    }, NEXT_QUESTION_DELAY_MS);
  }

  // ---- 音声認識セットアップ ----
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function setupRecognition() {
    if (!SpeechRecognition) {
      noteEl.textContent = 'この端末・ブラウザは音声入力に対応していません。テキスト入力をご利用ください。';
      micBtn.disabled = true;
      micBtn.style.opacity = 0.5;
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      recognizing = true;
      micBtn.classList.add('listening');
      micIcon.textContent = '●';
      micLabel.textContent = '聞き取り中…';
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      submitAnswer(transcript, 'voice');
    };

    recognition.onerror = (event) => {
      if (event.error === 'aborted') return; // バックグラウンド遷移時などの意図的な中断
      statusLineEl.textContent = '音声認識エラー: ' + event.error + '。テキスト入力もお試しください。';
      statusLineEl.className = 'status-line wrong';
    };

    recognition.onend = () => {
      recognizing = false;
      micBtn.classList.remove('listening');
      micIcon.textContent = '🎤';
      micLabel.textContent = '話して答える';
    };

    // タブ/画面が非表示になったらマイクを確実に解放する(iOS等でバックグラウンドでも
    // マイク使用中インジケータが点灯し続けるのを防ぐ)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && recognizing) {
        recognition.abort();
      }
    });
  }

  micBtn.addEventListener('click', () => {
    unlockAudio(); // ユーザー操作の中で呼ぶことでiOS等の再生制限を解除しておく
    if (!recognition || recognizing) return;
    try {
      recognition.start();
    } catch (e) {
      // 既に開始中などの例外を無視
    }
  });

  submitBtn.addEventListener('click', () => {
    unlockAudio();
    if (!textInput.value.trim()) return;
    submitAnswer(textInput.value, 'text');
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitBtn.click();
    }
  });

  // ---- キーボード表示中はレイアウトを詰めて、問題文とキーボードが同時に見えるようにする ----
  textInput.addEventListener('focus', () => document.body.classList.add('compact'));
  textInput.addEventListener('blur', () => document.body.classList.remove('compact'));

  // ---- コースごとのベストスコア(正解数優先、同数なら所要時間が短い方が上位) ----
  const BEST_SCORES_KEY = 'sakitoQuizBestScores';

  function loadBestScores() {
    try {
      return JSON.parse(localStorage.getItem(BEST_SCORES_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveBestScores(scores) {
    try {
      localStorage.setItem(BEST_SCORES_KEY, JSON.stringify(scores));
    } catch (e) {
      // プライベートブラウズ等、保存できない環境では無視
    }
  }

  function isBetterScore(a, b) {
    if (a.correct !== b.correct) return a.correct > b.correct;
    return a.timeMs < b.timeMs;
  }

  function formatDuration(ms) {
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}秒`;
    const min = Math.floor(totalSec / 60);
    const sec = Math.round(totalSec % 60);
    return `${min}分${sec}秒`;
  }

  clearScoresBtn.addEventListener('click', () => {
    if (!confirm('すべてのコースのベストスコアをクリアします。よろしいですか?')) return;
    try {
      localStorage.removeItem(BEST_SCORES_KEY);
    } catch (e) {
      // 保存できない環境では何もしない
    }
    clearScoresMsgEl.textContent = '記録をクリアしました。';
  });

  // ---- 結果表示 ----
  function showResult() {
    quizView.classList.add('hidden');
    resultView.classList.remove('hidden');

    const correctCount = results.filter(r => r.correct).length;
    const timeMs = Date.now() - quizStartTime;
    scoreText.textContent = `${correctCount}/${TOTAL}`;
    scoreText.classList.toggle('is-perfect', correctCount === TOTAL);
    timeTextEl.textContent = `所要時間: ${formatDuration(timeMs)}`;

    let msg;
    if (correctCount === TOTAL) msg = 'パーフェクト！お見事です。';
    else if (correctCount >= TOTAL * 0.6) msg = 'いい調子！もう少しで満点。';
    else msg = '練習あるのみ。もう一度挑戦してみよう。';
    scoreMsg.textContent = msg;

    // 算数・漢字は学年別に範囲が変わるため、ベストスコアも学年ごとに分けて記録する
    let courseKey = `${currentType}-${TOTAL}`;
    let categoryLabel = CATEGORY_LABELS[currentType];
    if (currentType === 'arith') {
      courseKey = `arith-${arithGrade}-${TOTAL}`;
      categoryLabel = `算数・${ARITH_GRADE_LABELS[arithGrade]}`;
    } else if (currentType === 'kanji') {
      courseKey = `kanji-${kanjiGrade}-${TOTAL}`;
      categoryLabel = `漢字・${KANJI_GRADE_LABELS[kanjiGrade]}`;
    }
    const scores = loadBestScores();
    const thisResult = { correct: correctCount, total: TOTAL, timeMs };
    const prevBest = scores[courseKey];
    const isNewBest = !prevBest || isBetterScore(thisResult, prevBest);
    if (isNewBest) {
      scores[courseKey] = thisResult;
      saveBestScores(scores);
    }
    // どのコースの結果かは上部ラベルで示し、記録は1行に収まる短さに保つ
    resultLabelEl.textContent = `${categoryLabel}・${TOTAL}問`;
    const best = scores[courseKey];
    bestScoreEl.textContent = (isNewBest ? '🏆 新記録！ ベスト ' : 'ベスト ')
      + `${best.correct}/${best.total}・${formatDuration(best.timeMs)}`;
    bestScoreEl.classList.toggle('is-new', isNewBest);

    resultList.innerHTML = '';
    results.forEach(r => {
      const li = document.createElement('li');
      const okClass = r.correct ? 'ok' : 'ng';
      li.innerHTML = `<span>${r.q} ${r.correctAnswer}</span><span class="${okClass}">${r.correct ? '正解' : `あなた: ${r.userAnswer}`}</span>`;
      resultList.appendChild(li);
    });
  }

  retryBtn.addEventListener('click', startQuiz);

  courseChangeBtn.addEventListener('click', () => {
    resultView.classList.add('hidden');
    courseView.classList.remove('hidden');
  });

  // 選択中のボタンだけ active + aria-pressed=true にする
  function setActive(btns, selected) {
    btns.forEach(b => {
      const isSelected = b === selected;
      b.classList.toggle('active', isSelected);
      b.setAttribute('aria-pressed', String(isSelected));
    });
  }

  categoryBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentType = btn.dataset.type;
      setActive(categoryBtns, btn);
      // 学年別範囲は、それぞれ算数・漢字(を含む達人コース)にのみ関係する
      arithGradeFieldEl.classList.toggle('hidden', currentType !== 'arith' && currentType !== 'master');
      kanjiGradeFieldEl.classList.toggle('hidden', currentType !== 'kanji' && currentType !== 'master');
    });
  });

  // 学年ボタンは算数用と漢字用で作りが同じで、選択値の入れ先だけが違う
  function wireGradeButtons(btns, onSelect) {
    btns.forEach(btn => btn.addEventListener('click', () => {
      onSelect(btn.dataset.grade);
      setActive(btns, btn);
    }));
  }
  wireGradeButtons(arithGradeBtns, g => { arithGrade = g; });
  wireGradeButtons(kanjiGradeBtns, g => { kanjiGrade = g; });

  // クイズ中に中断してコース選択へ戻る
  quitBtn.addEventListener('click', () => {
    cancelNextTimer();
    awaitingNext = false;
    setInputsDisabled(true); // 進行中の音声認識を確実に止める
    quizView.classList.add('hidden');
    resultView.classList.add('hidden');
    courseView.classList.remove('hidden');
  });

  courseBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      TOTAL = parseInt(btn.dataset.count, 10);
      courseView.classList.add('hidden');
      startQuiz();
    });
  });

  function startQuiz() {
    cancelNextTimer();
    current = 0;
    results = [];
    quizStartTime = Date.now();
    generateSet();
    resultView.classList.add('hidden');
    quizView.classList.remove('hidden');
    renderQuestion();
  }

  setupRecognition();
})();
