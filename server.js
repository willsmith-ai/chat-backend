/**
 * Clarety Core AI backend (Render-friendly)
 *
 * Supports (backwards + forwards compatible):
 * - JSON chat requests:
 *    { query, sessionId, imageDataUrl }  // imageDataUrl = "data:image/...;base64,..."
 * - multipart/form-data:
 *    fields: query, sessionId
 *    file:   image   (multipart file upload)
 *
 * Features:
 * - Discovery Engine retrieval (RAG) for Clarety/how-to + for tone/terminology on writing requests
 * - Gemini via Vertex AI OpenAI-compatible chat/completions endpoint
 * - Simple per-session memory (in-memory; resets on deploy)
 *
 * ENV VARS REQUIRED:
 *   GOOGLE_JSON_KEY           = service account JSON (stringified)
 *   DE_PROJECT_NUMBER         = 28062079972
 *   DE_LOCATION               = global
 *   DE_COLLECTION_ID          = default_collection
 *   DE_ENGINE_ID              = claretycoreai_1767340856472
 *   DE_SERVING_CONFIG_ID      = default_search
 *
 * OPTIONAL:
 *   GEMINI_PROJECT_ID         = groovy-root-483105-n9
 *   GEMINI_LOCATION           = us-central1
 *   GEMINI_MODEL              = google/gemini-2.0-flash-001   (vision-capable)
 *   ALLOWED_ORIGIN            = * or your github pages domain
 *   MAX_IMAGE_MB              = 6
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { GoogleAuth } = require("google-auth-library");

const app = express();

// JSON body (normal requests). Keep this low; images should come via data URL or multipart.
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// -------------------- Upload (memory) --------------------
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 6);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 },
});

// -------------------- Helpers --------------------
function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function safeString(v) {
  return (v || "").toString().trim();
}

function getServiceAccountObject() {
  const raw = mustGetEnv("GOOGLE_JSON_KEY");
  const obj = JSON.parse(raw);

  if (!obj.client_email) {
    throw new Error(
      "GOOGLE_JSON_KEY is not a Service Account JSON key (missing client_email). " +
        "Download a Service Account key JSON and paste the entire file contents."
    );
  }

  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  return obj;
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

function fixGsLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.slice(5);
  return link;
}

function base64DataUrlFromFile(file) {
  if (!file || !file.buffer) return null;
  const mime = file.mimetype || "image/png";
  const b64 = file.buffer.toString("base64");
  return `data:${mime};base64,${b64}`;
}

// Accepts either a data URL, or just raw base64 (we’ll treat as png), or empty.
function normalizeImageDataUrl(maybeDataUrl) {
  if (!maybeDataUrl) return null;
  const s = maybeDataUrl.toString().trim();
  if (!s) return null;

  // If it already looks like a data URL, keep it.
  if (s.startsWith("data:image/") && s.includes(";base64,")) return s;

  // If it looks like base64 without header, wrap it (assume png).
  // (This keeps the server tolerant if the frontend accidentally strips the prefix.)
  const b64ish = /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100;
  if (b64ish) return `data:image/png;base64,${s.replace(/\s/g, "")}`;

  return null;
}

function isGreeting(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(hi|hello|hey|hiya|yo|good\s(morning|afternoon|evening)|howdy|sup)(\b|!|\.)/.test(t);
}

function isWritingRequest(text) {
  const t = (text || "").toLowerCase();
  return (
    ((/(draft|write|rewrite|create|compose|prepare)\b/.test(t) &&
      /(email|appeal|template|letter|message|subject line|copy|newsletter)\b/.test(t)) ||
      /(draft an email|write an email|draft me an appeal|write an appeal)/i.test(text || ""))
  );
}

function looksLikeFactualHowTo(text) {
  const t = (text || "").toLowerCase();
  return /(how do i|how to|where do i|what is|can i|steps|process|workflow|policy|setup|configure)/.test(t);
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

const geminiUrl = `https://aiplatform.googleapis.com/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/endpoints/openapi/chat/completions`;

// -------------------- Simple memory (in-memory) --------------------
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_TURNS = 12; // keep some context without ballooning tokens
const sessionStore = new Map(); // sessionId -> { updatedAt, messages: [] }

function getSession(sessionId) {
  const sid = sessionId || "default";
  const now = Date.now();
  const existing = sessionStore.get(sid);

  if (existing && now - existing.updatedAt < SESSION_TTL_MS) {
    existing.updatedAt = now;
    return existing;
  }

  const fresh = { updatedAt: now, messages: [] };
  sessionStore.set(sid, fresh);
  return fresh;
}

function addToSession(sessionId, role, content) {
  const s = getSession(sessionId);
  s.messages.push({ role, content });
  if (s.messages.length > MAX_TURNS) {
    s.messages = s.messages.slice(s.messages.length - MAX_TURNS);
  }
  s.updatedAt = Date.now();
}

function getSessionMessages(sessionId) {
  return getSession(sessionId).messages.slice();
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("Backend is running!"));

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || null,
    deServingConfig: `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/${DE_SERVING_CONFIG_ID}`,
    geminiModel: GEMINI_MODEL,
    geminiEndpoint: `${GEMINI_PROJECT_ID}/${GEMINI_LOCATION}`,
    maxImageMB: MAX_IMAGE_MB,
  });
});

/**
 * Debug endpoint: retrieval only
 */
