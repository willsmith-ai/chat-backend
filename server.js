/**
 * Clarety Core AI backend (Render-friendly)
 *
 * What this version fixes:
 * ✅ “Draft an email…” always produces a draft (no interrogations)
 * ✅ Remembers the user is drafting (so “habitat loss” updates the draft)
 * ✅ Greetings/smalltalk don’t trigger RAG or topic dumps
 * ✅ Clarety “how do I…” still uses Discovery Engine grounding
 * ✅ If RAG finds nothing, it falls back to a helpful generative answer (no “No documents found”)
 * ✅ Links are hidden by default (frontend can opt-in later)
 *
 * Optional (recommended) frontend addition:
 * - send a stable sessionId in req.body.sessionId so memory is per user/device.
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
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "1mb" }));

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
/**
 * NOTE:
 * - This is per Render instance (ephemeral). Good enough for now.
 * - If Render restarts, memory resets.
 * - For more durable memory, you’d store per-session history in Redis/DB.
 */
const sessions = new Map();

function nowMs() {
  return Date.now();
}

function getSessionKey(req) {
  // Best: frontend sends sessionId (stable per browser/device)
  const sid = (req.body && req.body.sessionId) || req.headers["x-session-id"];
  if (sid) return String(sid);

  // Fallback: IP + user-agent (not perfect, but works for dev/testing)
  const ua = req.headers["user-agent"] || "ua";
  return `${req.ip}:${ua}`;
}

function getSession(req) {
  const key = getSessionKey(req);
  const existing = sessions.get(key);
  const expiry = nowMs() - MEMORY_TTL_MINUTES * 60 * 1000;

  if (existing && existing.updatedAt > expiry) {
    return { key, session: existing };
  }

  const fresh = {
    updatedAt: nowMs(),
    mode: "auto", // "auto" | "writing" | "rag"
    history: [], // {role:"user"|"assistant", content:string}
    lastDraft: null, // string
    lastDraftType: null, // "email"|"appeal"|"template"|etc
  };

  sessions.set(key, fresh);
  return { key, session: fresh };
}

function touchSession(key, session) {
  session.updatedAt = nowMs();
  sessions.set(key, session);
}

function addToHistory(session, role, content) {
  if (!content) return;
  session.history.push({ role, content: String(content) });

  // keep last N turns (each turn is user+assistant, so limit by messages)
  const maxMsgs = MEMORY_MAX_TURNS * 2;
  if (session.history.length > maxMsgs) {
    session.history = session.history.slice(session.history.length - maxMsgs);
  }
}

