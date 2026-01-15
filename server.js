/**
 * RAG backend:
 * - Retrieval: Discovery Engine Search (Vertex AI Search)
 * - Generation: Vertex AI Gemini (no Gen App Builder LLM add-on needed)
 *
 * Env vars required:
 *   GOOGLE_JSON_KEY       = your service account JSON (as a single line string)
 *   DE_PROJECT_NUMBER     = 28062079972
 *   DE_LOCATION           = global
 *   DE_COLLECTION_ID      = default_collection
 *   DE_DATA_STORE_ID      = claretycoreai_1767340742213_gcs_store
 *
 *   VERTEX_PROJECT_ID     = groovy-root-483105-n9   (project ID, not number)
 *   VERTEX_LOCATION       = us-central1            (recommended default)
 *   GEMINI_MODEL          = gemini-1.5-flash       (or gemini-1.5-pro)
 *
 * Optional:
 *   ALLOWED_ORIGIN        = https://your-github-pages-site (default "*")
 */

const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;
const { VertexAI } = require("@google-cloud/vertexai");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- CORS ----------
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// ---------- Helpers ----------
function getCredentials() {
  if (!process.env.GOOGLE_JSON_KEY) throw new Error("Missing GOOGLE_JSON_KEY");
  const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
  // Fix private_key newlines if stored with escaped \n
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }
  return credentials;
}

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.substring(5);
  return link;
}

// Unwrap derivedStructData from proto-ish structs
function smartUnwrap(data) {
  if (!data) return null;
  if (data.fields) {
    const out = {};
    for (const k of Object.keys(data.fields)) out[k] = unwrapValue(data.fields[k]);
    return out;
  }
  return data;
}
function unwrapValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.integerValue !== undefined) return v.integerValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.structValue) return smartUnwrap(v.structValue);
  if (v.listValue) return (v.listValue.values || []).map(unwrapValue);
  return v;
}

// ---------- Config (Discovery Engine Retrieval) ----------
const DE_PROJECT_NUMBER = process.env.DE_PROJECT_NUMBER || "28062079972";
const DE_LOCATION = process.env.DE_LOCATION || "global";
const DE_COLLECTION_ID = process.env.DE_COLLECTION_ID || "default_collection";
const DE_DATA_STORE_ID =
  process.env.DE_DATA_STORE_ID || "claretycoreai_1767340742213_gcs_store";

// We try datastore serving configs first. If your project only exposes engine configs,
// we’ll fallback to your known engine serving config (set DE_ENGINE_SERVING_CONFIG).
const DE_ENGINE_SERVING_CONFIG = process.env.DE_ENGINE_SERVING_CONFIG || ""; // optional

function datastoreServingConfig(id) {
  return `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/dataStores/${DE_DATA_STORE_ID}/servingConfigs/${id}`;
}

// ---------- Config (Vertex Gemini Generation) ----------
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || "groovy-root-483105-n9";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// ---------- Clients ----------
function getDiscoveryClient() {
  return new SearchServiceClient({ credentials: getCredentials() });
}

function getGeminiModel() {
  // Uses ADC-like credentials via provided service account JSON
  const vertexAI = new VertexAI({
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION,
    googleAuthOptions: { credentials: getCredentials() },
  });

  return vertexAI.getGenerativeModel({
    model: GEMINI_MODEL,
    // Keep responses tight + safer by default
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 700,
    },
  });
}

// ---------- Retrieval ----------
async function retrieveTopDocs(query, k = 5) {
  const client = getDiscoveryClient();

  const candidateServingConfigs = [
    datastoreServingConfig("default_search"),
    datastoreServingConfig("default_serving_config"),
  ];

  if (DE_ENGINE_SERVING_CONFIG) candidateServingConfigs.push(DE_ENGINE_SERVING_CONFIG);

  let lastErr = null;

  for (const servingConfig of candidateServingConfigs) {
    try {
      const request = {
        servingConfig,
        query,
        pageSize: k,
        // keep it simple; snippets are nice but can be omitted if your config rejects it
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true },
        },
      };

      const [resp] = await client.search(request, { autoPaginate: false });

      const results = (resp.results || []).map((r) => {
        const derived = smartUnwrap(r.document?.derivedStructData);
        const title = derived?.title || r.document?.id || "Document";
        const url = fixLink(derived?.link || derived?.uri || null);

        // best-effort snippet extraction
        let snippet = null;
        const snippets = derived?.snippets;
        if (Array.isArray(snippets) && snippets.length > 0) {
          const s = snippets[0]?.snippet;
          if (typeof s === "string" && s.trim()) snippet = s.replace(/<[^>]*>/g, "");
        }

        return { title, url, snippet };
      });

      return { servingConfigUsed: servingConfig, results };
    } catch (e) {
      lastErr = e;
      // try next candidate
      continue;
    }
  }

  throw lastErr || new Error("Retrieval failed");
}

// ---------- Generation ----------
function buildRagPrompt(userQuery, sources) {
  // We keep a strict instruction to cite sources by number.
  // Your UI can render citations as links.
  const srcText = sources
    .map((s, i) => {
      const parts = [];
      parts.push(`[${i + 1}] ${s.title || "Document"}`);
      if (s.url) parts.push(`URL: ${s.url}`);
      if (s.snippet) parts.push(`Excerpt: ${s.snippet}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return `
You are a helpful assistant for Clarety internal documentation.
Answer the user's question using ONLY the provided sources.
If the user asks for translation, translate accurately and keep the meaning.
If sources do not contain enough information, say what is missing and ask for a more specific term/file name.

Cite sources inline using [1], [2], etc.

User question:
${userQuery}

Sources:
${srcText}
`.trim();
}

// ---------- Routes ----------
app.get("/", (req, res) => res.send("Backend is running!"));

/**
 * Debug retrieval only:
 *   /debug-retrieve?q=Contact%20Change%20Log
 */
app.get("/debug-retrieve", async (req, res) => {
  try {
    const q = (req.query.q || "contact").toString().trim();
    const { servingConfigUsed, results } = await retrieveTopDocs(q, 5);
    res.json({ servingConfigUsed, count: results.length, results });
  } catch (e) {
    res.status(500).json({ code: e.code, details: e.details, message: e.message });
  }
});

/**
 * Main endpoint for your custom widget
 * Body: { "query": "..." }
 * Returns: { answer: "...", sources: [{title,url}], debug?: {...} }
 */
app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body?.query || "").trim();
    if (!userQuery) return res.json({ answer: "Ask me something.", sources: [] });

    // 1) retrieve
    const { servingConfigUsed, results } = await retrieveTopDocs(userQuery, 5);

    // If retrieval returns nothing, still let Gemini respond with a helpful “no match”
    const sources = results
      .filter((r) => r.url) // only keep linkable sources
      .map((r) => ({ title: r.title, url: r.url }));

    // 2) generate with Gemini
    const model = getGeminiModel();
    const prompt = buildRagPrompt(userQuery, results);

    const geminiResp = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const answer =
      geminiResp?.response?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "No response.";

    res.json({
      answer,
      sources,
      debug: {
        servingConfigUsed,
        retrievedCount: results.length,
      },
    });
  } catch (e) {
    res.status(500).json({ answer: "Backend error", code: e.code, details: e.details, message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
