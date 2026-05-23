// ─── GROQ API KEY (для клиентской транскрипции Whisper) ───
const GROQ_KEY = "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";

// Маппинг слайд → вопрос → id скрытого поля
// ИСПРАВЛЕНО: слайды 13, 14, 15 (было 25, 26, 27)
const ORAL_SLIDES = {
  13: { question: "What is your favourite animal?", fieldId: "eng-oral-1" },
  14: { question: "Where are you from?",            fieldId: "eng-oral-2" },
  15: { question: "How are you?",                   fieldId: "eng-oral-3" },
};

// ═══════════════════════════════════════
// АУДИО-РЕКОРДЕР
// ═══════════════════════════════════════

let mediaRecorder  = null;
let audioChunks    = [];
let recordingSlide = null;
let recordingTimer = null;

async function startRecording(slideNum) {
  const btn    = document.getElementById('btn-record-' + slideNum);
  const status = document.getElementById('rec-status-' + slideNum);
  const wave   = document.getElementById('rec-waveform-' + slideNum);

  // Если уже идёт запись — останавливаем
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks  = [];
    recordingSlide = slideNum;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      wave.classList.remove('active');
      clearTimeout(recordingTimer);

      btn.disabled = true;
      btn.innerHTML = '<span class="rec-icon">⏳</span> Анализируем...';
      btn.className = 'btn-record';
      status.textContent = 'Отправляем на анализ...';

      const blob = new Blob(audioChunks, { type: mimeType });
      await analyzeAudio(blob, slideNum);
    };

    mediaRecorder.start();
    btn.className = 'btn-record recording';
    btn.innerHTML = '<span class="rec-icon">⏹️</span> Остановить запись';
    status.textContent = 'Запись идёт... (макс. 15 сек)';
    wave.classList.add('active');

    recordingTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, 15000);

  } catch (err) {
    status.textContent = '⚠️ Нет доступа к микрофону. Разрешите доступ в браузере.';
    console.error(err);
  }
}

