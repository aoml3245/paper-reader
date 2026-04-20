const http = require("http");
const fs = require("fs");
const path = require("path");

const defaultPort = Number(process.env.PORT) || 3001;
const publicDir = __dirname;
const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "translategemma";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 200_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function handleTranslate(request, response) {
  const abortController = new AbortController();
  let requestCompleted = false;

  request.on("aborted", () => {
    abortController.abort();
  });

  response.on("close", () => {
    if (!requestCompleted) {
      abortController.abort();
    }
  });

  try {
    const body = await readRequestBody(request);
    if (abortController.signal.aborted) return;

    const payload = JSON.parse(body || "{}");
    const text = String(payload.text || "").trim();

    if (!text) {
      sendJson(response, 400, { error: "text is required" });
      return;
    }

    const selectedText = normalizeWhitespace(text);
    const context = {
      previousSentence: normalizeWhitespace(payload.previousSentence || ""),
      currentSentence: normalizeWhitespace(payload.currentSentence || ""),
      nextSentence: normalizeWhitespace(payload.nextSentence || ""),
    };
    const selectionType = getSelectionType(selectedText);
    const prompt = buildTranslationPrompt(selectedText, context, selectionType);
    const translatedText = await requestOllama(prompt, abortController.signal);

    if (abortController.signal.aborted) return;

    requestCompleted = true;
    sendJson(response, 200, {
      sourceText: selectedText,
      translatedText,
      selectionType,
      model: ollamaModel,
      context,
    });
  } catch (error) {
    if (error.name === "AbortError" || abortController.signal.aborted) {
      return;
    }

    requestCompleted = true;
    if (!response.writableEnded) {
      sendJson(response, 500, { error: error.message });
    }
  }
}

function normalizeWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getSelectionType(selectedText) {
  const wordCount = selectedText.split(/\s+/).filter(Boolean).length;
  const hasSentencePunctuation = /[.!?。！？]/.test(selectedText);

  return hasSentencePunctuation || wordCount > 6 ? "passage" : "phrase";
}

function buildTranslationPrompt(selectedText, context, selectionType) {
  if (selectionType === "phrase") {
    return `You are a professional translator and reading assistant.

Language:
- Source: English (en)
- Target: Korean (ko)

Your role is to explain the meaning of a selected word or phrase based on context.

Input:
- selected_text: ${selectedText}
- previous_sentence: ${context.previousSentence}
- current_sentence: ${context.currentSentence}
- next_sentence: ${context.nextSentence}

Guidelines:
1. Use the surrounding context to determine the meaning.
2. Explain only the meaning that fits this context.
3. Do not list irrelevant dictionary meanings.
4. Be concise and accurate.
5. Answer in Korean only.

Output format:
해석: {only_selectedText_translation}
부연설명: {extra_explanation_if_needed}`;
  }

  return `You are a professional translator and reading assistant.

Language:
- Source: English (en)
- Target: Korean (ko)

Your role is to translate and interpret a selected sentence or passage based on context.

Input:
- selected_text: ${selectedText}
- previous_sentence: ${context.previousSentence}
- next_sentence: ${context.nextSentence}

Guidelines:
1. Use the surrounding context to understand the meaning.
2. Translate into natural Korean (not word-for-word).
3. Preserve the academic/technical meaning.
4. Be concise and accurate.
5. Answer in Korean only.

Output format:
해석: {only_selectedText_translation}
부연설명: {extra_explanation_if_needed}`;
}

async function requestOllama(prompt, signal) {
  const ollamaResponse = await fetch(`${ollamaHost}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
    }),
    signal,
  });

  if (!ollamaResponse.ok) {
    const message = await ollamaResponse.text();
    throw new Error(`Ollama request failed: ${ollamaResponse.status} ${message}`);
  }

  const data = await ollamaResponse.json();
  const answer = String(data.response || "").trim();

  if (!answer) {
    throw new Error("Ollama returned an empty response.");
  }

  return answer;
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const safePath = path
    .normalize(decodeURIComponent(requestUrl.pathname))
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(data);
  });
}

function createServer() {
  return http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/translate") {
      handleTranslate(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response);
      return;
    }

    response.writeHead(405);
    response.end("Method not allowed");
  });
}

function startServer({ port = defaultPort, host } = {}) {
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;

      console.log(`Paper Reader running at http://localhost:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  startServer,
};
