# Paper Reader

Paper Reader is a desktop PDF reader for papers. It renders local PDFs, lets you select a word or one sentence, and asks a local Ollama model to explain or translate the selected text in Korean.

The app is built with Electron, PDF.js, a small Node HTTP server, and Ollama.

## Features

- Open local PDF files in a desktop app
- Remember recently opened PDFs in the Electron app
- Render PDF pages with selectable word tokens
- Double-click a word to translate that word
- Double-click the same selected word again to select its sentence
- Hold Shift while selecting to append more words from the same sentence
- Drag selection is limited to one sentence
- Show translation results near the selected text
- Cancel older translation requests when a new selection starts
- Store the viewer zoom value between app launches
- Package as macOS, Windows, or Linux desktop builds

## Requirements

- Node.js 22 or newer recommended
- npm
- Ollama installed locally
- Ollama model named `translategemma`

Check Ollama and the model:

```bash
ollama list
```

If Ollama is not running:

```bash
ollama serve
```

The app calls Ollama at `http://127.0.0.1:11434` by default.

## Install

```bash
npm install
```

## Run As A Desktop App

```bash
npm run app:dev
```

The Electron app starts an internal local server on an available port and opens the app window.

## Run In A Browser

```bash
npm start
```

Then open:

```text
http://localhost:3001
```

Recent-file reopening is only available in the Electron app. Browsers cannot reopen arbitrary local file paths for security reasons.

## Configuration

Use a different Ollama host:

```bash
OLLAMA_HOST=http://127.0.0.1:11434 npm run app:dev
```

Use a different Ollama model:

```bash
OLLAMA_MODEL=translategemma npm run app:dev
```

The default values are:

```text
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=translategemma
```

## Package

Build an unpacked app directory:

```bash
npm run pack
```

Build installers/packages:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Build outputs are written to `release/`.

For best results, build each platform on that platform. For example, build the Windows installer on Windows and the macOS DMG on macOS.

## macOS Notes

The default build uses ad-hoc signing. For public macOS distribution, configure:

- Apple Developer signing identity
- hardened runtime
- notarization
- a stable bundle identifier

Until then, users may see Gatekeeper warnings when opening downloaded builds.

## Project Structure

```text
.
├── app.js                 # PDF viewer and translation UI
├── index.html             # App shell
├── styles.css             # UI styles
├── server.js              # Static server and Ollama translation endpoint
├── electron/
│   ├── main.js            # Electron main process
│   └── preload.js         # Safe bridge for recent file APIs
├── build/
│   ├── icon.svg           # Icon source
│   ├── icon.png           # Icon preview/source bitmap
│   └── icon.icns          # macOS app icon
├── package.json
└── package-lock.json
```

Generated directories such as `node_modules/` and `release/` are ignored.

## Translation Flow

```text
PDF selection
-> browser UI extracts selected text and nearby context
-> POST /api/translate
-> Node server builds the prompt
-> Ollama runs translategemma
-> translation appears near the selection
```

Short word or phrase selections use a word/phrase explanation prompt. Longer selections or selections with sentence punctuation use a sentence/passage translation prompt.

## Development Checks

```bash
node --check app.js
node --check server.js
node --check electron/main.js
node --check electron/preload.js
```

## Repository Hygiene

Commit these:

- source files
- `package.json`
- `package-lock.json`
- `build/icon.svg`
- `build/icon.png`
- `build/icon.icns`

Do not commit these:

- `node_modules/`
- `release/`
- generated installer files
- temporary iconset files
