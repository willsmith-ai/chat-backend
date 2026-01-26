
/**
 * Clarety Core AI backend (Render-friendly)
 *
 * Supports:
 * - JSON chat requests { query, sessionId }
 * - Image uploads via multipart/form-data (field: image, plus query/sessionId)
 * - Discovery Engine retrieval (RAG)
 * - Gemini generation via Vertex AI OpenAI-compatible chat/completions endpoint
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

// JSON for normal requests
app.use(express.json({ limit: "1mb" }));

// CORS
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

function isGreeting(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(hi|hello|hey|hiya|yo|good\s(morning|afternoon|evening)|howdy|sup)(\b|!|\.)/.test(t);
}

function isWritingRequest(text) {
  const t = (text || "").toLowerCase();
  return (
    /(draft|write|rewrite|create|compose|prepare)\b/.test(t) &&
    /(email|appeal|template|letter|message|subject line|copy|newsletter)\b/.test(t)
  ) || /(draft an email|write an email|draft me an appeal|write an appeal)/i.test(text || "");
}

function looksLikeFactualHowTo(text) {
  const t = (text || "").toLowerCase();
  return /(how do i|how to|where do i|what is|can i|steps|process|workflow|policy|setup|configure)/.test(t);
}

function safeString(v) {
  return (v || "").toString().trim();
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

// -------------------- Config --------------------
const DE_PROJECT_NUMBER = mustGetEnv("DE_PROJECT_NUMBER");
const DE_LOCATION = mustGetEnv("DE_LOCATION");
const DE_COLLECTION_ID = mustGetEnv("DE_COLLECTION_ID");
const DE_ENGINE_ID = mustGetEnv("DE_ENGINE_ID");
const DE_SERVING_CONFIG_ID = mustGetEnv("DE_SERVING_CONFIG_ID");

const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID || "groovy-root-483105-n9";
const GEMINI_LOCATION = process.env.GEMINI_LOCATION || "us-central1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "google/gemini-2.0-flash-001";

// OpenAI-compatible endpoint
const geminiUrl = `https://aiplatform.googleapis.com/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/endpoints/openapi/chat/completions`;

// -------------------- Simple memory (in-memory) --------------------
// NOTE: This resets when Render restarts/redeploys.
// If you later want persistent memory, we’ll store this in Redis / Firestore.
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_TURNS = 10; // last 10 messages total (user+assistant)
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
 * Accepts:
 * - JSON: { query, sessionId }
 * - multipart/form-data: fields query, sessionId, and file "image"
 */
