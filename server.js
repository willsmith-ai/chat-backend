/**
 * Clarety Core AI - Render backend
 *
 * 1) Discovery Engine REST Search (working)
 * 2) Vertex AI Gemini via OpenAI-compatible endpoint (fixes your 404 model issue)
 *
 * Required env vars:
 * - GOOGLE_JSON_KEY
 *
 * Discovery Engine:
 * - DE_PROJECT_NUMBER
 * - DE_LOCATION
 * - DE_COLLECTION_ID
 * - DE_ENGINE_ID
 * - DE_SERVING_CONFIG_ID
 *
 * Vertex / Gemini:
 * - VERTEX_PROJECT_ID         = groovy-root-483105-n9
 * - VERTEX_LOCATION           = us-central1
 * - GEMINI_MODEL              = gemini-1.5-flash (we’ll pass this as "model" in the request body)
 *
 * Optional:
 * - ALLOWED_ORIGIN
 */

const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ----------------------- Helpers -----------------------

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getServiceAccountCredentials() {
  const raw = mustGetEnv("GOOGLE_JSON_KEY");
  const creds = JSON.parse(raw);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");

  if (!creds.client_email) throw new Error("GOOGLE_JSON_KEY JSON is missing client_email.");
  if (!creds.private_key) throw new Error("GOOGLE_JSON_KEY JSON is missing private_key.");
  return creds;
}

async function getAccessToken() {
  const credentials = getServiceAccountCredentials();
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse && tokenResponse.token ? tokenResponse.token : tokenResponse;

  if (!token) throw new Error("Failed to mint access token from service account credentials.");
  return token;
}

function fixGsLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.substring(5);
  return link;
}

function stripHtml(s) {
  if (!s) return "";
  return String(s).replace(/<[^>]*>/g, "");
}

// ----------------------- Discovery Engine Search (REST) -----------------------

async function discoverySearch({ token, query, pageSize = 10 }) {
  const DE_PROJECT_NUMBER = mustGetEnv("DE_PROJECT_NUMBER");
  const DE_LOCATION = mustGetEnv("DE_LOCATION");
  const DE_COLLECTION_ID = mustGetEnv("DE_COLLECTION_ID");
  const DE_ENGINE_ID = mustGetEnv("DE_ENGINE_ID");
  const DE_SERVING_CONFIG_ID = mustGetEnv("DE_SERVING_CONFIG_ID");

  const url =
    `https://discoveryengine.googleapis.com/v1alpha/` +
    `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}` +
    `/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
    `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;

  const body = {
    query,
    pageSize,
    queryExpansionSpec: { condition: "AUTO" },
    spellCorrectionSpec: { mode: "AUTO" },
    languageCode: "en-US",
    userInfo: { timeZone: "Asia/Saigon" },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error?.message || json?.message || JSON.stringify(json);
    throw new Error(`Discovery Engine search failed (${resp.status}): ${msg}`);
  }

  const results = Array.isArray(json.results) ? json.results : [];
  const items = results.map((r) => {
    const d = r.document || {};
    const ds = d.derivedStructData || {};
    const title = ds.title || d.id || r.id || "Untitled";
    const link = fixGsLink(ds.link);

    const extractiveAnswers = Array.isArray(ds.extractive_answers)
      ? ds.extractive_answers.map((a) => stripHtml(a.content || "")).filter(Boolean)
      : [];

    return { title, link, extractiveAnswers };
  });

  return { urlUsed: url, items, raw: json };
}

// ----------------------- Vertex Gemini (OpenAI-compatible endpoint) -----------------------

async function geminiChat({ token, userQuery, groundingItems }) {
  const VERTEX_PROJECT_ID = mustGetEnv("VERTEX_PROJECT_ID");
  const VERTEX_LOCATION = mustGetEnv("VERTEX_LOCATION");
  const GEMINI_MODEL = mustGetEnv("GEMINI_MODEL"); // e.g. gemini-1.5-flash

  // OpenAI-compatible endpoint on Vertex
  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}` +
    `/endpoints/openapi/chat/completions`;

  const top = groundingItems.slice(0, 6);
  const contextLines = top.map((it, i) => {
    const citation = it.link ? `Source: ${it.link}` : "Source: (no link)";
    const bestSnippet = it.extractiveAnswers?.[0] || "";
    return `[${i + 1}] ${it.title}\n${citation}\nSnippet: ${bestSnippet}`;
  });

  const system =
    "You are Clarety Core AI. Answer using the provided sources first. " +
    "If the question is Vietnamese, respond in Vietnamese. If English, respond in English. " +
    "If sources are insufficient, say so and ask a clarifying question. " +
    "Keep it concise and practical. Mention sources as [1], [2], etc.";

  const user =
    `User question:\n${userQuery}\n\n` +
    `Sources:\n${contextLines.join("\n\n")}`;

  const body = {
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_tokens: 600,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error?.message || json?.message || JSON.stringify(json);
    throw new Error(`Gemini chat failed (${resp.status}): ${msg}`);
  }

  const answer = json?.choices?.[0]?.message?.content?.trim() || "";
  return { urlUsed: url, answer, raw: json };
}

// ----------------------- Routes -----------------------

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
  try {
    const query = (req.body?.query ? String(req.body.query) : "").trim();
    console.log("=================================");
    console.log("CHAT REQUEST", { query });
    console.log("=================================");

    if (!query) return res.json({ answer: "Please type a question.", links: [] });

    const token = await getAccessToken();

    // 1) Search
    const search = await discoverySearch({ token, query, pageSize: 10 });
    console.log("Using servingConfig:", search.urlUsed);
    console.log("Results:", search.items.length);

    const links = search.items
      .filter((x) => x.link)
      .slice(0, 6)
      .map((x) => ({ title: x.title, url: x.link }));

    if (search.items.length === 0) {
      return res.json({
        answer: "No documents found. Try a more specific keyword (e.g., the exact feature name).",
        links: [],
      });
    }

    // 2) Gemini grounded answer
    const gen = await geminiChat({ token, userQuery: query, groundingItems: search.items });

    return res.json({
      answer: gen.answer || "I found documents, but couldn’t generate an answer.",
      links,
    });
  } catch (err) {
    console.error("CHAT ERROR:", err?.message || err);
    return res.status(500).json({
      answer: "Backend error. Check Render logs.",
      error: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
