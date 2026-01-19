/**
 * ClaretyCoreAI Backend (Render-safe)
 *
 * What it does:
 * 1) Calls Discovery Engine via REST (v1alpha) exactly like your working Cloud Shell curl
 * 2) Optionally calls Vertex AI Gemini to generate a friendly answer using retrieved snippets
 *
 * Required env vars:
 *  - GOOGLE_JSON_KEY            = service account JSON (as a single-line JSON string)
 *  - DE_PROJECT_NUMBER          = 28062079972
 *  - DE_LOCATION                = global
 *  - DE_COLLECTION_ID           = default_collection
 *  - DE_ENGINE_ID               = claretycoreai_1767340856472
 *  - DE_SERVING_CONFIG_ID       = default_search
 *
 * Optional env vars:
 *  - ENABLE_GEMINI              = true/false (default false)
 *  - VERTEX_PROJECT_ID          = groovy-root-483105-n9
 *  - VERTEX_LOCATION            = us-central1 (recommended)
 *  - GEMINI_MODEL               = gemini-1.5-flash (or gemini-1.5-pro)
 *  - ALLOWED_ORIGIN             = https://willsmith-ai.github.io (or "*" for testing)
 */

const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
const { VertexAI } = require("@google-cloud/vertexai");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// -------------------- Helpers --------------------

function getServiceAccountCredentials() {
  if (!process.env.GOOGLE_JSON_KEY) {
    throw new Error("Missing GOOGLE_JSON_KEY env var");
  }
  const creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.substring(5);
  return link;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

// -------------------- Discovery Engine REST search --------------------

async function discoverySearch({ query }) {
  const PROJECT_NUMBER = requireEnv("DE_PROJECT_NUMBER");
  const LOCATION = requireEnv("DE_LOCATION"); // "global"
  const COLLECTION_ID = requireEnv("DE_COLLECTION_ID"); // "default_collection"
  const ENGINE_ID = requireEnv("DE_ENGINE_ID");
  const SERVING_CONFIG_ID = requireEnv("DE_SERVING_CONFIG_ID"); // "default_search"

  const servingConfig = `projects/${PROJECT_NUMBER}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;

  // This is the exact endpoint pattern from your Cloud Shell call:
  const url = `https://discoveryengine.googleapis.com/v1alpha/${servingConfig}:search`;

  // Generate an access token from the service account JSON
  const credentials = getServiceAccountCredentials();
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse?.token;
  if (!accessToken) throw new Error("Failed to obtain Google access token");

  const body = {
    query,
    pageSize: 10,
    queryExpansionSpec: { condition: "AUTO" },
    spellCorrectionSpec: { mode: "AUTO" },
    languageCode: "en-US",
    userInfo: { timeZone: "Asia/Saigon" },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (!resp.ok) {
    const msg = json?.error?.message || JSON.stringify(json);
    const code = json?.error?.code || resp.status;
    throw new Error(`Discovery Engine search failed (${code}): ${msg}`);
  }

  return { servingConfigUsed: servingConfig, raw: json };
}

// -------------------- Gemini (Vertex AI) optional --------------------

async function geminiAnswer({ userQuery, searchResults }) {
  const enableGemini = String(process.env.ENABLE_GEMINI || "false").toLowerCase() === "true";
  if (!enableGemini) return null;

  const vertexProject = requireEnv("VERTEX_PROJECT_ID");
  const vertexLocation = process.env.VERTEX_LOCATION || "us-central1";
  const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";

  // Build a compact context from top results
  const sources = (searchResults || []).slice(0, 6).map((r, idx) => {
    const title = r.title || `Doc ${idx + 1}`;
    const link = r.url || "";
    const excerpt = r.excerpt || "";
    return `SOURCE ${idx + 1}\nTitle: ${title}\nLink: ${link}\nExcerpt: ${excerpt}\n`;
  });

  const vertexAI = new VertexAI({ project: vertexProject, location: vertexLocation });
  const model = vertexAI.getGenerativeModel({ model: modelName });

  const system = `You are Clarety Core AI.
Answer using only the SOURCES provided. If unsure, say you couldn't find it in the documents.
Be concise, helpful, and practical.`;

  const prompt = `${system}

USER QUESTION:
${userQuery}

SOURCES:
${sources.join("\n")}

Write the best possible answer now.`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 500,
    },
  });

  const text =
    result?.response?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    null;

  return text ? text.trim() : null;
}

// -------------------- Routes --------------------

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body?.query || "").trim();

    console.log("=================================");
    console.log("CHAT REQUEST", { query: userQuery });
    console.log("=================================");

    if (!userQuery) {
      return res.json({ answer: "Ask me something and I’ll search the Clarety Knowledge Database.", links: [] });
    }

    // 1) Retrieval (Discovery Engine) - the exact REST call that worked in Cloud Shell
    const { servingConfigUsed, raw } = await discoverySearch({ query: userQuery });
    console.log("Using servingConfig:", servingConfigUsed);
    console.log("Results:", Array.isArray(raw.results) ? raw.results.length : 0);

    const results = (raw.results || []).map((r) => {
      const d = r.document?.derivedStructData || {};
      const title = d.title || r.document?.id || "Untitled";
      const link = fixLink(d.link);
      const extractive = Array.isArray(d.extractive_answers) ? d.extractive_answers : [];
      const excerpt = stripHtml(extractive?.[0]?.content || "");
      return { title, url: link, excerpt };
    });

    // 2) Build response
    let answer = "";
    const links = results
      .filter((x) => x.url)
      .slice(0, 6)
      .map((x) => ({ title: x.title, url: x.url }));

    // If Gemini enabled, use it
    const gemini = await geminiAnswer({ userQuery, searchResults: results });
    if (gemini) {
      answer = gemini;
    } else {
      // Non-Gemini fallback: show best excerpt or titles
      const bestExcerpt = results.find((x) => x.excerpt)?.excerpt;
      if (bestExcerpt) {
        answer = bestExcerpt;
      } else if (results.length > 0) {
        answer = `I found these documents:\n• ${results.map((x) => x.title).slice(0, 8).join("\n• ")}`;
      } else {
        answer = "No documents found.";
      }
    }

    return res.json({
      answer,
      links,
      debug: {
        totalSize: raw.totalSize || null,
        servingConfigUsed,
      },
    });
  } catch (err) {
    console.error("CHAT ERROR:", err?.message || err);
    return res.status(500).json({
      answer: "Backend error",
      error: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
