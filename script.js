(function () {
  const APP_VERSION = '0.18.0';
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
  // 「えんえん(おわりなし)」コース。正解が無いパーティークイズだけで使える。
  // 終わりが無いので、設問はまとめて作らず ENDLESS_CHUNK 件ずつ継ぎ足していく
  let endless = false;
  const ENDLESS_CHUNK = 10;
  let seenKeys = new Set(); // 1回のセット内で同じ設問を繰り返さないための記録
  // ふたりで交互モード。1問ずつ手番を回す。ふたりのときは「TOTAL問ずつ」出すので
  // セット全体の設問数は TOTAL × 人数 になる
  let playerCount = 1;
  let setSize = TOTAL;
  const PLAYER_LABELS = ['プレイヤー1', 'プレイヤー2'];
  // 何問目かで手番が決まる(0問目→1人目、1問目→2人目、…)
  const playerOf = i => i % playerCount;
  // いま答える人。復習モードでは、その問題を間違えた本人がもう一度答える
  const currentPlayer = () => {
    const q = questions[current];
    return q && q.player !== undefined ? q.player : playerOf(current);
  };
  // 直前のセットで間違えた設問。結果画面の「まちがえた問題だけ」で使う
  let reviewQueue = [];
  let reviewing = false;

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
  const reviewBtn = $('reviewBtn');
  const historyEl = $('historyChart');
  const historyCaptionEl = $('historyCaption');
  const courseChangeBtn = $('courseChangeBtn');
  const quitBtn = $('quitBtn');
  const endlessCourseBtn = $('endlessCourseBtn');
  const turnBadgeEl = $('turnBadge');
  const courseBtns = document.querySelectorAll('.course-btn');
  const categoryBtns = $('categoryRow').querySelectorAll('.segmented-btn');
  const playerBtns = $('playerRow').querySelectorAll('.segmented-btn');
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
    SMASH_FIGHTERS, SMASH_TRIVIA, DILEMMA_THEMES, DILEMMA_PAIRS
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

  const DILEMMA_PAIR_RATIO = 0.35; // 作り込んだ固定ペアを出す割合

  // 究極の選択(パーティークイズ)。正解が無いので採点しない設問として作る。
  // 固定の問題リストから選ぶのではなく、1問ずつその場で組み立てる:
  //   - テーマ内の2項目をランダムに組み合わせる(数は稼げるが対比は運まかせ)
  //   - 対比を練った固定ペアをそのまま使う(数は少ないが確実に面白い)
  // の2通りを混ぜることで、手数と質の両方を確保している
  function generateDilemmaQuestion() {
    let ask, a, b;
    if (Math.random() < DILEMMA_PAIR_RATIO) {
      [a, b] = DILEMMA_PAIRS[randInt(0, DILEMMA_PAIRS.length - 1)];
      ask = 'どっちをえらぶ?';
    } else {
      const theme = DILEMMA_THEMES[randInt(0, DILEMMA_THEMES.length - 1)];
      [a, b] = shuffle(theme.items).slice(0, 2);
      ask = theme.ask(a, b);
    }
    // 左右どちらに出るかも毎回入れかえる
    return { type: 'choice', scored: false, text: ask, choices: shuffle([a, b]), accepted: [] };
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
  // 算数と究極の選択は決まったプールを持たず毎回その場で作るので bank を持たない。
  // scored: false は正解が無く採点しないカテゴリ(達人コースにも混ぜない)。
  // カテゴリを増やすときに触るのは、この配列と index.html のボタンだけ。
  const CATEGORIES = [
    { id: 'arith',  label: '算数',         generate: generateArithQuestion },
    { id: 'dilemma', label: '究極の選択',  generate: generateDilemmaQuestion, scored: false },
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

  // その場で作るカテゴリ(算数・究極の選択)は、バンクから引く場合と違って
  // 同じ設問が二度出てしまう。重複したら作り直し、それでも駄目なら諦めて採用する
  const questionKey = q => q.text + '|' + (q.choices || []).slice().sort().join(',');
  function generateUnique(count, make) {
    return Array.from({ length: count }, () => {
      let q = make();
      for (let retry = 0; retry < 20 && seenKeys.has(questionKey(q)); retry++) q = make();
      seenKeys.add(questionKey(q));
      return q;
    });
  }

  function generateSet() {
    seenKeys = new Set();
    const category = CATEGORY_BY_ID[currentType];
    if (category) {
      questions = category.bank
        ? sampleFromBank(category.bank(), setSize).map(item => category.generate(item))
        : generateUnique(endless ? ENDLESS_CHUNK : setSize, () => category.generate());
      return;
    }
    // 達人コース: 採点するカテゴリを設問ごとにランダムに混ぜて出題。
    // 各カテゴリのプールを先にTOTAL件ずつ確保しておき、抽選されるたびに先頭から
    // 消費することで、1回のセット内で同じ設問が重複しないようにする
    const mixed = CATEGORIES.filter(c => c.scored !== false);
    const pools = {};
    mixed.forEach(c => {
      if (c.bank) pools[c.id] = { items: sampleFromBank(c.bank(), setSize), used: 0 };
    });
    questions = Array.from({ length: setSize }, () => {
      const c = mixed[randInt(0, mixed.length - 1)];
      const pool = pools[c.id];
      return pool ? c.generate(pool.items[pool.used++]) : c.generate();
    });
  }

  // ---- 進捗UI ----
  function renderProgress() {
    // えんえんコースは終わりが無く、ドットを並べても残りが読み取れないので出さない
    renderTurn();
    progressEl.classList.toggle('hidden', endless);
    if (endless) {
      progressCountEl.textContent = `${current + 1}問目`;
      return;
    }
    progressEl.innerHTML = '';
    for (let i = 0; i < setSize; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot';
      if (i < results.length) {
        // correct が null の設問(究極の選択など)は正誤が無いので中立の色にする
        const r = results[i].correct;
        dot.classList.add(r === null ? 'answered' : r ? 'done' : 'wrong');
      } else if (i === current) {
        dot.classList.add('current');
      }
      progressEl.appendChild(dot);
    }
    // ドットだけでは残り問題数が読み取りにくいため、数字でも示す
    progressCountEl.textContent = `${Math.min(current + 1, setSize)} / ${setSize}`;
  }

  // いま誰の番かの表示。ひとりのときは出さない
  function renderTurn() {
    turnBadgeEl.classList.toggle('hidden', playerCount < 2);
    if (playerCount < 2) return;
    const p = currentPlayer();
    turnBadgeEl.textContent = `${PLAYER_LABELS[p]}のばん`;
    turnBadgeEl.classList.toggle('turn-badge--p2', p === 1);
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
      // 2択は横並びだと1つあたりが細くなるので、縦に大きく並べる
      choiceListEl.classList.toggle('choice-list--pair', q.choices.length === 2);
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

  // 正解が無い設問用の、当たり外れを感じさせない中立な音
  function playPickSound() {
    playTone(660, 0, 0.12, 'sine', 0.18);
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

  // ひらがなの数詞。音声認識は「13」ではなく「じゅうさん」と返すことがあるため、
  // 読みからも数値を取れるようにする。
  // 「さんびゃく」「はっせん」のような音便があるので、読み方の異体もすべて並べる
  const KANA_DIGITS = {
    'ぜろ': 0, 'れい': 0, 'いち': 1, 'いっ': 1, 'に': 2, 'さん': 3,
    'よん': 4, 'し': 4, 'よ': 4, 'ご': 5, 'ろく': 6, 'ろっ': 6,
    'なな': 7, 'しち': 7, 'はち': 8, 'はっ': 8, 'きゅう': 9, 'く': 9,
  };
  const KANA_UNITS = {
    'せん': 1000, 'ぜん': 1000, 'ひゃく': 100, 'びゃく': 100, 'ぴゃく': 100,
    'じゅう': 10, 'じゅっ': 10, 'じっ': 10,
  };
  // 長い読みから先に試す(「し」より「しち」、「く」より「きゅう」を優先)
  const byLengthDesc = obj => Object.keys(obj).sort((a, b) => b.length - a.length);
  const KANA_DIGIT_KEYS = byLengthDesc(KANA_DIGITS);
  const KANA_UNIT_KEYS = byLengthDesc(KANA_UNITS);
  // 「こたえは〜です」のような前置き・語尾。これを取り除いた残り全体が数詞として
  // 読めるときだけ数値とみなす。
  // 文中から数詞らしき部分だけを拾う方式にすると、「わかりません」の「ません」が
  // 「せん(1000)」に化けるような誤爆が起きるため、全体一致で判定する
  // 「こたえは〜です」のような前置き・語尾。音声認識はこれらを込みで返してくるので、
  // 剥がした形も答えの候補として扱う。算数(ひらがなの数詞)と記述式の両方で使う
  const ANSWER_PREFIXES = ['こたえは', 'こたえ', 'せいかいは', 'せいかい', 'えっと', 'えーと', 'あのー', 'たぶん', 'たしか', 'うーん'];
  const ANSWER_SUFFIXES = ['だとおもいます', 'とおもいます', 'だとおもう', 'とおもう', 'じゃないかな', 'じゃない', 'ですね', 'です', 'だよ', 'だね', 'かな', 'かも', 'だ'];

  // 元の文字列と、前置き・語尾を剥がしていった途中経過をすべて返す。
  // 剥がしすぎて答えそのものを削ってしまっても元の形が候補に残るため、取りこぼさない
  function answerCandidates(text) {
    const out = [];
    let s = text;
    for (let i = 0; i < 6 && s; i++) { // 剥がせなくなるまで(念のため回数に上限をつける)
      out.push(s);
      const pre = ANSWER_PREFIXES.find(p => s.startsWith(p) && s.length > p.length);
      if (pre) { s = s.slice(pre.length); continue; }
      const suf = ANSWER_SUFFIXES.find(p => s.endsWith(p) && s.length > p.length);
      if (suf) { s = s.slice(0, -suf.length); continue; }
      break;
    }
    return out;
  }

  function kanaToNumber(str) {
    let section = 0, digit = null, i = 0;
    while (i < str.length) {
      const unit = KANA_UNIT_KEYS.find(k => str.startsWith(k, i));
      if (unit) {
        // 「ひゃく」のように数を伴わない場合は1つぶんとして数える
        section += (digit === null ? 1 : digit) * KANA_UNITS[unit];
        digit = null;
        i += unit.length;
        continue;
      }
      const d = KANA_DIGIT_KEYS.find(k => str.startsWith(k, i));
      if (!d) return null; // 数として読めない字が混ざっている
      digit = KANA_DIGITS[d];
      i += d.length;
    }
    return section + (digit === null ? 0 : digit);
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
    // 最後にひらがなの読みを試す。カタカナで返ってくることもあるので寄せておく。
    // 前置き・語尾を剥がした形も試すが、文中からの部分一致では拾わない
    // (「わかりません」の「ません」が「せん(1000)」に化けるため)
    const kana = s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .replace(/[\s、。!?！？]/g, '');
    const hit = answerCandidates(kana).map(kanaToNumber).find(n => n !== null);
    return hit === undefined ? null : hit;
  }

  // ---- なぞなぞ・漢字クイズの回答テキスト照合 ----
  function normalizeAnswerText(s) {
    return s
      .replace(/[\s、。！？!?・「」『』]/g, '')
      .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
      .toLowerCase();
  }

  // 音声認識やテキスト入力は「こたえは、とうじ、だとおもいます」のように前置き・語尾がつく。
  // 以前は素朴な部分一致で拾っていたが、「くも」のような短い答えだと無関係な発話にも
  // 含まれてしまい誤って正解になる。定型句を剥がした候補との完全一致を基本とし、
  // 3文字以上の答えに限って、想定外の言い回しへの保険として部分一致も残している
  function isTextAnswerCorrect(rawText, accepted) {
    const norm = normalizeAnswerText(rawText);
    if (!norm) return false;
    const cands = answerCandidates(norm);
    return accepted.some(ans => {
      const a = normalizeAnswerText(ans);
      if (!a) return false;
      return cands.indexOf(a) !== -1 || (a.length >= 3 && norm.includes(a));
    });
  }

  // 四択は提示した選択肢そのものが答えなので完全一致で判定する。
  // 部分一致のままだと、正解が「ガンダム」のときに選択肢の「ユニコーンガンダム」を
  // 選んでも正解になってしまう
  function isChoiceAnswerCorrect(rawText, accepted) {
    const norm = normalizeAnswerText(rawText);
    return !!norm && accepted.some(ans => normalizeAnswerText(ans) === norm);
  }

  // 正誤表示を見せてから次の設問(または結果画面)へ進む
  function scheduleNext() {
    nextTimer = setTimeout(() => {
      nextTimer = null;
      current++;
      // えんえんコースは終わらせず、手前まで来たら設問を継ぎ足す
      if (endless && !reviewing) {
        if (current >= questions.length) {
          const category = CATEGORY_BY_ID[currentType];
          questions = questions.concat(generateUnique(ENDLESS_CHUNK, () => category.generate()));
        }
        renderQuestion();
      } else if (current >= setSize) showResult();
      else renderQuestion();
    }, NEXT_QUESTION_DELAY_MS);
  }

  // ---- 回答処理 ----
  function submitAnswer(rawText, source) {
    if (awaitingNext) return; // 次の設問への遷移待ち中は連打を無視

    // 選択式はボタンの色分けで選んだ答えが分かるので、あえて繰り返さない
    answerDisplayEl.textContent = (rawText && source !== 'choice')
      ? `${source === 'voice' ? '認識結果' : '入力'}: 「${rawText}」`
      : '';

    const question = questions[current];

    // 究極の選択のような正解が無い設問は、採点せず「選んだもの」を記録して次へ進む
    if (question.scored === false) {
      const picked = String(rawText).trim();
      if (!picked) return;
      awaitingNext = true;
      setInputsDisabled(true);
      results.push({ q: question.text, userAnswer: picked, correct: null, player: currentPlayer() });
      statusLineEl.textContent = `「${picked}」をえらんだ!`;
      statusLineEl.className = 'status-line picked';
      Array.from(choiceListEl.children).forEach(btn => {
        if (btn.dataset.choice === picked) btn.classList.add('is-picked');
      });
      replayAnimation(questionBoxEl, 'feedback-correct');
      playPickSound();
      renderProgress();
      scheduleNext();
      return;
    }

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
      correct: isCorrect,
      player: currentPlayer()
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
    scheduleNext();
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

  // ---- コースごとの成績の履歴(直近HISTORY_LIMIT回) ----
  // ベストスコアは「一番よかった1回」しか残らないので、伸びているのかが分からない。
  // 直近の並びを別に持って、結果画面で見比べられるようにする
  const HISTORY_KEY = 'sakitoQuizHistory';
  const HISTORY_LIMIT = 10;

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      // プライベートブラウズ等、保存できない環境では無視
    }
  }

  // 今回の結果を足して、そのコースの直近分を返す。キーにコースの問題数が
  // 入っているので、1つの配列の中では total は常に同じ値になる
  function pushHistory(courseKey, result) {
    const history = loadHistory();
    const list = (history[courseKey] || [])
      .concat([{ c: result.correct, t: result.total, ms: result.timeMs }]);
    history[courseKey] = list.slice(-HISTORY_LIMIT);
    saveHistory(history);
    return history[courseKey];
  }

  function renderHistory(list) {
    // 1回しか記録が無いうちは比べようがないので出さない
    const show = list.length >= 2;
    historyEl.classList.toggle('hidden', !show);
    historyCaptionEl.classList.toggle('hidden', !show);
    historyEl.innerHTML = '';
    if (!show) return;

    list.forEach((h, i) => {
      const bar = document.createElement('div');
      bar.className = 'history-bar' + (i === list.length - 1 ? ' history-bar--now' : '');
      const ratio = h.t > 0 ? h.c / h.t : 0;
      // 0問正解でも棒が見えるように下限を持たせる
      bar.style.height = (8 + ratio * 92).toFixed(1) + '%';
      bar.setAttribute('title', `${h.c}/${h.t}`);
      historyEl.appendChild(bar);
    });
    const avg = list.reduce((sum, h) => sum + h.c, 0) / list.length;
    historyCaptionEl.textContent = `さいきん${list.length}回のへいきん ${avg.toFixed(1)}問`;
  }

  // 履歴を出さない画面(採点しないカテゴリ・ふたりで交互・復習)で消しておく
  function hideHistory() {
    historyEl.classList.add('hidden');
    historyCaptionEl.classList.add('hidden');
    historyEl.innerHTML = '';
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
    if (!confirm('すべてのコースのベストスコアと成績の記録をクリアします。よろしいですか?')) return;
    try {
      localStorage.removeItem(BEST_SCORES_KEY);
      localStorage.removeItem(HISTORY_KEY);
    } catch (e) {
      // 保存できない環境では何もしない
    }
    clearScoresMsgEl.textContent = '記録をクリアしました。';
  });

  // 選んだものを並べるだけの結果表示。正解が無いカテゴリはスコアもベスト記録も出さない
  function showUnscoredResult() {
    const timeMs = Date.now() - quizStartTime;
    resultLabelEl.textContent = `${CATEGORY_LABELS[currentType]}・${results.length}問`;
    scoreText.textContent = '🎉';
    scoreText.classList.remove('is-perfect');
    scoreMsg.textContent = 'えらんだのはこの通り。みんなはどうだった?';
    timeTextEl.textContent = `所要時間: ${formatDuration(timeMs)}`;
    bestScoreEl.textContent = '';
    bestScoreEl.classList.remove('is-new');
    bestScoreEl.classList.add('hidden');

    hideHistory(); // 採点しないので残す成績が無い
    updateReviewButton(); // 正解が無いので必ず「まちがい0件」= 非表示になる

    resultList.innerHTML = '';
    results.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${playerTag(r)}${r.q}</span><span class="picked">${r.userAnswer}</span>`;
      resultList.appendChild(li);
    });
  }

  // ふたりで交互のときだけ、結果一覧の各行に誰の問題だったかを添える
  function playerTag(r) {
    if (playerCount < 2 || r.player === undefined) return '';
    return `<span class="player-tag${r.player === 1 ? ' player-tag--p2' : ''}">${r.player + 1}P</span>`;
  }

  // 間違えた設問を復習用に取っておき、あれば結果画面にボタンを出す。
  // 復習が最優先の行動なので、出すときは「もう一度挑戦」を控えめな見た目に下げる
  function updateReviewButton() {
    reviewQueue = results
      .map((r, i) => (r.correct === false ? Object.assign({}, questions[i], { player: r.player }) : null))
      .filter(Boolean);
    const show = reviewQueue.length > 0;
    reviewBtn.textContent = `まちがえた問題だけ もう一度 (${reviewQueue.length}問)`;
    reviewBtn.classList.toggle('hidden', !show);
    retryBtn.className = show ? 'ghost-btn ghost-btn--block' : 'primary-btn';
  }

  // ---- 結果表示 ----
  function showResult() {
    quizView.classList.add('hidden');
    resultView.classList.remove('hidden');

    if (CATEGORY_BY_ID[currentType] && CATEGORY_BY_ID[currentType].scored === false) {
      showUnscoredResult();
      return;
    }

    const timeMs = Date.now() - quizStartTime;
    timeTextEl.textContent = `所要時間: ${formatDuration(timeMs)}`;

    // ふたりで交互のときは、ひとり分のスコアではなく対戦結果として見せる。
    // ベストスコアはひとりで解いた記録と混ざらないよう、保存も表示もしない
    if (playerCount >= 2) {
      showVersusResult();
      return;
    }

    const correctCount = results.filter(r => r.correct).length;
    scoreText.textContent = `${correctCount}/${setSize}`;
    scoreText.classList.toggle('is-perfect', correctCount === setSize);

    let msg;
    if (correctCount === setSize) msg = 'パーフェクト！お見事です。';
    else if (correctCount >= setSize * 0.6) msg = 'いい調子！もう少しで満点。';
    else msg = '練習あるのみ。もう一度挑戦してみよう。';
    scoreMsg.textContent = msg;

    // 復習は間違えた分だけの短いセットで、通常の記録とは比べられない。
    // 記録には触らず、そのことだけ伝える
    if (reviewing) {
      resultLabelEl.textContent = `${CATEGORY_LABELS[currentType]}・復習${setSize}問`;
      bestScoreEl.textContent = '復習は記録に残りません';
      bestScoreEl.classList.remove('is-new', 'hidden');
      hideHistory();
      updateReviewButton();
      renderResultList();
      return;
    }

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
    const thisResult = { correct: correctCount, total: setSize, timeMs };
    const prevBest = scores[courseKey];
    const isNewBest = !prevBest || isBetterScore(thisResult, prevBest);
    if (isNewBest) {
      scores[courseKey] = thisResult;
      saveBestScores(scores);
    }
    // どのコースの結果かは上部ラベルで示し、記録は1行に収まる短さに保つ
    resultLabelEl.textContent = `${categoryLabel}・${setSize}問`;
    const best = scores[courseKey];
    bestScoreEl.textContent = (isNewBest ? '🏆 新記録！ ベスト ' : 'ベスト ')
      + `${best.correct}/${best.total}・${formatDuration(best.timeMs)}`;
    bestScoreEl.classList.toggle('is-new', isNewBest);
    bestScoreEl.classList.remove('hidden');

    renderHistory(pushHistory(courseKey, thisResult));
    updateReviewButton();
    renderResultList();
  }

  function renderResultList() {
    resultList.innerHTML = '';
    results.forEach(r => {
      const li = document.createElement('li');
      const okClass = r.correct ? 'ok' : 'ng';
      const mine = playerCount >= 2 ? `${r.player + 1}P: ` : 'あなた: ';
      li.innerHTML = `<span>${playerTag(r)}${r.q} ${r.correctAnswer}</span>`
        + `<span class="${okClass}">${r.correct ? '正解' : `${mine}${r.userAnswer}`}</span>`;
      resultList.appendChild(li);
    });
  }

  // ふたりで交互モードの結果。勝ち負けが一目で分かることを優先する
  function showVersusResult() {
    const perPlayer = PLAYER_LABELS.map((_, p) =>
      results.filter(r => r.player === p && r.correct).length);
    scoreText.textContent = perPlayer.join(' - ');
    scoreText.classList.remove('is-perfect');

    const [p1, p2] = perPlayer;
    scoreMsg.textContent = p1 === p2
      ? `ひきわけ！ ふたりとも${p1}問正解。`
      : `${PLAYER_LABELS[p1 > p2 ? 0 : 1]}のかち！`;

    resultLabelEl.textContent = reviewing
      ? `${CATEGORY_LABELS[currentType]}・ふたりで復習${setSize}問`
      : `${CATEGORY_LABELS[currentType]}・ふたりで${TOTAL}問ずつ`;
    // 記録はひとりで解いたときのものと比べられないので残さない
    bestScoreEl.textContent = 'ふたりのときは記録に残りません';
    bestScoreEl.classList.remove('is-new', 'hidden');

    hideHistory();
    updateReviewButton();
    renderResultList();
  }

  retryBtn.addEventListener('click', () => startQuiz());
  reviewBtn.addEventListener('click', () => startQuiz(reviewQueue));

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
      // 「えんえん」は正解が無く記録も残らないカテゴリだけに出す
      const cat = CATEGORY_BY_ID[currentType];
      if (endlessCourseBtn) endlessCourseBtn.classList.toggle('hidden', !cat || cat.scored !== false);
    });
  });

  playerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      playerCount = parseInt(btn.dataset.players, 10);
      setActive(playerBtns, btn);
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

  // クイズ中に中断する。通常のコースはコース選択へ戻るだけだが、えんえんコースは
  // 「やめる」がそのまま終了操作なので、それまでに選んだものを結果として見せる
  quitBtn.addEventListener('click', () => {
    cancelNextTimer();
    awaitingNext = false;
    setInputsDisabled(true); // 進行中の音声認識を確実に止める
    if (endless && results.length > 0) {
      showResult();
      return;
    }
    quizView.classList.add('hidden');
    resultView.classList.add('hidden');
    courseView.classList.remove('hidden');
  });

  courseBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const count = parseInt(btn.dataset.count, 10);
      endless = count === 0;
      // TOTAL は結果表示やベストスコアのキーにも使うので、えんえんでも触らない
      if (!endless) TOTAL = count;
      courseView.classList.add('hidden');
      startQuiz();
    });
  });

  // reviewSet を渡すと、新しく作らずその設問だけを出す(まちがえた問題の復習)
  function startQuiz(reviewSet) {
    cancelNextTimer();
    reviewing = !!reviewSet;
    quitBtn.textContent = endless && !reviewing ? '← おわる' : '← やめる';
    current = 0;
    results = [];
    quizStartTime = Date.now();
    if (reviewing) {
      questions = reviewSet;
      setSize = reviewSet.length;
    } else {
      setSize = TOTAL * playerCount;
      generateSet();
    }
    resultView.classList.add('hidden');
    quizView.classList.remove('hidden');
    renderQuestion();
  }

  setupRecognition();

  // オフラインでも起動できるようにする。file:// で開いた場合やテスト用の
  // サンドボックス(navigator が無い)では登録できないので、その場合は何もしない
  if (typeof navigator !== 'undefined' && navigator.serviceWorker &&
      typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // 登録に失敗してもアプリ自体は問題なく動くので握りつぶす
      });
    });
  }
})();