app.post("/chat", upload.single("image"), async (req, res) => {
  try {
    // For multipart: multer fills req.body + req.file
    // For JSON: express.json fills req.body
    const sessionId = safeString(req.body.sessionId) || "default";
    const userQuery = safeString(req.body.query);
    const hasImage = !!req.file;

    console.log("=================================");
    console.log("CHAT REQUEST", {
      sessionId,
      hasImage,
      queryLen: userQuery.length,
      mime: hasImage ? req.file.mimetype : null,
      size: hasImage ? req.file.size : null,
    });
    console.log("=================================");

    // 1) Greeting override (no retrieval) — ONLY when no image
    if (!hasImage && isGreeting(userQuery)) {
      const greeting =
        "Hi 👋 I’m the Clarety Assistant.\n" +
        "Ask a Clarety question, or say “draft an email…” and I’ll help.";
      addToSession(sessionId, "user", userQuery);
      addToSession(sessionId, "assistant", greeting);
      return res.json({ answer: greeting, links: [] });
    }

    // If user uploaded an image but typed nothing, don’t punish them
    if (hasImage && !userQuery) {
      // Make it explicit to the model we want image understanding
      // (and don’t return “Ask me something.”)
    } else if (!hasImage && !userQuery) {
      return res.json({
        answer: "Type a question — or upload a screenshot and ask what you want me to look at.",
        links: [],
      });
    }

    const token = await getAccessToken();

    // 2) Decide whether to retrieve (RAG)
    // - For factual/how-to: retrieve
    // - For writing requests: retrieve if available to learn tone/terminology, but do NOT refuse if empty
    const writing = isWritingRequest(userQuery);
    const factual = looksLikeFactualHowTo(userQuery) && !writing;

    let snippets = [];
    let links = [];
    let retrievalCount = 0;

    // Only run retrieval when:
    // - factual question, OR
    // - writing request (tone/terminology), OR
    // - userQuery exists and no image (general Clarety question)
    const shouldRetrieve = !hasImage && (factual || writing || !!userQuery);

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

      // Dedupe links (title+url)
      const seen = new Set();
      links = links.filter((x) => {
        const k = `${x.title}::${x.url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      // IMPORTANT:
      // For writing requests, we do NOT hard-fail if retrieval is empty.
      // For factual questions, we’ll still help, but we’ll clearly say we didn’t find it.
    }

    // 3) Build system instruction (this is the “brain”)
    // This is where we stop the “pressing for info” behavior.
    const system = [
      "You are the Clarety Core AI Assistant.",
      "You are helpful, warm, professional, and human.",
      "You are an expert fundraising assistant and copywriter.",
      "",
      "Behavior rules:",
      "- If user is greeting: respond warmly and briefly (no retrieval talk).",
      "- If user asks for writing (emails/appeals/templates/rewrites): DO NOT refuse and DO NOT keep asking lots of questions.",
      "  If details are missing, make sensible assumptions and use placeholders like [Organisation Name], [Donation Link], [First Name].",
      "  Provide a complete draft immediately.",
      "- If user asks factual Clarety/how-to: use provided snippets when available; if not available, provide best-effort guidance and at most ONE clarifying question.",
      "- Never say you can't help just because sources are incomplete.",
      "- Do not mention internal systems or that you searched anything.",
      "",
      "If an image is provided:",
      "- Describe what the image contains and answer the user's question about it.",
      "- If the image is unclear, say what’s unclear and what you’d need to see."
    ].join("\n");

    // 4) Build conversation messages (with memory)
    // Keep last turns to maintain context (like remembering "year-end appeal about giraffes habitat loss")
    const history = getSessionMessages(sessionId);

    // Add current user turn to memory BEFORE generating
    // If image-only, store a marker (not raw base64)
    addToSession(sessionId, "user", hasImage ? `[Image uploaded] ${userQuery || ""}`.trim() : userQuery);

    const contextBlock =
      snippets.length > 0
        ? "Helpful reference snippets:\n" + snippets.slice(0, 8).join("\n")
        : "";

    // If drafting + user says "just write it now" / refuses questions, we push that intent
    const nudge =
      writing
        ? "The user wants you to write the draft now without further questions. Make reasonable assumptions and proceed."
        : "";

    // OpenAI-compatible message format:
    // - text-only: { role, content: "..." }
    // - vision: { role, content: [ {type:"text", text:"..."}, {type:"image_url", image_url:{url:"data:..."} } ] }
    const messages = [];

    messages.push({ role: "system", content: system });

    // Include memory/history (excluding system)
    for (const m of history) {
      if (m.role === "system") continue;
      // Keep it compact
      messages.push({ role: m.role, content: m.content });
    }

    if (hasImage) {
      const dataUrl = base64DataUrlFromFile(req.file);
      const userText =
        (userQuery ? `User question: ${userQuery}\n` : "User uploaded an image.\n") +
        (nudge ? `\n${nudge}\n` : "") +
        (contextBlock ? `\n${contextBlock}\n` : "");

      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl } },
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

    // 5) Call Gemini (OpenAI-compatible)
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

    // Store assistant response in session memory
    addToSession(sessionId, "assistant", answer);

    // IMPORTANT: you wanted links hidden — so always return empty links for now.
    // (You can bring them back later behind a toggle.)
    return res.json({
      answer,
      links: [],
      meta: {
        hasImage,
        retrievalCount,
        writing,
        factual,
      },
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
