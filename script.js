(function () {
  const TOTAL = 5;
  const NEXT_QUESTION_DELAY_MS = 1200;
  let questions = [];
  let current = 0;
  let results = []; // {q, correctAnswer, userAnswer, correct}
  let recognition = null;
  let recognizing = false;
  let awaitingNext = false; // 正誤判定後、次の設問に移るまでの間は新たな回答を受け付けない

  const $ = id => document.getElementById(id);
  const progressEl = $('progress');
  const questionEl = $('question');
  const statusLineEl = $('statusLine');
  const answerDisplayEl = $('answerDisplay');
  const micBtn = $('micBtn');
  const micIcon = $('micIcon');
  const micLabel = $('micLabel');
  const textInput = $('textInput');
  const submitBtn = $('submitBtn');
  const noteEl = $('note');
  const quizView = $('quizView');
  const resultView = $('resultView');
  const scoreText = $('scoreText');
  const scoreMsg = $('scoreMsg');
  const resultList = $('resultList');
  const retryBtn = $('retryBtn');

  // ---- 問題生成 ----
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function generateQuestion() {
    const ops = ['+', '-', '×', '÷'];
    const op = ops[randInt(0, ops.length - 1)];
    let a, b, answer;

    if (op === '+' || op === '-') {
      a = randInt(1, 50);
      b = randInt(1, 50);
      if (op === '-' && a < b) [a, b] = [b, a]; // 負の数を避ける
      answer = op === '+' ? a + b : a - b;
    } else if (op === '×') {
      a = randInt(1, 12);
      b = randInt(1, 12);
      answer = a * b;
    } else { // ÷ 割り切れる組み合わせのみ
      b = randInt(1, 9);
      const q = randInt(1, 12);
      a = b * q;
      answer = q;
    }
    return { text: `${a} ${op} ${b} =`, answer };
  }

  function generateSet() {
    questions = [];
    for (let i = 0; i < TOTAL; i++) questions.push(generateQuestion());
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
  }

  function renderQuestion() {
    awaitingNext = false;
    setInputsDisabled(false);
    statusLineEl.textContent = '';
    statusLineEl.className = 'status-line';
    answerDisplayEl.innerHTML = '&nbsp;';
    textInput.value = '';
    questionEl.textContent = questions[current].text;
    renderProgress();
  }

  // ---- 連打防止 ----
  function setInputsDisabled(disabled) {
    submitBtn.disabled = disabled;
    textInput.disabled = disabled;
    if (SpeechRecognition) micBtn.disabled = disabled;
    // 入力を受け付けない間はマイクも必ずオフにする(テキスト回答時に音声認識が
    // 聞き取り中のまま残る、最終問題後もマイクがオンのままになる、等を防ぐ)
    if (disabled && recognition && recognizing) {
      recognition.abort();
    }
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

  // ---- 回答処理 ----
  function submitAnswer(rawText, source) {
    if (awaitingNext) return; // 次の設問への遷移待ち中は連打を無視

    const userNum = extractNumber(rawText);
    answerDisplayEl.textContent = rawText ? `認識結果: 「${rawText}」` : '';

    if (userNum === null) {
      statusLineEl.textContent = '数字が聞き取れませんでした。もう一度お願いします。';
      statusLineEl.className = 'status-line wrong';
      return;
    }

    awaitingNext = true;
    setInputsDisabled(true);

    const correctAnswer = questions[current].answer;
    const isCorrect = userNum === correctAnswer;

    results.push({
      q: questions[current].text,
      correctAnswer,
      userAnswer: userNum,
      correct: isCorrect
    });

    statusLineEl.textContent = isCorrect
      ? `正解！ (${userNum})`
      : `不正解… 正解は ${correctAnswer}`;
    statusLineEl.className = 'status-line ' + (isCorrect ? 'correct' : 'wrong');

    renderProgress();

    setTimeout(() => {
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
    if (!recognition || recognizing) return;
    try {
      recognition.start();
    } catch (e) {
      // 既に開始中などの例外を無視
    }
  });

  submitBtn.addEventListener('click', () => {
    if (!textInput.value.trim()) return;
    submitAnswer(textInput.value, 'text');
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitBtn.click();
    }
  });

  // ---- 結果表示 ----
  function showResult() {
    quizView.classList.add('hidden');
    resultView.classList.remove('hidden');

    const correctCount = results.filter(r => r.correct).length;
    scoreText.textContent = `${correctCount}/${TOTAL}`;

    let msg;
    if (correctCount === TOTAL) msg = 'パーフェクト！お見事です。';
    else if (correctCount >= TOTAL * 0.6) msg = 'いい調子！もう少しで満点。';
    else msg = '練習あるのみ。もう一度挑戦してみよう。';
    scoreMsg.textContent = msg;

    resultList.innerHTML = '';
    results.forEach(r => {
      const li = document.createElement('li');
      const okClass = r.correct ? 'ok' : 'ng';
      li.innerHTML = `<span>${r.q} ${r.correctAnswer}</span><span class="${okClass}">${r.correct ? '正解' : `あなた: ${r.userAnswer}`}</span>`;
      resultList.appendChild(li);
    });
  }

  retryBtn.addEventListener('click', startQuiz);

  function startQuiz() {
    current = 0;
    results = [];
    generateSet();
    resultView.classList.add('hidden');
    quizView.classList.remove('hidden');
    renderQuestion();
  }

  setupRecognition();
  startQuiz();
})();
