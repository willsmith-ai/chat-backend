/**
 * Clarety Core AI - Render backend
 *
 * What it does:
 * 1) Calls Discovery Engine REST Search (same as Cloud Shell curl) using a service-account minted access token
 * 2) Calls Vertex AI Gemini REST generateContent using the same token
 * 3) Returns { answer, links, debug }
 *
 * Required env vars:
 * - GOOGLE_JSON_KEY           = service account JSON (as ONE LINE string)
 *
 * Discovery Engine (from your Integration → API screen):
 * - DE_PROJECT_NUMBER         = 28062079972
 * - DE_LOCATION               = global
 * - DE_COLLECTION_ID          = default_collection
 * - DE_ENGINE_ID              = claretycoreai_1767340856472
 * - DE_SERVING_CONFIG_ID      = default_search
 *
 * Vertex / Gemini:
 * - VERTEX_PROJECT_ID         = groovy-root-483105-n9
 * - VERTEX_LOCATION           = us-central1
 * - GEMINI_MODEL              = gemini-1.5-flash   (or gemini-1.5-pro)
 *
 * Optional:
 * - ALLOWED_ORIGIN            = https://willsmith-ai.github.io  (or "*" for testing)
 */

const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// ----------------------- Helpers -----------------------

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getServiceAccountCredentials() {
  const raw = mustGetEnv("GOOGLE_JSON_KEY");

  // The value in Render is usually pasted as a single line JSON string.
  // If private_key contains "\\n", convert to real newlines.
  const creds = JSON.parse(raw);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }

  // Hard validation: this is exactly the error you saw.
  if (!creds.client_email) {
    throw new Error("GOOGLE_JSON_KEY JSON is missing client_email (wrong JSON pasted).");
  }
  if (!creds.private_key) {
    throw new Error("GOOGLE_JSON_KEY JSON is missing private_key (wrong JSON pasted).");
  }
  return creds;
}

async function getAccessToken() {
  const credentials = getServiceAccountCredentials();

  const auth = new GoogleAuth({
    credentials,
    // Cloud Platform scope covers both Discovery Engine + Vertex AI
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

  // This matches the Integration → API page
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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Discovery Engine returned non-JSON. Status ${resp.status}. Body: ${text}`);
  }

  if (!resp.ok) {
    const msg = json.error?.message || json.message || JSON.stringify(json);
    throw new Error(`Discovery Engine search failed (${resp.status}): ${msg}`);
  }

  const results = Array.isArray(json.results) ? json.results : [];
  const totalSize = typeof json.totalSize === "number" ? json.totalSize : results.length;

  // Extract what we need
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

  return {
    urlUsed: url,
    totalSize,
    items,
    raw: json,
  };
}

// ----------------------- Vertex AI Gemini (REST) -----------------------

async function geminiGenerate({ token, userQuery, groundingItems }) {
  const VERTEX_PROJECT_ID = mustGetEnv("VERTEX_PROJECT_ID");
  const VERTEX_LOCATION = mustGetEnv("VERTEX_LOCATION");
  const GEMINI_MODEL = mustGetEnv("GEMINI_MODEL");

  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}` +
    `/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  // Build a grounded context block from search results
  const top = groundingItems.slice(0, 6);
  const contextLines = top.map((it, i) => {
    const citation = it.link ? `Source: ${it.link}` : "Source: (no link)";
    const bestSnippet = it.extractiveAnswers && it.extractiveAnswers.length > 0 ? it.extractiveAnswers[0] : "";
    return `[${i + 1}] ${it.title}\n${citation}\nSnippet: ${bestSnippet}`;
  });

  const systemInstruction =
    `You are Clarety Core AI. Answer using the provided sources first. ` +
    `If the question is Vietnamese, respond in Vietnamese. If English, respond in English. ` +
    `If sources are insufficient, say so and ask a clarifying question. ` +
    `Keep it concise and practical.`;

  const prompt =
    `User question:\n${userQuery}\n\n` +
    `Sources (search results):\n${contextLines.join("\n\n")}\n\n` +
    `Task:\n- Provide a helpful answer.\n- If you used a source, mention it as [1], [2], etc.\n`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 600,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON. Status ${resp.status}. Body: ${text}`);
  }

  if (!resp.ok) {
    const msg = json.error?.message || json.message || JSON.stringify(json);
    throw new Error(`Gemini generateContent failed (${resp.status}): ${msg}`);
  }

  const candidate = json.candidates && json.candidates[0];
  const parts = candidate?.content?.parts || [];
  const answer = parts.map((p) => p.text || "").join("").trim();

  return { urlUsed: url, answer, raw: json };
}

// ----------------------- Routes -----------------------

app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
  try {
    const query = (req.body && req.body.query ? String(req.body.query) : "").trim();
    console.log("=================================");
    console.log("CHAT REQUEST", { query });
    console.log("=================================");

    if (!query) {
      return res.json({ answer: "Please type a question.", links: [] });
    }

    // 1) Auth
    const token = await getAccessToken();

    // 2) Search
    const search = await discoverySearch({ token, query, pageSize: 10 });
    console.log("Using servingConfig:", search.urlUsed);
    console.log("Results:", search.items.length);

    const links = search.items
      .filter((x) => x.link)
      .slice(0, 6)
      .map((x) => ({ title: x.title, url: x.link }));

    // 3) If nothing found, return fast (still can do Gemini, but it would hallucinate)
    if (search.items.length === 0) {
      return res.json({
        answer: "No documents found. Try a more specific keyword (e.g., the exact feature name).",
        links: [],
        debug: { totalSize: search.totalSize },
      });
    }

    // 4) Gemini answer grounded on the search results
    const gen = await geminiGenerate({ token, userQuery: query, groundingItems: search.items });

    return res.json({
      answer: gen.answer || "I found documents, but I couldn’t generate an answer.",
      links,
      debug: {
        totalSize: search.totalSize,
      },
    });
  } catch (err) {
    console.error("CHAT ERROR:", err && err.message ? err.message : err);
    return res.status(500).json({
      answer: "Backend error. Check Render logs.",
      error: err && err.message ? err.message : String(err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