app.get("/debug-search", async (req, res) => {
  try {
    const q = safeString(req.query.q);
    const token = await getAccessToken();

    const url =
      `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
      `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
      `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;

    const body = {
      query: q,
      pageSize: 10,
      queryExpansionSpec: { condition: "AUTO" },
      spellCorrectionSpec: { mode: "AUTO" },
      languageCode: "en-US",
      userInfo: { timeZone: "Asia/Saigon" },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await r.json();

    res.status(r.status).json({
      url,
      status: r.status,
      totalSize: json.totalSize ?? null,
      results: (json.results || []).map((x) => ({
        title: x?.document?.derivedStructData?.title || null,
        link: x?.document?.derivedStructData?.link || null,
        extractive: x?.document?.derivedStructData?.extractive_answers?.[0]?.content || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Main chat endpoint
 *
 * Accepts:
 * - JSON: { query, sessionId, imageDataUrl }
 * - multipart/form-data: fields query, sessionId, and file "image"
 *
 * IMPORTANT:
 * This is intentionally tolerant so changing index.html won't silently break images again.
 */
app.post("/chat", upload.single("image"), async (req, res) => {
  try {
    const sessionId = safeString(req.body.sessionId) || "default";
    const userQuery = safeString(req.body.query);

    // ✅ Backwards compatible:
    // - If frontend sends base64 data URL in JSON (imageDataUrl), use it.
    // ✅ Forwards compatible:
    // - If frontend sends multipart image file, convert to data URL.
    const bodyImageDataUrl = normalizeImageDataUrl(req.body.imageDataUrl || req.body.image || req.body.image_data_url);
    const fileImageDataUrl = base64DataUrlFromFile(req.file);
    const imageDataUrl = bodyImageDataUrl || fileImageDataUrl;
    const hasImage = !!imageDataUrl;

    console.log("=================================");
    console.log("CHAT REQUEST", {
      sessionId,
      hasImage,
      queryLen: userQuery.length,
      hasBodyImage: !!bodyImageDataUrl,
      hasFileImage: !!req.file,
      mime: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
    });
    console.log("=================================");

    // Greeting override (only when no image)
    if (!hasImage && isGreeting(userQuery)) {
      const greeting =
        "Hi 👋 I’m the Clarety Assistant.\n" +
        "Ask a Clarety question, or say “draft an email…” and I’ll help.";
      addToSession(sessionId, "user", userQuery);
      addToSession(sessionId, "assistant", greeting);
      return res.json({ answer: greeting, links: [] });
    }

    if (!hasImage && !userQuery) {
      return res.json({
        answer: "Type a question — or upload a screenshot and ask what you want me to look at.",
        links: [],
      });
    }

    // Decide intent
    const writing = isWritingRequest(userQuery);
    const factual = looksLikeFactualHowTo(userQuery) && !writing;

    // Retrieval: do NOT retrieve for image questions (usually irrelevant)
    const shouldRetrieve = !hasImage && !!userQuery;

    // Retrieval results
    let snippets = [];
    let links = [];
    let retrievalCount = 0;

    const token = await getAccessToken();

    if (shouldRetrieve) {
      const searchUrl =
        `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
        `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
        `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;

      const searchBody = {
        query: userQuery,
        pageSize: 8,
        queryExpansionSpec: { condition: "AUTO" },
        spellCorrectionSpec: { mode: "AUTO" },
        languageCode: "en-US",
        userInfo: { timeZone: "Asia/Saigon" },
      };

      const searchResp = await fetch(searchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(searchBody),
      });

      const searchJson = await searchResp.json();
      const results = searchJson.results || [];
      retrievalCount = results.length;

      for (const r of results) {
        const d = r?.document?.derivedStructData || {};
        if (d.title && d.link) links.push({ title: d.title, url: fixGsLink(d.link) });
        const ea = d?.extractive_answers?.[0]?.content;
        if (ea) snippets.push(`- ${d.title || "Source"}: ${ea}`);
      }

      // dedupe links
      const seen = new Set();
      links = links.filter((x) => {
        const k = `${x.title}::${x.url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // System instructions (prevents the “pressing for more info” loop)
    const system = [
      "You are the Clarety Core AI Assistant.",
      "You are helpful, warm, professional, and human.",
      "You are an expert fundraising assistant and copywriter.",
      "",
      "Rules:",
      "- If the user asks you to draft/write/rewrite an email/appeal/template: produce a complete draft immediately.",
      "  Do NOT refuse. Do NOT ask multiple follow-up questions.",
      "  If details are missing, make sensible assumptions and use placeholders like [Organisation Name], [Donation Link], [First Name].",
      "- If the user asks Clarety how-to/process/policy: use provided snippets when available; if unclear, ask at most ONE clarifying question.",
      "- Do not mention internal systems or that you searched anything.",
      "",
      "If an image is provided:",
      "- Use the image. Describe what it shows and answer the user's question about it.",
      "- If unclear, say what’s unclear and what you'd need to see."
    ].join("\n");

    // Conversation memory
    const history = getSessionMessages(sessionId);

    // Store user turn (don’t store raw base64)
    addToSession(sessionId, "user", hasImage ? `[Image uploaded] ${userQuery || ""}`.trim() : userQuery);

    const contextBlock =
      snippets.length > 0
        ? "Helpful reference snippets:\n" + snippets.slice(0, 8).join("\n")
        : "";

    const nudge =
      writing
        ? "The user wants you to write the draft now without further questions. Make reasonable assumptions and proceed."
        : "";

    const messages = [{ role: "system", content: system }];

    // add prior turns
    for (const m of history) {
      if (m.role === "system") continue;
      messages.push({ role: m.role, content: m.content });
    }

    if (hasImage) {
      const userText =
        (userQuery ? `User question: ${userQuery}\n` : "User uploaded an image.\n") +
        (nudge ? `\n${nudge}\n` : "") +
        (contextBlock ? `\n${contextBlock}\n` : "");

      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      });
    } else {
      const userText =
        `User message: ${userQuery}\n` +
        (nudge ? `\n${nudge}\n` : "") +
        (contextBlock ? `\n${contextBlock}\n` : "") +
        (factual && snippets.length === 0
          ? "\nNote: No reference snippets were found. Provide best-effort guidance and ask at most ONE clarifying question if truly needed.\n"
          : "");

      messages.push({ role: "user", content: userText });
    }

    // Call Gemini
    const genBody = {
      model: GEMINI_MODEL,
      messages,
      temperature: writing ? 0.7 : 0.2,
    };

    const genResp = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(genBody),
    });

    const genJson = await genResp.json();

    if (!genResp.ok) {
      const msg = genJson?.error?.message || `Gemini failed (${genResp.status})`;
      throw new Error(msg);
    }

    const answer =
      genJson?.choices?.[0]?.message?.content ||
      "I found information, but couldn't generate a response.";

    addToSession(sessionId, "assistant", answer);

    // If you later want to show links, return `links` instead of []
    return res.json({
      answer,
      links: [],
      meta: { hasImage, retrievalCount, writing, factual },
    });
  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    return res.status(500).json({
      answer: "Backend error",
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
