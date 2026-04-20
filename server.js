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

  if (hasSentencePunctuation || wordCount > 6) return "passage";
  if (wordCount <= 1) return "word";
  return "phrase";
}

function buildTranslationPrompt(selectedText, context, selectionType) {
  if (selectionType === "word") {
    return `You are a professional translator and reading assistant.

Language:
- Source: English (en)
- Target: Korean (ko)

Task:
Explain ONLY the selected English word in Korean.

Hard boundary:
- selected_text is the ONLY translation target.
- current_sentence is context only.
- Do NOT translate a phrase that contains selected_text.
- Do NOT include the meaning of nearby adjectives, verbs, adverbs, or nouns in the "해석" field.
- Use nearby words only to choose the correct sense of selected_text.
- The "해석" field must be a Korean word or very short Korean noun phrase for selected_text itself.
- The "해석" field must NOT be a sentence, clause, or full phrase translation.
- If context is needed to explain why this meaning fits, put that context-dependent explanation in "부연설명", not in "해석".

Important example:
If selected_text is "things" and current_sentence contains "do bad things",
then "해석" should be like "일", "것들", or "행동" depending on context.
It must NOT be "나쁜 행동" because "bad" was not selected.

Input:
<selected_text>
${selectedText}
</selected_text>

<context>
previous_sentence: ${context.previousSentence}
current_sentence: ${context.currentSentence}
next_sentence: ${context.nextSentence}
</context>

Guidelines:
1. Decide the contextual sense of selected_text.
2. Keep modifiers from the context out of the direct translation unless they are inside selected_text.
3. You may mention the surrounding phrase in 부연설명 only if it helps clarify the sense.
4. Do not translate any context sentence.
5. Keep "해석" limited to selected_text; put context-sensitive notes in "부연설명".
6. Answer in Korean only.

Output format:
해석: {Korean_meaning_of_selected_word_only}
부연설명: {one_short_Korean_sentence_explaining_the_contextual_sense}`;
  }

  if (selectionType === "phrase") {

    return `You are a professional translator and reading assistant.

Language:
- Source: English (en)
- Target: Korean (ko)

Your role is to explain ONLY the selected short phrase based on context.

Critical rule:
- The translation target is selected_text only.
- previous_sentence, current_sentence, and next_sentence are context only.
- Do NOT translate the full current_sentence.
- Do NOT paraphrase or summarize the surrounding sentence.
- Answer with the contextual Korean meaning of the selected phrase only.
- Do NOT add nearby words that are not included in selected_text to the translation.
- Keep the answer short enough that it cannot be mistaken for a sentence translation.
- The "해석" field must translate the selected_text as it is, even if it is grammatically incomplete.
- If selected_text ends with an unfinished relative clause such as "who", "that", "which", or "where", keep it open in Korean with forms like "~한", "~하는", or "~인".
- Do NOT complete the unfinished phrase using words from context in the "해석" field.
- If context is needed to understand what the unfinished phrase refers to, explain that only in "부연설명".

Important examples:
- selected_text: "and any professional who"
  current_sentence: "... and any professional who has applied for the certification ..."
  해석: "그리고 ~한 모든 전문가"
  부연설명: "뒤 문맥상 그 전문가는 인증을 신청한 사람을 가리킵니다."
- Wrong 해석: "그리고 인증을 신청한 모든 전문가"
- Wrong 해석: "모든 자격증 소지자"

Input:
<selected_text>
${selectedText}
</selected_text>

<context>
previous_sentence: ${context.previousSentence}
current_sentence: ${context.currentSentence}
next_sentence: ${context.nextSentence}
</context>

Guidelines:
1. Use the surrounding context to determine the meaning.
2. Explain only the meaning that fits this context.
3. Do not list irrelevant dictionary meanings.
4. Do not include English examples unless they are part of selected_text.
5. Do not translate any context sentence.
6. Keep "해석" limited to selected_text; put context-sensitive completion or clarification in "부연설명".
7. Be concise and accurate.
8. Answer in Korean only.

Output format:
해석: {contextual_Korean_meaning_of_selected_text_only}
부연설명: {why_this_meaning_fits_the_context_in_one_short_Korean_sentence}`;
  }

  return `You are a professional translator and reading assistant.

Language:
- Source: English (en)
- Target: Korean (ko)

Your role is to translate and interpret a selected sentence or passage based on context.

Critical rule:
- The translation target is selected_text only.
- previous_sentence and next_sentence are context only.
- Do NOT include translations of previous_sentence or next_sentence.

Input:
<selected_text>
${selectedText}
</selected_text>

<context>
previous_sentence: ${context.previousSentence}
next_sentence: ${context.nextSentence}
</context>

Guidelines:
1. Use the surrounding context to understand the meaning.
2. Translate into natural Korean (not word-for-word).
3. Preserve the academic/technical meaning.
4. Translate only selected_text.
5. Be concise and accurate.
6. Answer in Korean only.

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
