const editor = document.querySelector('#editor');
const form = document.querySelector('#settings-form');
const modelInput = document.querySelector('#model-id');
const modelLink = document.querySelector('#model-link');
const loadButton = document.querySelector('#load-button');
const generateButton = document.querySelector('#generate-button');
const clearButton = document.querySelector('#clear-button');
const statusText = document.querySelector('#status-text');
const statusDot = document.querySelector('#status-dot');
const progressTrack = document.querySelector('#progress-track');
const progressBar = document.querySelector('#progress-bar');
const progressLabel = document.querySelector('#progress-label');
const wordCount = document.querySelector('#word-count');
const toast = document.querySelector('#toast');

const STORAGE_KEY = 'small-type-document';
const SETTINGS_KEY = 'small-type-settings';
const worker = new Worker('./worker.js', { type: 'module' });

let loadedSignature = '';
let isLoading = false;
let isGenerating = false;
let insertion = null;
let toastTimer;

function modelSignature() {
  return [modelInput.value.trim(), form.elements.device.value, form.elements.dtype.value].join('|');
}

function updateModelLink() {
  const id = modelInput.value.trim();
  modelLink.href = id ? `https://huggingface.co/${encodeURI(id)}` : 'https://huggingface.co/models';
}

function setStatus(text, state = '') {
  statusText.textContent = text;
  statusDot.className = `status-dot ${state}`.trim();
}

