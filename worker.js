import {
  env,
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
  random,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

env.allowLocalModels = false;
// Some browsers do not expose CacheStorage inside module workers. In that
// environment, allow direct fetching instead of making model loading fail.
env.useBrowserCache = typeof caches !== 'undefined';

let generator = null;
let stoppingCriteria = new InterruptableStoppingCriteria();
let files = new Map();

function progressCallback(info) {
  if (info.status === 'initiate') files.set(info.file, { loaded: 0, total: 0 });
  if (info.status === 'progress') files.set(info.file, { loaded: Number(info.loaded) || 0, total: Number(info.total) || 0 });
  if (info.status === 'done' && files.has(info.file)) {
    const file = files.get(info.file);
    file.loaded = file.total || file.loaded;
  }

  const entries = [...files.values()].filter((file) => file.total > 0);
  const total = entries.reduce((sum, file) => sum + file.total, 0);
  const loaded = entries.reduce((sum, file) => sum + Math.min(file.loaded, file.total), 0);
  const value = total ? (loaded / total) * 100 : 0;
  const label = info.status === 'progress' ? `Downloading ${shortName(info.file)}…` : 'Preparing model…';
  self.postMessage({ type: 'progress', value, label });
}

function shortName(path = '') {
  const name = path.split('/').pop() || 'model files';
  return name.length > 28 ? `${name.slice(0, 25)}…` : name;
}

async function disposeGenerator() {
  if (generator?.dispose) await generator.dispose();
  generator = null;
}

function createPipeline(model, device, dtype) {
  return pipeline('text-generation', model, { device, dtype, progress_callback: progressCallback });
}

function findStopIndex(text, sequence, ignoreCase) {
  if (!ignoreCase) return text.indexOf(sequence);
  const escapedSequence = sequence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.search(new RegExp(escapedSequence, 'iu'));
}

async function loadModel({ model, device: requestedDevice, dtype }) {
  try {
    stoppingCriteria.interrupt();
    await disposeGenerator();
    files = new Map();
    let device = requestedDevice === 'auto' ? (self.navigator.gpu ? 'webgpu' : 'wasm') : requestedDevice;
    let fallback = false;

    try {
      generator = await createPipeline(model, device, dtype);
    } catch (error) {
      if (requestedDevice !== 'auto' || device !== 'webgpu') throw error;
      await disposeGenerator();
      files = new Map();
      device = 'wasm';
      fallback = true;
      self.postMessage({ type: 'progress', value: 0, label: 'Trying CPU fallback…' });
      generator = await createPipeline(model, device, dtype);
    }

    self.postMessage({ type: 'ready', model, requestedDevice, device, dtype, fallback });
  } catch (error) {
    self.postMessage({ type: 'error', message: friendlyError(error), error: String(error?.stack || error) });
  }
}

async function generateText({ prompt, settings }) {
  if (!generator) {
    self.postMessage({ type: 'error', message: 'Load a model before generating.' });
    return;
  }

  stoppingCriteria.reset();
  let text = '';
  let interruptedByStop = false;
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      // TextStreamer may flush one more buffered chunk after interruption.
      if (interruptedByStop) return;

      text += chunk;
      if (settings.stopSequence) {
        const stopAt = findStopIndex(text, settings.stopSequence, settings.ignoreCase);
        if (stopAt !== -1) {
          text = text.slice(0, stopAt);
          interruptedByStop = true;
          stoppingCriteria.interrupt();
        }
      }
      self.postMessage({ type: 'token', text });
    },
  });

  const options = {
    max_new_tokens: settings.max_new_tokens,
    repetition_penalty: settings.repetition_penalty,
    do_sample: settings.temperature > 0,
    streamer,
    stopping_criteria: [stoppingCriteria],
  };
  if (options.do_sample) {
    options.temperature = settings.temperature;
    options.top_p = settings.top_p;
    options.top_k = settings.top_k;
  }

  // Transformers.js sampling uses this global PRNG; `seed` is not a
  // GenerationConfig option and would otherwise be ignored by generate().
  if (Number.isInteger(settings.seed)) random.seed(settings.seed);

  try {
    await generator(prompt, options);
    self.postMessage({ type: 'complete', interrupted: stoppingCriteria.interrupted && !interruptedByStop });
  } catch (error) {
    self.postMessage({ type: 'error', message: friendlyError(error), error: String(error?.stack || error) });
  }
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Unknown error');
  if (/unauthorized|401|403|gated/i.test(message)) return 'This model is gated or private. Accept its Hugging Face licence first, or choose a public model.';
  if (/memory|allocation|out of bounds/i.test(message)) return 'The model ran out of memory. Try 4-bit precision, fewer tokens, or a smaller model.';
  if (/fetch|network|download/i.test(message)) return 'The model download failed. Check your connection and try again.';
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}

self.addEventListener('message', ({ data }) => {
  if (data.type === 'load') loadModel(data);
  if (data.type === 'generate') generateText(data);
  if (data.type === 'interrupt') stoppingCriteria.interrupt();
});