// Periodic cleanup
setInterval(() => {
  const expiry = nowMs() - MEMORY_TTL_MINUTES * 60 * 1000;
  for (const [k, v] of sessions.entries()) {
    if (!v || v.updatedAt < expiry) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

// -------------------- Intent detection --------------------
function normalize(text) {
  return (text || "").toString().trim();
}

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

  // direct asks
  if (/\b(write|draft|compose|create|generate)\b.*\b(email|appeal|template|newsletter|sms|copy)\b/.test(t))
    return true;

  // rewrite asks
  if (/\b(rewrite|reword|polish|improve|shorten|expand|tidy up)\b/.test(t)) return true;

  // “can you write it for me”
  if (/\bwrite (it|this) (for me|now)\b/.test(t)) return true;

  return false;
}

function forceWriteNow(text) {
  const t = normalize(text).toLowerCase();
  return /\b(write it now|just write it|no further details|example only|without details|do it now|stop asking|dont ask|don't ask)\b/.test(
    t
  );
}

// When user is already drafting, treat short follow-ups as draft modifiers
function isWritingContinuation(text, session) {
  if (!session || session.mode !== "writing") return false;
  const t = normalize(text);
  if (!t) return false;

  // If it looks like a Clarety how-to question, it’s not drafting continuation
  if (isClaretyHowTo(t)) return false;

  // Short phrases like “habitat loss”, “make it shorter”, “more urgent”, etc.
  if (t.length <= 120) return true;

  // Also allow “yes / no / ok” while drafting
  if (/^(yes|yeah|yep|no|nope|ok|okay|sure|do it|go ahead)$/i.test(t)) return true;

  return false;
}

function inferDraftType(text) {
  const t = normalize(text).toLowerCase();
  if (t.includes("appeal")) return "appeal";
  if (t.includes("newsletter")) return "newsletter";
  if (t.includes("sms")) return "sms";
  if (t.includes("subject line")) return "email";
  if (t.includes("email")) return "email";
  if (t.includes("template")) return "template";
  return "email";
}

// -------------------- Gemini call --------------------
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
 * Main chat endpoint used by your widget frontend
 *
 * Request body:
 *   { query: string, sessionId?: string, includeLinks?: boolean }
 *
 * Response:
 *   { answer: string, links: [], mode_used: "gen"|"rag", confidence?: "high"|"low" }
 */
app.post("/chat", async (req, res) => {
  const userQuery = normalize(req.body.query);
  const includeLinks = Boolean(req.body.includeLinks); // default false (hide links)
  const { key, session } = getSession(req);

  if (!userQuery) {
    return res.json({ answer: "Ask me something.", links: [], mode_used: "gen", confidence: "low" });
  }

  try {
    const token = await getAccessToken();

    // ----- Determine intent (with memory) -----
    const greeting = isGreeting(userQuery);

    // Writing intent can be:
    // - explicit writing request now
    // - forced “write it now”
    // - continuation of an existing drafting session
    const writingNow =
      isWritingRequest(userQuery) ||
      forceWriteNow(userQuery) ||
      isWritingContinuation(userQuery, session);

    // If the user asks a Clarety how-to, treat as factual even if short
    const claretyHowTo = isClaretyHowTo(userQuery);

    // Update session mode
    if (greeting) session.mode = "auto";
    else if (writingNow && !claretyHowTo) session.mode = "writing";
    else if (claretyHowTo) session.mode = "rag";
    else {
      // default
      session.mode = session.mode === "writing" ? "writing" : "auto";
    }

    // ----- Base system prompt -----
    const baseSystem = [
      "You are the Clarety Core AI Assistant.",
      "You are helpful, warm, professional, and human.",
      "You are an expert fundraising assistant and copywriter.",
      "You help answer questions about Clarety, draft emails/templates/appeals, and think through supporter communications.",
      "Do not mention internal systems, searches, sources, or document retrieval.",
      "Never say you can't help if drafting or guidance is possible.",
      "If details are missing, make reasonable assumptions and use placeholders like [Organisation Name].",
    ].join(" ");

    // ----- Build message history for Gemini -----
    // We give Gemini the last few turns so it remembers context.
    // (We keep it short to avoid large payloads.)
    const historyForModel = session.history.slice(-10);

    // Always add the current user message at the end
    const messages = [...historyForModel, { role: "user", content: userQuery }];

    // ----- Route: Greetings / smalltalk -----
    if (greeting) {
      const system =
        baseSystem +
        " The user is greeting you or making small talk. Respond warmly and briefly. Do not ask lots of questions. Do not include links.";

      const answer = await callGemini({
        token,
        system,
        messages: [{ role: "user", content: userQuery }],
        temperature: 0.7,
      });

      addToHistory(session, "user", userQuery);
      addToHistory(session, "assistant", answer || "Hi! How can I help today?");
      touchSession(key, session);

      return res.json({ answer: answer || "Hi! How can I help today?", links: [], mode_used: "gen", confidence: "high" });
    }

    // ----- Route: Writing / drafting (with memory, no interrogations) -----
    if (session.mode === "writing" && !claretyHowTo) {
      // Infer draft type once and keep it
      if (!session.lastDraftType) session.lastDraftType = inferDraftType(userQuery);

      const writingSystem =
        baseSystem +
        " The user wants you to draft or rewrite content." +
        " IMPORTANT: You MUST produce a complete draft immediately." +
        " DO NOT ask follow-up or clarifying questions unless the user explicitly asks you to." +
        " If the user provides extra details (e.g., 'habitat loss' or 'make it shorter'), incorporate them into the draft." +
        " Provide a subject line if it's an email or appeal." +
        " Output the draft directly, cleanly formatted.";

      // If we have a previous draft, include it as context so “habitat loss” edits it instead of resetting.
      const draftContext = session.lastDraft
        ? `\n\nPREVIOUS DRAFT (revise this):\n${session.lastDraft}\n\nUSER UPDATE (apply this):\n${userQuery}\n`
        : `\n\nUSER REQUEST:\n${userQuery}\n`;

      const answer = await callGemini({
        token,
        system: writingSystem,
        messages: [{ role: "user", content: draftContext }],
        temperature: 0.75,
      });

      // Save memory
      addToHistory(session, "user", userQuery);
      addToHistory(session, "assistant", answer);
      // Keep last draft for revisions (truncate to avoid runaway size)
      session.lastDraft = (answer || "").slice(0, 9000);
      touchSession(key, session);

      return res.json({ answer: answer || "Sure — what would you like the draft to say?", links: [], mode_used: "gen", confidence: "high" });
    }

    // ----- Route: Clarety factual/process (RAG first, fall back to gen) -----
    // If user explicitly asks how-to, or session is in rag mode, do RAG.
    const shouldRag = claretyHowTo || session.mode === "rag";

    if (shouldRag) {
      const { snippets, links } = await searchDiscoveryEngine({ token, query: userQuery });
      const hasContext = snippets.length > 0;

      const ragSystem =
        baseSystem +
        " The user asked a Clarety factual/process question." +
        " Use the provided reference context if it is relevant." +
        " If the context is incomplete, still provide a best-effort helpful answer." +
        " If you need one missing detail, ask at most ONE clarifying question." +
        " Do not refuse.";

      const genSystem =
        baseSystem +
        " The user asked a Clarety question but you do not have strong reference context." +
        " Still answer as helpfully as possible, and ask at most ONE clarifying question if needed." +
        " Do not refuse.";

      const contextBlock = hasContext
        ? "REFERENCE CONTEXT (may be partial):\n" + snippets.slice(0, 8).join("\n")
        : "";

      const userPayload = hasContext
        ? `User question:\n${userQuery}\n\n${contextBlock}`
        : userQuery;

      const answer = await callGemini({
        token,
        system: hasContext ? ragSystem : genSystem,
        messages: [{ role: "user", content: userPayload }],
        temperature: hasContext ? 0.2 : 0.5,
      });

      addToHistory(session, "user", userQuery);
      addToHistory(session, "assistant", answer);
      // If they switch to Clarety Qs, clear drafting state
      session.lastDraft = null;
      session.lastDraftType = null;
      touchSession(key, session);

      return res.json({
        answer: answer || "I can help with that — what part are you trying to do in Clarety?",
        links: includeLinks && hasContext ? links : [],
        mode_used: hasContext ? "rag" : "gen",
        confidence: hasContext ? "high" : "low",
      });
    }

    // ----- Route: General discussion (no RAG by default, but helpful) -----
    const generalSystem =
      baseSystem +
      " The user is describing a situation or asking a general question." +
      " Respond helpfully and practically." +
      " Ask at most ONE clarifying question only if absolutely needed to proceed." +
      " Do not refuse.";

    const answer = await callGemini({
      token,
      system: generalSystem,
      messages,
      temperature: 0.6,
    });

    addToHistory(session, "user", userQuery);
    addToHistory(session, "assistant", answer);
    touchSession(key, session);

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