function setProgress(value) {
  const amount = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${amount}%`;
  progressLabel.textContent = `${Math.round(amount)}%`;
  progressTrack.setAttribute('aria-valuenow', Math.round(amount));
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function updateWordCount() {
  const words = editor.value.trim().match(/\S+/g);
  wordCount.textContent = words ? words.length.toLocaleString() : '0';
}

function saveDocument() {
  try { localStorage.setItem(STORAGE_KEY, editor.value); } catch (_) { /* Storage can be unavailable. */ }
}

function saveSettings() {
  const values = Object.fromEntries(new FormData(form));
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch (_) { /* Storage can be unavailable. */ }
}

function restoreState() {
  try {
    const documentText = localStorage.getItem(STORAGE_KEY);
    if (documentText !== null) editor.value = documentText;
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (settings) {
      for (const [name, value] of Object.entries(settings)) {
        const control = form.elements[name];
        if (!control) continue;
        if (control.type === 'checkbox') control.checked = value === 'on' || value === true;
        else control.value = value;
      }
    }
  } catch (_) { /* Ignore malformed or inaccessible local storage. */ }
  updateWordCount();
  updateModelLink();
}

function generationSettings() {
  const data = new FormData(form);
  const seed = data.get('seed');
  return {
    temperature: Number(data.get('temperature')),
    top_p: Number(data.get('topP')),
    top_k: Number(data.get('topK')),
    max_new_tokens: Number(data.get('maxTokens')),
    repetition_penalty: Number(data.get('repetitionPenalty')),
    stopSequence: String(data.get('stopSequence') || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
    ignoreCase: data.has('ignoreCase'),
    seed: seed === '' ? null : Number(seed),
  };
}

function lockSettings(locked) {
  form.querySelectorAll('input, select').forEach((control) => { control.disabled = locked; });
  loadButton.disabled = locked;
}

function loadModel() {
  const model = modelInput.value.trim();
  if (!model) {
    showToast('Enter a Hugging Face model ID first.');
    modelInput.focus();
    return;
  }

  if (isGenerating) worker.postMessage({ type: 'interrupt' });
  isLoading = true;
  loadedSignature = '';
  loadButton.disabled = true;
  generateButton.disabled = true;
  setProgress(0);
  setStatus('Starting download…', 'loading');
  worker.postMessage({
    type: 'load',
    model,
    device: form.elements.device.value,
    dtype: form.elements.dtype.value,
  });
}

function generate() {
  if (isGenerating) {
    worker.postMessage({ type: 'interrupt' });
    setStatus('Stopping…', 'loading');
    return;
  }

  if (isLoading || loadedSignature !== modelSignature()) {
    showToast(isLoading ? 'The model is still loading.' : 'Load this model and compute configuration first.');
    return;
  }

  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  const before = editor.value.slice(0, start);
  const settings = generationSettings();
  insertion = { before, after: editor.value.slice(end), start, generated: '' };

  isGenerating = true;
  editor.readOnly = true;
  lockSettings(true);
  generateButton.querySelector('span').textContent = '⏹️';
  generateButton.setAttribute('aria-label', 'Stop generating');
  generateButton.title = 'Stop generating';
  setStatus('Writing…', 'loading');
  worker.postMessage({ type: 'generate', prompt: before || '\n', settings });
}

function finishGeneration(message = 'Ready') {
  isGenerating = false;
  editor.readOnly = false;
  lockSettings(false);
  generateButton.querySelector('span').textContent = '▶️';
  generateButton.setAttribute('aria-label', 'Generate text');
  generateButton.title = 'Generate text';
  setStatus(message, 'ready');
  saveDocument();
  updateWordCount();
  if (insertion) {
    const caret = insertion.start + insertion.generated.length;
    editor.focus();
    editor.setSelectionRange(caret, caret);
  }
  insertion = null;
}

worker.addEventListener('message', ({ data }) => {
  if (data.type === 'progress') {
    setProgress(data.value);
    setStatus(data.label || 'Downloading model…', 'loading');
    return;
  }

  if (data.type === 'ready') {
    isLoading = false;
    loadedSignature = [data.model, data.requestedDevice, data.dtype].join('|');
    loadButton.disabled = false;
    loadButton.textContent = 'Reload model';
    generateButton.disabled = false;
    setProgress(100);
    setStatus(`Ready · ${data.device === 'webgpu' ? 'WebGPU' : 'CPU'}`, 'ready');
    showToast(data.fallback ? 'WebGPU was unavailable, so the model loaded on CPU.' : 'Model ready. Press Tab to continue your text.');
    editor.focus();
    return;
  }

  if (data.type === 'token' && insertion) {
    insertion.generated = data.text;
    editor.value = insertion.before + data.text + insertion.after;
    const caret = insertion.start + data.text.length;
    editor.setSelectionRange(caret, caret);
    updateWordCount();
    return;
  }

  if (data.type === 'complete') {
    finishGeneration(data.interrupted ? 'Stopped · ready' : 'Ready');
    return;
  }

  if (data.type === 'error') {
    const wasGenerating = isGenerating;
    isLoading = false;
    loadButton.disabled = false;
    if (wasGenerating) finishGeneration('Ready');
    else {
      generateButton.disabled = loadedSignature !== modelSignature();
      setStatus('Could not load model', 'error');
    }
    showToast(data.message || 'Something went wrong. Check the browser console.');
    console.error(data.error || data.message);
  }
});

worker.addEventListener('error', (event) => {
  isLoading = false;
  loadButton.disabled = false;
  setStatus('Worker error', 'error');
  showToast('The model worker could not start. Serve this folder over HTTP, not file://.');
  console.error(event);
});

editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    generate();
  } else if (event.key === 'Escape' && isGenerating) {
    event.preventDefault();
    worker.postMessage({ type: 'interrupt' });
  }
});

editor.addEventListener('input', () => {
  updateWordCount();
  saveDocument();
});

form.addEventListener('change', () => {
  saveSettings();
  updateModelLink();
  if (loadedSignature && loadedSignature !== modelSignature()) {
    generateButton.disabled = true;
    setStatus('Settings changed · reload model', '');
  }
});

modelInput.addEventListener('input', updateModelLink);
loadButton.addEventListener('click', loadModel);
generateButton.addEventListener('click', generate);
clearButton.addEventListener('click', () => {
  if (!editor.value || window.confirm('Clear the whole page?')) {
    editor.value = '';
    saveDocument();
    updateWordCount();
    editor.focus();
  }
});

restoreState();