async function analyzeAudio(blob, slideNum) {
  const info     = ORAL_SLIDES[slideNum];
  const feedback = document.getElementById('oral-feedback-' + slideNum);
  const btn      = document.getElementById('btn-record-' + slideNum);
  const status   = document.getElementById('rec-status-' + slideNum);

  feedback.className = 'oral-feedback loading';
  feedback.textContent = '🔄 Распознаём речь...';

  try {
    // Шаг 1: Whisper — транскрипция
    const formData = new FormData();
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');
    formData.append('response_format', 'verbose_json');

    const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY },
      body: formData
    });

    const whisperData = await whisperRes.json();
    const transcript  = (whisperData.text || '').trim();

    if (!transcript) {
      showOralError(slideNum, 'Речь не распознана. Попробуйте ещё раз — говорите громче и чётче.');
      return;
    }

    feedback.textContent = '🧠 Оцениваем произношение...';

    // Шаг 2: Groq Llama — оценка
    const prompt = `You are an English pronunciation and fluency evaluator for children aged 8–14.

Question asked: "${info.question}"
Child's transcribed answer: "${transcript}"

Evaluate the child's spoken English response. Be encouraging but honest.
Respond ONLY with valid JSON, no markdown, no extra text:

{
  "fluency": <number 1-10>,
  "pronunciation": <number 1-10>,
  "grammar": <number 1-10>,
  "comment": "<2 sentences in Russian: what was good + one specific tip to improve>"
}

Scoring guide:
- fluency: how naturally and smoothly they spoke (10 = native-like flow)
- pronunciation: how clearly and correctly sounds were produced
- grammar: correctness of the answer to the question
If the answer is off-topic or empty, score all 1-2.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300
      })
    });

    const groqData = await groqRes.json();
    const rawText  = (groqData.choices?.[0]?.message?.content || '').trim();

    let scores;
    try {
      scores = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      showOralError(slideNum, 'Не удалось получить оценку. Попробуйте записать ещё раз.');
      return;
    }

    // Шаг 3: Сохраняем результат
    const summary = `Транскрипт: "${transcript}" | Беглость: ${scores.fluency}/10 | Произношение: ${scores.pronunciation}/10 | Грамматика: ${scores.grammar}/10 | Комментарий: ${scores.comment}`;
    document.getElementById(info.fieldId).value = summary;

    // Шаг 4: Показываем фидбэк
    const colorClass = (n) => n >= 8 ? 'score-green' : n >= 5 ? 'score-yellow' : 'score-red';

    feedback.className = 'oral-feedback show';
    feedback.innerHTML = `
      <div class="of-transcript">💬 Мы услышали: <em>"${transcript}"</em></div>
      <div class="of-scores">
        <div class="of-score-item ${colorClass(scores.fluency)}">
          <div class="score-val">${scores.fluency}<span style="font-size:11px">/10</span></div>
          <div class="score-lbl">Беглость</div>
        </div>
        <div class="of-score-item ${colorClass(scores.pronunciation)}">
          <div class="score-val">${scores.pronunciation}<span style="font-size:11px">/10</span></div>
          <div class="score-lbl">Произношение</div>
        </div>
        <div class="of-score-item ${colorClass(scores.grammar)}">
          <div class="score-val">${scores.grammar}<span style="font-size:11px">/10</span></div>
          <div class="score-lbl">Грамматика</div>
        </div>
      </div>
      <div class="of-comment">💡 ${scores.comment}</div>
    `;

    status.textContent = '';
    btn.className = 'btn-record done';
    btn.innerHTML = '<span class="rec-icon">✅</span> Записать ещё раз';
    btn.disabled  = false;
    btn.onclick   = () => retryRecording(slideNum);

    document.getElementById('next' + slideNum).disabled = false;

  } catch (err) {
    console.error(err);
    showOralError(slideNum, 'Ошибка соединения. Проверьте интернет и попробуйте снова.');
  }
}

function showOralError(slideNum, msg) {
  const feedback = document.getElementById('oral-feedback-' + slideNum);
  const btn      = document.getElementById('btn-record-' + slideNum);
  feedback.className = 'oral-feedback show';
  feedback.innerHTML = `<div class="of-comment" style="color:#c62828;">⚠️ ${msg}</div>`;
  btn.className = 'btn-record';
  btn.innerHTML = '<span class="rec-icon">🎙️</span> Попробовать снова';
  btn.disabled  = false;
  btn.onclick   = () => startRecording(slideNum);
}

function retryRecording(slideNum) {
  const feedback = document.getElementById('oral-feedback-' + slideNum);
  const btn      = document.getElementById('btn-record-' + slideNum);
  const status   = document.getElementById('rec-status-' + slideNum);
  feedback.className = 'oral-feedback';
  feedback.innerHTML = '';
  status.textContent = '';
  btn.className  = 'btn-record';
  btn.innerHTML  = '<span class="rec-icon">🎙️</span> Начать запись';
  btn.onclick    = () => startRecording(slideNum);
  document.getElementById('next' + slideNum).disabled = true;
  const info = ORAL_SLIDES[slideNum];
  if (info) document.getElementById(info.fieldId).value = '';
}

// Пропуск аудио
function skipAudio(slideNum, fieldId) {
  const field = document.getElementById(fieldId);
  if (field) field.value = 'аудио не записано';

  const nextBtn = document.getElementById('next' + slideNum);
  if (nextBtn) nextBtn.disabled = false;

  const skipBtn = document.querySelector('#slide-' + slideNum + ' .btn-skip-audio');
  if (skipBtn) {
    skipBtn.textContent = '✓ Пропущено — можно продолжить';
    skipBtn.style.color = '#16a34a';
    skipBtn.style.borderColor = '#16a34a';
    skipBtn.disabled = true;
  }
}

// ═══════════════════════════════════════
// НАВИГАЦИЯ
// ═══════════════════════════════════════

const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyLDOVSjGTpi2dM64sRkOj-jYaOh32F1xb6b1G4owIU3swWpXJrD5HHazz4qto851_6/exec";

const TOTAL_STEPS = 29;
let currentStep = 1;

// Счётчик правильных ответов по английскому
let engScore = 0;

function startQuiz() {
  document.getElementById('hero').style.display = 'none';
  document.getElementById('quizWrap').classList.add('active');
  updateProgress(1);
}

function updateProgress(step) {
  const pct = ((step - 1) / TOTAL_STEPS) * 100;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('stepLabel').textContent = step + ' из ' + TOTAL_STEPS;
}

function goNext(step) {
  document.getElementById('slide-' + step).classList.remove('active');
  currentStep = step + 1;
  document.getElementById('slide-' + currentStep).classList.add('active');
  updateProgress(currentStep);
  window.scrollTo(0, 0);
}

function goBack(step) {
  document.getElementById('slide-' + step).classList.remove('active');
  currentStep = step - 1;
  document.getElementById('slide-' + currentStep).classList.add('active');
  updateProgress(currentStep);
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════
// ВЫБОР ВАРИАНТОВ
// ═══════════════════════════════════════

function selectOpt(btn, groupId) {
  document.querySelectorAll('#' + groupId + ' .opt').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function toggleOpt(btn, groupId) {
  btn.classList.toggle('selected');
}

function autoNext(step) {
  const nextBtn = document.getElementById('next' + step);
  if (nextBtn) nextBtn.disabled = false;
}

function syncNext(groupId, nextBtnId) {
  const hasAny = !!document.querySelector('#' + groupId + ' .opt.selected');
  document.getElementById(nextBtnId).disabled = !hasAny;
}

// ═══════════════════════════════════════
// АНГЛИЙСКИЙ ЯЗЫК
// ═══════════════════════════════════════

// ИСПРАВЛЕНО:
// 1. Убраны текстовые подписи "Правильно!" / "Не совсем"
// 2. Кнопки НЕ блокируются — пользователь может изменить ответ
// 3. При изменении: старый балл вычитается, новый добавляется

// Хранит было ли уже дано правильно по каждому слайду
const engAnswered = {};

function answerEng(btn, slideNum, isCorrect) {
  const grid = btn.closest('.options-grid');

  // Если уже отвечал — убираем старый балл
  if (engAnswered[slideNum] === true) {
    engScore = Math.max(0, engScore - 1);
  }

  // Снимаем старую подсветку со всех кнопок
  grid.querySelectorAll('.opt').forEach(b => {
    b.classList.remove('selected', 'correct', 'wrong');
    // НЕ блокируем — оставляем возможность изменить ответ
  });

  // Подсвечиваем выбранный
  if (isCorrect) {
    btn.classList.add('selected', 'correct');
    engScore++;
    engAnswered[slideNum] = true;
  } else {
    btn.classList.add('selected', 'wrong');
    // Подсвечиваем правильный вариант
    grid.querySelectorAll('.opt').forEach(b => {
      const oc = b.getAttribute('onclick') || '';
      if (oc.includes(', true)') || oc.includes(',true)')) {
        b.classList.add('correct');
      }
    });
    engAnswered[slideNum] = false;
  }

  // Убираем текстовую подпись — только цветовая подсветка
  const note = document.getElementById('eng-note-' + slideNum);
  if (note) {
    note.textContent = '';
    note.className = 'eng-feedback';
  }

  // Разблокируем «Далее»
  const nextBtn = document.getElementById('next' + slideNum);
  if (nextBtn) nextBtn.disabled = false;
}

// Для первого вводного вопроса (без правильного ответа)
function answerEngIntro(btn, slideNum) {
  document.querySelectorAll('#opts-eng-1 .opt').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const nextBtn = document.getElementById('next' + slideNum);
  if (nextBtn) nextBtn.disabled = false;
}

function getEngLevel() {
  const MAX = 18;
  const pct = engScore / MAX;
  if (pct >= 0.85) return 'Высокий (B1+)';
  if (pct >= 0.60) return 'Средний (A2–B1)';
  if (pct >= 0.35) return 'Базовый (A1–A2)';
  return 'Начальный (Pre-A1)';
}

// ═══════════════════════════════════════
// ЧТЕНИЕ ЗНАЧЕНИЙ
// ═══════════════════════════════════════

function getSelected(groupId) {
  const sel = document.querySelector('#' + groupId + ' .opt.selected');
  if (!sel) return 'не указано';
  const strong = sel.querySelector('strong');
  const span   = sel.querySelector('span');
  return strong
    ? strong.textContent.trim() + (span ? ' — ' + span.textContent.trim() : '')
    : sel.textContent.trim();
}

function getMultiSelected(groupId) {
  const selected = document.querySelectorAll('#' + groupId + ' .opt.selected');
  if (!selected.length) return 'не указано';
  return Array.from(selected)
    .map(btn => (btn.querySelector('strong') || btn).textContent.trim())
    .filter(Boolean)
    .join(', ');
}

// ═══════════════════════════════════════
// КОНТАКТНАЯ ФОРМА
// ═══════════════════════════════════════

function checkContact() {
  const name  = document.getElementById('parentName').value.trim();
  const email = document.getElementById('parentEmail').value.trim();
  document.getElementById('nextSubmit').disabled = !(name && email);
}

// ═══════════════════════════════════════
// ОТПРАВКА
// ИСПРАВЛЕНО: убраны несуществующие поля (interest, screenTime и др.)
// Собираем только то, что реально есть в этом HTML
// ═══════════════════════════════════════

async function submitQuiz() {
  const parentName  = document.getElementById('parentName').value.trim();
  const parentEmail = document.getElementById('parentEmail').value.trim();
  const errorMsg    = document.getElementById('errorMsg');

  if (!parentName || !parentEmail) {
    errorMsg.style.display = 'block';
    return;
  }
  errorMsg.style.display = 'none';

  const data = {
    // О ребёнке
    childName:  document.getElementById('childName').value.trim(),
    childAge:   document.getElementById('ageRange').value,
    childClass: (document.getElementById('childClass').value || '').trim() || 'не указан',
    // ИИ
    aiAwareness: getSelected('opts-ai-awareness'),
    aiUsage:     getSelected('opts-ai-usage'),
    aiPurpose:   getMultiSelected('opts-ai-purpose'),
    // Английский
    engScore:  engScore,
    engLevel:  getEngLevel(),
    engOral1:  (document.getElementById('eng-oral-1') || {}).value || 'не записано',
    engOral2:  (document.getElementById('eng-oral-2') || {}).value || 'не записано',
    engOral3:  (document.getElementById('eng-oral-3') || {}).value || 'не записано',
    // Контакт
    parentName,
    parentEmail,
    notes: (document.getElementById('notes').value || '').trim() || 'нет',
  };

  document.getElementById('quizWrap').classList.remove('active');
  document.getElementById('sendingScreen').classList.add('active');

  try {
    await fetch(WEB_APP_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch(e) {
    console.log('Sent (no-cors mode)');
  }

  setTimeout(() => {
    document.getElementById('sendingScreen').classList.remove('active');
    document.getElementById('successEmail').textContent = parentEmail;
    document.getElementById('successScreen').classList.add('active');
  }, 2500);
}

// ═══════════════════════════════════════
// СБРОС
// ИСПРАВЛЕНО: аудио-сброс на слайдах 13, 14, 15 (было 25, 26, 27)
// ═══════════════════════════════════════

function restart() {
  document.getElementById('successScreen').classList.remove('active');
  document.getElementById('hero').style.display = 'flex';

  engScore = 0;
  // Сбрасываем флаги ответов
  Object.keys(engAnswered).forEach(k => delete engAnswered[k]);

  // Текстовые поля
  ['childName', 'childClass', 'parentName', 'parentEmail', 'notes',
   'eng-oral-1', 'eng-oral-2', 'eng-oral-3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const ageRange = document.getElementById('ageRange');
  if (ageRange) ageRange.value = 10;
  const ageDisplay = document.getElementById('ageDisplay');
  if (ageDisplay) ageDisplay.textContent = '10 лет';

  // Снимаем все классы выбора
  document.querySelectorAll('.opt').forEach(b => {
    b.classList.remove('selected', 'correct', 'wrong');
    b.disabled = false;
  });

  // Сбрасываем eng-feedback
  document.querySelectorAll('.eng-feedback').forEach(el => {
    el.textContent = '';
    el.className = 'eng-feedback';
  });

  // Сбрасываем аудио-слайды 13, 14, 15
  [13, 14, 15].forEach(slideNum => {
    const feedback = document.getElementById('oral-feedback-' + slideNum);
    const btn      = document.getElementById('btn-record-' + slideNum);
    const status   = document.getElementById('rec-status-' + slideNum);
    const wave     = document.getElementById('rec-waveform-' + slideNum);
    if (feedback) { feedback.className = 'oral-feedback'; feedback.innerHTML = ''; }
    if (status)   { status.textContent = ''; }
    if (wave)     { wave.classList.remove('active'); }
    if (btn) {
      btn.className = 'btn-record';
      btn.innerHTML = '<span class="rec-icon">🎙️</span> Начать запись';
      btn.disabled  = false;
      btn.onclick   = () => startRecording(slideNum);
    }
    // Разблокируем next кнопки аудио-слайдов
    const nextBtn = document.getElementById('next' + slideNum);
    if (nextBtn) nextBtn.disabled = true;
  });

  // Сбрасываем btn-skip-audio
  document.querySelectorAll('.btn-skip-audio').forEach(btn => {
    btn.textContent = '🚫 Не могу записать аудио';
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.disabled = false;
  });

  // Блокируем все кнопки "Далее" где нужен выбор
  const toDisable = [
    'next1',
    'next4', 'next5', 'next6',
    'next7', 'next8', 'next9', 'next10', 'next11', 'next12',
    'next13', 'next14', 'next15',
    'next16', 'next17', 'next18', 'next19', 'next20', 'next21',
    'next22', 'next23', 'next24', 'next25', 'next26', 'next27', 'next28',
    'nextSubmit'
  ];
  toDisable.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });

  // Возвращаем на первый слайд
  document.querySelectorAll('.quiz-slide').forEach(s => s.classList.remove('active'));
  document.getElementById('slide-1').classList.add('active');
  document.getElementById('quizWrap').classList.remove('active');
  currentStep = 1;
  updateProgress(1);
}