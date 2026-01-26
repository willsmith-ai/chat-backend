/**
 * Clarety Core AI backend (Render-friendly) + Image Uploads
 *
 * Adds:
 * ✅ /chat supports image uploads (multipart/form-data) OR base64 via JSON
 * ✅ Gemini multimodal via OpenAI-compatible chat/completions: content = [text, image_url]
 * ✅ Drafting memory: short follow-ups modify prior draft (no interrogation)
 * ✅ RAG for Clarety how-to; fallback to generative if retrieval is weak
 *
 * ENV VARS REQUIRED:
 *   GOOGLE_JSON_KEY
 *   DE_PROJECT_NUMBER
 *   DE_LOCATION
 *   DE_COLLECTION_ID
 *   DE_ENGINE_ID
 *   DE_SERVING_CONFIG_ID
 *
 * OPTIONAL:
 *   GEMINI_PROJECT_ID
 *   GEMINI_LOCATION
 *   GEMINI_MODEL
 *   ALLOWED_ORIGIN
 *   MEMORY_TTL_MINUTES (default 60)
 *   MEMORY_MAX_TURNS   (default 12)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { GoogleAuth } = require("google-auth-library");

const app = express();

// JSON for non-multipart requests
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// -------------------- fetch (Node 18 has global fetch; fallback if needed) --------------------
const fetchFn =
  globalThis.fetch ||
  (async (...args) => {
    const mod = await import("node-fetch");
    return mod.default(...args);
  });

// -------------------- Multer (in-memory upload) --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6MB
  },
});

// -------------------- Helpers --------------------
function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getServiceAccountObject() {
  const raw = mustGetEnv("GOOGLE_JSON_KEY");
  const obj = JSON.parse(raw);

  if (!obj.client_email) {
    throw new Error(
      "The incoming JSON object does not contain a client_email field. " +
        "Your GOOGLE_JSON_KEY is not a service account key JSON. " +
        "Download a Service Account key (JSON) and paste the entire file contents."
    );
  }

  if (obj.private_key) {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }
  return obj;
}

function fixGsLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.slice(5);
  return link;
}

async function getAccessToken() {
  const sa = getServiceAccountObject();
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse && tokenResponse.token ? tokenResponse.token : tokenResponse;
  if (!token) throw new Error("Failed to obtain access token from service account credentials.");
  return token;
}

function nowMs() {
  return Date.now();
}

function normalize(text) {
  return (text || "").toString().trim();
}

// -------------------- Config --------------------
const DE_PROJECT_NUMBER = mustGetEnv("DE_PROJECT_NUMBER");
const DE_LOCATION = mustGetEnv("DE_LOCATION");
const DE_COLLECTION_ID = mustGetEnv("DE_COLLECTION_ID");
const DE_ENGINE_ID = mustGetEnv("DE_ENGINE_ID");
const DE_SERVING_CONFIG_ID = mustGetEnv("DE_SERVING_CONFIG_ID");

const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID || "groovy-root-483105-n9";
const GEMINI_LOCATION = process.env.GEMINI_LOCATION || "us-central1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "google/gemini-2.0-flash-001";

const MEMORY_TTL_MINUTES = Number(process.env.MEMORY_TTL_MINUTES || 60);
const MEMORY_MAX_TURNS = Number(process.env.MEMORY_MAX_TURNS || 12);

// -------------------- Lightweight session memory (in-process) --------------------
const sessions = new Map();

function getSessionKeyFrom(req, sessionIdMaybe) {
  if (sessionIdMaybe) return String(sessionIdMaybe);

  const sidHeader = req.headers["x-session-id"];
  if (sidHeader) return String(sidHeader);

  const ua = req.headers["user-agent"] || "ua";
  return `${req.ip}:${ua}`;
}

function getOrCreateSession(key) {
  const existing = sessions.get(key);
  const expiry = nowMs() - MEMORY_TTL_MINUTES * 60 * 1000;

  if (existing && existing.updatedAt > expiry) return existing;

  const fresh = {
    updatedAt: nowMs(),
    mode: "auto", // "auto" | "writing" | "rag"
    history: [], // {role:"user"|"assistant", content:string}
    lastDraft: null, // string
    lastDraftType: null,
  };
  sessions.set(key, fresh);
  return fresh;
}

function touchSession(key, session) {
  session.updatedAt = nowMs();
  sessions.set(key, session);
}

function addToHistory(session, role, content) {
  if (!content) return;
  session.history.push({ role, content: String(content) });

  const maxMsgs = MEMORY_MAX_TURNS * 2;
  if (session.history.length > maxMsgs) {
    session.history = session.history.slice(session.history.length - maxMsgs);
  }
}

// cleanup
setInterval(() => {
  const expiry = nowMs() - MEMORY_TTL_MINUTES * 60 * 1000;
  for (const [k, v] of sessions.entries()) {
    if (!v || v.updatedAt < expiry) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

// -------------------- Intent detection --------------------
function isGreeting(text) {
  const t = normalize(text).toLowerCase();
  if (!t) return false;

  if (t.length <= 30) {
    if (
      /^(hi|hello|hey|yo|hiya|howdy|sup|good morning|good afternoon|good evening|thanks|thank you|thx)\b/.test(
        t
      )
    )
      return true;
  }
  if (/^(how are you|how's it going|hows it going|what's up|whats up)\b/.test(t)) return true;
  return false;
}

function isClaretyHowTo(text) {
  const t = normalize(text).toLowerCase();
  return (
    /\b(how do i|how to|where do i|can i|what is|workflow|policy|process|in clarety|workspace|case|conversation|template|merge rules|direct debit|sdda|rtd|qualys|pci)\b/.test(
      t
    )
  );
}

function isWritingRequest(text) {
  const t = normalize(text).toLowerCase();
  if (!t) return false;

  if (/\b(write|draft|compose|create|generate)\b.*\b(email|appeal|template|newsletter|sms|copy)\b/.test(t))
    return true;

  if (/\b(rewrite|reword|polish|improve|shorten|expand|tidy up)\b/.test(t)) return true;

  if (/\bwrite (it|this) (for me|now)\b/.test(t)) return true;

  return false;
}

function forceWriteNow(text) {
  const t = normalize(text).toLowerCase();
  return /\b(write it now|just write it|no further details|example only|without details|do it now|stop asking|dont ask|don't ask)\b/.test(
    t
  );
}

function isWritingContinuation(text, session) {
  if (!session || session.mode !== "writing") return false;
  const t = normalize(text);
  if (!t) return false;
  if (isClaretyHowTo(t)) return false;

  if (t.length <= 200) return true;
  if (/^(yes|yeah|yep|no|nope|ok|okay|sure|do it|go ahead)$/i.test(t)) return true;

  return false;
}

function inferDraftType(text) {
  const t = normalize(text).toLowerCase();
  if (t.includes("appeal")) return "appeal";
  if (t.includes("newsletter")) return "newsletter";
  if (t.includes("sms")) return "sms";
  if (t.includes("template")) return "template";
  return "email";
}

// -------------------- Gemini call (multimodal) --------------------
function makeImageDataUrl({ mime, base64 }) {
  if (!mime || !base64) return null;
  return `data:${mime};base64,${base64}`;
}

async function callGemini({ token, system, messages, temperature = 0.4 }) {
  const geminiUrl = `https://aiplatform.googleapis.com/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/endpoints/openapi/chat/completions`;

  const body = {
    model: GEMINI_MODEL,
    messages: [{ role: "system", content: system }, ...messages],
    temperature,
  };

  const resp = await fetchFn(geminiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();

  if (!resp.ok) {
    const msg = json?.error?.message || `Gemini chat/completions failed (${resp.status})`;
    throw new Error(msg);
  }

  return json?.choices?.[0]?.message?.content || "";
}

// -------------------- Discovery Engine search --------------------
async function searchDiscoveryEngine({ token, query }) {
  const searchUrl =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
    `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
    `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;

  const searchBody = {
    query,
    pageSize: 10,
    queryExpansionSpec: { condition: "AUTO" },
    spellCorrectionSpec: { mode: "AUTO" },
    languageCode: "en-US",
    userInfo: { timeZone: "Asia/Saigon" },
  };

  const resp = await fetchFn(searchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchBody),
  });

  const json = await resp.json();
  const results = json.results || [];

  const links = [];
  const snippets = [];

  for (const r of results) {
    const d = r?.document?.derivedStructData || {};
    if (d.title && d.link) links.push({ title: d.title, url: fixGsLink(d.link) });

    const ea = d?.extractive_answers?.[0]?.content;
    if (ea) snippets.push(`- ${d.title || "Source"}: ${ea}`);
  }

  return { results, links, snippets, raw: json };
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("Backend is running!"));

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || null,
    deServingConfig: `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/${DE_SERVING_CONFIG_ID}`,
    geminiModel: GEMINI_MODEL,
    memory: { ttlMinutes: MEMORY_TTL_MINUTES, maxTurns: MEMORY_MAX_TURNS },
  });
});

app.get("/debug-search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    const token = await getAccessToken();
    const { results, links, snippets, raw } = await searchDiscoveryEngine({ token, query: q });

    res.json({
      status: 200,
      totalSize: raw.totalSize ?? null,
      results: results.map((x) => ({
        title: x?.document?.derivedStructData?.title || null,
        link: x?.document?.derivedStructData?.link || null,
        extractive: x?.document?.derivedStructData?.extractive_answers?.[0]?.content || null,
      })),
      links,
      snippets,
      raw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Main chat endpoint (supports multipart and JSON)
 *
 * Multipart:
 *   fields: query (text), sessionId (optional), includeLinks (optional "true"), image (file)
 *
 * JSON:
 *   { query, sessionId?, includeLinks?, imageBase64?, imageMime? }
 */
