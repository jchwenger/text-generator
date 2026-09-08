# Neural Text Generator

A zero-build, single-page writing companion that runs a small open-weight language model locally in the browser with [Transformers.js](https://huggingface.co/docs/transformers.js).

## Run locally

ES modules and model workers need an HTTP origin, so serve the directory instead of opening `index.html` directly.

Using Python (no project dependencies required):

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Alternatively, use [`live-server`](https://www.npmjs.com/package/live-server) for automatic browser refresh while developing:

```sh
npx live-server --port=8000
```

This uses `npx` to download and run `live-server` when needed, so it does not add anything to this project. If it is already installed globally, you can instead run `live-server --port=8000`.

Click **Load model** once, put the cursor anywhere in the editor, and press **Tab** (or use the play button). The first load downloads model files from Hugging Face; compatible files are cached by the browser.

The default is the public base `onnx-community/SmolLM2-135M-ONNX` model at 4-bit precision. It is intended for prefix completion and keeps the first download relatively mobile-friendly. Gemma 3 270M is included as a stronger but larger, licence-gated suggestion. Model and compute settings can be changed before reloading.
