/**
 * Clarety Core AI backend (Render-friendly)
 *
 * - Discovery Engine search via REST
 * - Gemini answer via Vertex AI OpenAI-compatible endpoint
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
 *   GEMINI_PROJECT_ID         = groovy-root-483105-n9   (string project id)
 *   GEMINI_LOCATION           = us-central1 (or global)
 *   GEMINI_MODEL              = google/gemini-2.0-flash-001
 *   ALLOWED_ORIGIN            = * (or your github pages domain)
 */

const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

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

/**
 * Simple intent detection (good enough to start; improves behavior immediately)
 */
function isGreeting(text) {
  const t = (text || "").trim().toLowerCase();
  // very short or common greeting / smalltalk
  if (t.length <= 20) {
    if (
      /^(hi|hello|hey|yo|hiya|howdy|sup|good morning|good afternoon|good evening|thanks|thank you|thx)\b/.test(
        t
      )
    )
      return true;
  }
  // small talk questions
  if (/^(how are you|how's it going|hows it going|what's up|whats up)\b/.test(t)) return true;
  return false;
}

function isWritingRequest(text) {
  const t = (text || "").toLowerCase();

  // Email / copywriting verbs
  if (
    /\b(draft|write|rewrite|reword|compose|create|generate|improve|polish|tidy|shorten|expand)\b/.test(t) &&
    /\b(email|appeal|template|message|copy|subject line|fundraising|donor|supporter|newsletter|sms)\b/.test(t)
  ) {
    return true;
  }

  // Direct “write an email” etc.
  if (/\b(write|draft|compose|create)\b.*\b(email|appeal|template|newsletter|sms)\b/.test(t)) return true;

  // “Can you write it for me”
  if (/\bwrite (it|this) (for me|now)\b/.test(t)) return true;

  return false;
}

/**
 * Calls Gemini (Vertex AI OpenAI-compatible)
 */
async function callGemini({ token, system, user, temperature = 0.3 }) {
  const geminiUrl = `https://aiplatform.googleapis.com/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/endpoints/openapi/chat/completions`;

  const genBody = {
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
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
    const msg =
      genJson?.error?.message ||
      `Gemini chat/completions failed (${genResp.status})`;
    throw new Error(msg);
  }

  const content = genJson?.choices?.[0]?.message?.content;
  return content || "";
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

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("Backend is running!"));

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || null,
    deServingConfig: `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/${DE_SERVING_CONFIG_ID}`,
    geminiModel: GEMINI_MODEL,
  });
});

/**
 * Debug endpoint: search only (no Gemini)
 */
app.get("/debug-search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
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
      raw: json,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Main chat endpoint used by your widget frontend
 */
app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT REQUEST", req.body);
  console.log("=================================");

  const userQuery = (req.body.query || "").toString().trim();
  if (!userQuery) return res.json({ answer: "Ask me something.", links: [] });

  try {
    const token = await getAccessToken();

    // -------------------- Intent routing --------------------
    const greeting = isGreeting(userQuery);
    const writing = isWritingRequest(userQuery);

    // Shared base system prompt (matches your desired behavior)
    const baseSystem = [
      "You are the Clarety Core AI Assistant.",
      "You are helpful, warm, professional, and human.",
      "You are an expert fundraising assistant and copywriter.",
      "You help answer questions about Clarety, draft emails/templates, and think through supporter communications.",
      "Do not mention internal systems, searches, or sources.",
      "Never refuse if drafting or guidance is possible; use placeholders if details are missing.",
      "If the user is unclear, ask at most ONE clarifying question.",
    ].join(" ");

    // 1) GREETINGS / SMALLTALK: Gemini only, no search
    if (greeting) {
      const system = baseSystem + " The user is greeting you. Respond warmly and briefly. Do not include links or document lists.";
      const answer = await callGemini({
        token,
        system,
        user: userQuery,
        temperature: 0.6,
      });

      return res.json({
        answer: answer || "Hi! I’m the Clarety Core AI Assistant — how can I help today?",
        links: [],
        mode_used: "gen",
      });
    }

    // 2) WRITING / DRAFTING: Gemini only (IMPORTANT), no search
    if (writing) {
      const system =
        baseSystem +
        " The user wants you to draft or rewrite content (e.g., an email/appeal/template). You MUST produce a draft even if you have no specific Clarety reference text. Use best-practice fundraising/copywriting. Match a professional Clarety tone. Use placeholders where needed. Provide a subject line if it's an email.";

      const answer = await callGemini({
        token,
        system,
        user: userQuery,
        temperature: 0.7,
      });

      return res.json({
        answer: answer || "Sure — tell me who it’s to and what you want to achieve, and I’ll draft it.",
        links: [],
        mode_used: "gen",
      });
    }

    // 3) FACTUAL / PROCESS (default): try RAG first, but NEVER hard-fail
    const searchUrl =
      `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
      `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
      `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;

    console.log("Using servingConfig:", searchUrl);

    const searchBody = {
      query: userQuery,
      pageSize: 10,
      queryExpansionSpec: { condition: "AUTO" },
      spellCorrectionSpec: { mode: "AUTO" },
      languageCode: "en-US",
      userInfo: { timeZone: "Asia/Saigon" },
    };

    const searchResp = await fetch(searchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody),
    });

    const searchJson = await searchResp.json();
    const results = searchJson.results || [];
    console.log("Results:", results.length);

    const links = [];
    const snippets = [];

    for (const r of results) {
      const d = r?.document?.derivedStructData || {};
      if (d.title && d.link) {
        links.push({ title: d.title, url: fixGsLink(d.link) });
      }
      const ea = d?.extractive_answers?.[0]?.content;
      if (ea) snippets.push(`- ${d.title || "Source"}: ${ea}`);
    }

    // If we have decent snippets, do grounded answer.
    // If not, fall back to generative answer (still helpful).
    const hasContext = snippets.length > 0;

    const ragSystem =
      baseSystem +
      " The user asked a Clarety factual/process question. Use the provided context if it is relevant. If the context does not answer fully, still help with best-practice guidance and ask ONE clarifying question if needed. Do not refuse.";

    const genSystem =
      baseSystem +
      " The user asked a question. You do not have strong Clarety context available. Still respond helpfully with a best-effort answer and ask ONE clarifying question if needed. Do not refuse.";

    const contextBlock = hasContext
      ? "REFERENCE CONTEXT (may be partial):\n" + snippets.slice(0, 8).join("\n")
      : "";

    const userPayload = hasContext
      ? `User question:\n${userQuery}\n\n${contextBlock}`
      : userQuery;

    const answer = await callGemini({
      token,
      system: hasContext ? ragSystem : genSystem,
      user: userPayload,
      temperature: hasContext ? 0.2 : 0.5,
    });

    return res.json({
      answer: answer || "I can help with that — what part are you trying to achieve?",
      // Optional: you can choose to return links only when you have context
      links: hasContext ? links : [],
      mode_used: hasContext ? "rag" : "gen",
      confidence: hasContext ? "high" : "low",
    });
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
