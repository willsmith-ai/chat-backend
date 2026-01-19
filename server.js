/**
 * Clarety Core AI backend (Render-friendly)
 *
 * - Discovery Engine search via REST (matches the Cloud Shell curl that works)
 * - Gemini answer via Vertex AI OpenAI-compatible endpoint (no publisher model path)
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
 *   GEMINI_LOCATION           = us-central1 (or global; docs show both patterns)
 *   GEMINI_MODEL              = google/gemini-2.0-flash-001
 *   ALLOWED_ORIGIN            = *  (or your github pages domain)
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

  // Support either raw JSON or a JSON string with escaped newlines
  const obj = JSON.parse(raw);

  // IMPORTANT: this must be a *service account key* JSON that contains client_email
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
const DE_PROJECT_NUMBER = mustGetEnv("DE_PROJECT_NUMBER"); // 28062079972
const DE_LOCATION = mustGetEnv("DE_LOCATION"); // global
const DE_COLLECTION_ID = mustGetEnv("DE_COLLECTION_ID"); // default_collection
const DE_ENGINE_ID = mustGetEnv("DE_ENGINE_ID"); // claretycoreai_1767340856472
const DE_SERVING_CONFIG_ID = mustGetEnv("DE_SERVING_CONFIG_ID"); // default_search

const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID || "groovy-root-483105-n9";
const GEMINI_LOCATION = process.env.GEMINI_LOCATION || "us-central1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "google/gemini-2.0-flash-001";

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("Backend is running!"));

/**
 * Quick sanity check that Render is running the latest code
 */
app.get("/version", (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || null,
    deServingConfig: `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/${DE_SERVING_CONFIG_ID}`,
    geminiModel: GEMINI_MODEL,
  });
});

/**
 * Debug endpoint: search only (no Gemini), so we can isolate retrieval.
 * Example:
 *   /debug-search?q=Contact
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
    // 1) Retrieve (Discovery Engine REST) - matches your Cloud Shell curl
    const token = await getAccessToken();

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

    if (results.length === 0) {
      return res.json({
        answer: "No documents found. Try a more specific keyword or the exact doc title.",
        links: [],
      });
    }

    // 2) Generate answer (Vertex AI OpenAI-compatible endpoint)
    // IMPORTANT: model must be like "google/gemini-2.0-flash-001" (NOT publishers/google/models/...)
    // See Google docs for OpenAI compatibility models. :contentReference[oaicite:1]{index=1}
    const geminiUrl = `https://aiplatform.googleapis.com/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/endpoints/openapi/chat/completions`;

    const system = [
      "You are Clarety Core AI.",
      "Answer using ONLY the provided sources. If unsure, say you don't know.",
      "Keep it clear and practical. If the user asks for steps, give steps.",
      "If the user asks for translation, translate and keep meaning faithful.",
    ].join(" ");

    const contextBlock =
      "SOURCES (extractive snippets):\n" + snippets.slice(0, 8).join("\n");

    const genBody = {
      model: GEMINI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Question: ${userQuery}\n\n${contextBlock}` },
      ],
      temperature: 0.2,
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
        `Gemini generateContent failed (${genResp.status})`;
      throw new Error(msg);
    }

    const answer =
      genJson?.choices?.[0]?.message?.content ||
      "I found documents, but couldn't generate a summary. Check the links.";

    return res.json({ answer, links });
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