app.post("/chat", upload.single("image"), async (req, res) => {
  // If multipart, req.body is text fields and req.file is file
  // If JSON, req.file is undefined and req.body comes from express.json

  const query = normalize(req.body?.query);
  const includeLinks = String(req.body?.includeLinks || "").toLowerCase() === "true";
  const sessionId = req.body?.sessionId;

  // Image sources:
  // - multipart file: req.file
  // - JSON base64: req.body.imageBase64 + req.body.imageMime
  let imageMime = null;
  let imageBase64 = null;
  let imageFilename = null;

  if (req.file && req.file.buffer) {
    imageMime = req.file.mimetype || "image/png";
    imageBase64 = req.file.buffer.toString("base64");
    imageFilename = req.file.originalname || "upload";
  } else if (req.body?.imageBase64 && req.body?.imageMime) {
    imageMime = String(req.body.imageMime);
    imageBase64 = String(req.body.imageBase64);
    imageFilename = "inline";
  }

  if (!query && !imageBase64) {
    return res.json({ answer: "Ask me something, or upload an image.", links: [], mode_used: "gen", confidence: "low" });
  }

  const sessionKey = getSessionKeyFrom(req, sessionId);
  const session = getOrCreateSession(sessionKey);

  try {
    const token = await getAccessToken();

    const greeting = query ? isGreeting(query) : false;
    const claretyHowTo = query ? isClaretyHowTo(query) : false;

    const writingNow =
      (query && (isWritingRequest(query) || forceWriteNow(query))) ||
      (query && isWritingContinuation(query, session)) ||
      // If user uploads an image and says “rewrite this” etc, it should be writing mode
      (imageBase64 && query && /\b(rewrite|reword|polish|improve|draft|write|summari[sz]e|extract|turn this into)\b/i.test(query));

    // mode update
    if (greeting) session.mode = "auto";
    else if (writingNow && !claretyHowTo) session.mode = "writing";
    else if (claretyHowTo) session.mode = "rag";
    else session.mode = session.mode === "writing" ? "writing" : "auto";

    // Base system prompt
    const baseSystem = [
      "You are the Clarety Core AI Assistant.",
      "You are helpful, warm, professional, and human.",
      "You are an expert fundraising assistant and copywriter.",
      "You help answer questions about Clarety, draft emails/templates/appeals, and think through supporter communications.",
      "Do not mention internal systems, searches, sources, or document retrieval.",
      "Never say you can't help if drafting or guidance is possible.",
      "If details are missing, make reasonable assumptions and use placeholders like [Organisation Name].",
    ].join(" ");

    // Build a user message that may include an image
    const imageUrl = imageBase64 ? makeImageDataUrl({ mime: imageMime, base64: imageBase64 }) : null;

    function makeUserContentWithOptionalImage(text) {
      if (imageUrl) {
        return [
          { type: "text", text: text || "Please analyze the uploaded image and help." },
          { type: "image_url", image_url: { url: imageUrl } },
        ];
      }
      return text || "";
    }

    // greetings (no RAG)
    if (greeting) {
      const system =
        baseSystem +
        " The user is greeting you or making small talk. Respond warmly and briefly. Do not include links or lists.";

      const answer = await callGemini({
        token,
        system,
        messages: [{ role: "user", content: query }],
        temperature: 0.7,
      });

      addToHistory(session, "user", query);
      addToHistory(session, "assistant", answer || "Hi! How can I help today?");
      touchSession(sessionKey, session);

      return res.json({ answer: answer || "Hi! How can I help today?", links: [], mode_used: "gen", confidence: "high" });
    }

    // writing / drafting (no interrogation)
    if (session.mode === "writing" && !claretyHowTo) {
      if (!session.lastDraftType && query) session.lastDraftType = inferDraftType(query);

      const writingSystem =
        baseSystem +
        " The user wants you to draft or rewrite content." +
        " IMPORTANT: You MUST produce a complete draft immediately." +
        " DO NOT ask follow-up or clarifying questions unless the user explicitly asks you to." +
        " If the user provides extra details, incorporate them into the draft." +
        " If an image is provided, read it and use its content." +
        " Provide a subject line if it's an email/appeal." +
        " Output the draft directly, cleanly formatted.";

      const draftContext = session.lastDraft
        ? `PREVIOUS DRAFT (revise this):\n${session.lastDraft}\n\nUSER UPDATE (apply this):\n${query || "(See uploaded image)"}`
        : `USER REQUEST:\n${query || "(See uploaded image)"}\n\nWrite a complete draft now.`;

      const answer = await callGemini({
        token,
        system: writingSystem,
        messages: [
          {
            role: "user",
            content: makeUserContentWithOptionalImage(draftContext),
          },
        ],
        temperature: 0.75,
      });

      // store memory (don’t store base64)
      if (query) addToHistory(session, "user", query);
      else addToHistory(session, "user", `[image uploaded: ${imageFilename || "image"}]`);
      addToHistory(session, "assistant", answer);

      session.lastDraft = (answer || "").slice(0, 9000);
      touchSession(sessionKey, session);

      return res.json({ answer: answer || "Sure — what would you like the draft to say?", links: [], mode_used: "gen", confidence: "high" });
    }

    // Clarety how-to / factual (RAG first; still helpful if empty)
    if (claretyHowTo || session.mode === "rag") {
      const { snippets, links } = query ? await searchDiscoveryEngine({ token, query }) : { snippets: [], links: [] };
      const hasContext = (snippets || []).length > 0;

      const ragSystem =
        baseSystem +
        " The user asked a Clarety factual/process question." +
        " Use the provided reference context if it is relevant." +
        " If the context is incomplete, still provide a best-effort helpful answer." +
        " Ask at most ONE clarifying question only if absolutely necessary." +
        " If an image is provided, use it as additional context." +
        " Do not refuse.";

      const genSystem =
        baseSystem +
        " The user asked a question but you do not have strong reference context." +
        " Still answer as helpfully as possible and ask at most ONE clarifying question if needed." +
        " If an image is provided, use it as context." +
        " Do not refuse.";

      const contextBlock = hasContext
        ? "REFERENCE CONTEXT (may be partial):\n" + snippets.slice(0, 8).join("\n")
        : "";

      const payload = hasContext
        ? `User question:\n${query}\n\n${contextBlock}`
        : (query || "Please analyze the uploaded image and help.");

      const answer = await callGemini({
        token,
        system: hasContext ? ragSystem : genSystem,
        messages: [{ role: "user", content: makeUserContentWithOptionalImage(payload) }],
        temperature: hasContext ? 0.2 : 0.55,
      });

      if (query) addToHistory(session, "user", query);
      else addToHistory(session, "user", `[image uploaded: ${imageFilename || "image"}]`);
      addToHistory(session, "assistant", answer);

      // clear drafting state when in RAG mode
      session.lastDraft = null;
      session.lastDraftType = null;

      touchSession(sessionKey, session);

      return res.json({
        answer: answer || "I can help — what are you trying to do in Clarety?",
        links: includeLinks && hasContext ? links : [],
        mode_used: hasContext ? "rag" : "gen",
        confidence: hasContext ? "high" : "low",
      });
    }

    // General discussion (no RAG by default)
    const generalSystem =
      baseSystem +
      " The user is describing a situation or asking a general question." +
      " Respond helpfully and practically." +
      " Ask at most ONE clarifying question only if absolutely needed." +
      " If an image is provided, analyze it." +
      " Do not refuse.";

    const answer = await callGemini({
      token,
      system: generalSystem,
      messages: [{ role: "user", content: makeUserContentWithOptionalImage(query || "Please analyze the uploaded image and help.") }],
      temperature: 0.65,
    });

    if (query) addToHistory(session, "user", query);
    else addToHistory(session, "user", `[image uploaded: ${imageFilename || "image"}]`);
    addToHistory(session, "assistant", answer);
    touchSession(sessionKey, session);

    return res.json({ answer: answer || "Tell me a bit more and I’ll help.", links: [], mode_used: "gen", confidence: "low" });
  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    return res.status(500).json({
      answer: "Sorry — I hit a backend error. Try again in a moment.",
      error: err.message,
      links: [],
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
