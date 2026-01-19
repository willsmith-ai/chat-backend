/**
 * server.js — Clarety Core AI (Discovery Engine search + Vertex AI Gemini answer)
 *
 * What this fixes:
 * 1) Discovery Engine search uses your service account JSON (GOOGLE_JSON_KEY)
 * 2) Vertex AI (Gemini) ALSO uses the same service account JSON (NO ADC / no gcloud login)
 *
 * Required Render env vars:
 * - GOOGLE_JSON_KEY      = full service account JSON (single-line is fine)
 * - DE_PROJECT_NUMBER    = 28062079972
 * - DE_LOCATION          = global
 * - DE_COLLECTION_ID     = default_collection
 * - DE_ENGINE_ID         = claretycoreai_1767340856472
 *
 * - VERTEX_PROJECT_ID    = groovy-root-483105-n9   (project *id* where Vertex AI is enabled)
 * - VERTEX_LOCATION      = us-central1             (recommended)
 * - GEMINI_MODEL         = gemini-1.5-flash        (or gemini-1.5-pro)
 *
 * Optional:
 * - ALLOWED_ORIGIN       = https://willsmith-ai.github.io   (or "*" for testing)
 * - TEST_USER_EMAIL      = anything@example.com (for debugging only)
 */

"use strict";

const express = require("express");
const cors = require("cors");

const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;
const { VertexAI } = require("@google-cloud/vertexai");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

// -------------------------
// Helpers
// -------------------------
function getCredentials() {
  if (!process.env.GOOGLE_JSON_KEY) {
    throw new Error("Missing GOOGLE_JSON_KEY env var");
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
  } catch (e) {
    throw new Error(
      "GOOGLE_JSON_KEY is not valid JSON. Paste the FULL service account JSON contents."
    );
  }

  // Fix escaped newlines in private_key if stored as a single-line env var
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }

  if (!credentials.client_email) {
    throw new Error("The incoming JSON object does not contain a client_email field");
  }

  return credentials;
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

// Unwrap derivedStructData from proto-ish structs (works for node client responses)
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
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.structValue) return smartUnwrap(v.structValue);
  if (v.listValue?.values) return v.listValue.values.map(unwrapValue);
  return v;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, "");
}

// -------------------------
// Config (from env)
// -------------------------
function getDeServingConfig() {
  const DE_PROJECT_NUMBER = requireEnv("DE_PROJECT_NUMBER"); // numeric
  const DE_LOCATION = requireEnv("DE_LOCATION"); // global
  const DE_COLLECTION_ID = requireEnv("DE_COLLECTION_ID"); // default_collection
  const DE_ENGINE_ID = requireEnv("DE_ENGINE_ID"); // your engine id

  return `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/default_search`;
}

function getVertexConfig() {
  return {
    project: requireEnv("VERTEX_PROJECT_ID"),
    location: requireEnv("VERTEX_LOCATION"),
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  };
}

// -------------------------
// Clients (created per request to keep it simple and avoid stale env issues)
// -------------------------
function makeDiscoveryEngineClient(credentials) {
  return new SearchServiceClient({ credentials });
}

function makeVertexClient(credentials) {
  const { project, location } = getVertexConfig();

  // ✅ THIS IS THE KEY FIX:
  // We pass explicit credentials to VertexAI so it DOES NOT try ADC.
  return new VertexAI({
    project,
    location,
    googleAuthOptions: { credentials },
  });
}

// -------------------------
// Routes
// -------------------------
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

// Quick debug: confirm server sees env + which serving config it uses
app.get("/debug-config", (req, res) => {
  try {
    const creds = getCredentials();
    res.json({
      ok: true,
      deServingConfig: getDeServingConfig(),
      vertex: getVertexConfig(),
      serviceAccount: creds.client_email,
      allowedOrigin: process.env.ALLOWED_ORIGIN || "*",
      testUserEmail: process.env.TEST_USER_EMAIL || "[not set]",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/chat", async (req, res) => {
  const userQuery = (req.body?.query || "").trim();

  console.log("=================================");
  console.log("CHAT REQUEST", { query: userQuery });
  console.log("TEST_USER_EMAIL", process.env.TEST_USER_EMAIL ? "[set]" : "[not set]");
  console.log("=================================");

  if (!userQuery) return res.json({ answer: "Please type a question.", links: [] });

  // Simple greeting shortcut
  const lower = userQuery.toLowerCase();
  if (/^(hi|hello|hey|greetings)\b/.test(lower)) {
    return res.json({
      answer: "Hello! I am connected to the Clarety Knowledge Database. Ask me anything.",
      links: [],
    });
  }

  try {
    // 1) Credentials
    const credentials = getCredentials();

    // 2) Discovery Engine search
    const deClient = makeDiscoveryEngineClient(credentials);
    const servingConfig = getDeServingConfig();

    console.log("Using servingConfig:", servingConfig);

    const request = {
      servingConfig,
      query: userQuery,
      pageSize: 10,
      queryExpansionSpec: { condition: "AUTO" },
      spellCorrectionSpec: { mode: "AUTO" },
      // Keep contentSearchSpec minimal; we rely on extractive_answers in derivedStructData
      // contentSearchSpec: { snippetSpec: { returnSnippet: true } },
    };

    const [deResponse] = await deClient.search(request, { autoPaginate: false });

    const results = deResponse.results || [];
    console.log("Results:", results.length);

    // Build citations/links + context for Gemini
    const links = [];
    const contextChunks = [];

    for (const r of results) {
      const derived = smartUnwrap(r.document?.derivedStructData);
      if (!derived) continue;

      const title = derived.title || "Source document";
      const url = fixLink(derived.link);

      if (url) links.push({ title, url });

      // Prefer extractive_answers content if present
      const answers = Array.isArray(derived.extractive_answers) ? derived.extractive_answers : [];
      const extract = answers
        .map((a) => stripHtml(a?.content || ""))
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");

      if (extract) {
        contextChunks.push(`Title: ${title}\nExtract: ${extract}\nSource: ${url || derived.link || ""}`);
      } else {
        // fallback: at least pass title
        contextChunks.push(`Title: ${title}\nSource: ${url || derived.link || ""}`);
      }
    }

    // If no docs found, respond without calling Gemini (optional)
    if (contextChunks.length === 0) {
      return res.json({
        answer: "No documents found. Try a different keyword (e.g., the exact document title).",
        links: [],
      });
    }

    // 3) Gemini answer using Vertex AI (authenticated via service account JSON)
    const vertex = makeVertexClient(credentials);
    const { model } = getVertexConfig();

    const generativeModel = vertex.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 600,
      },
    });

    // Simple, grounded prompt: answer using provided context; keep it client-safe
    const systemStyle = `
You are Clarety Core AI. Answer clearly and helpfully.
Use ONLY the provided context. If the context doesn't contain the answer, say so.
If the user asks for a "how-to", give steps.
If the user asks for translation, translate.
Keep responses concise and client-safe.
`;

    const prompt = `
${systemStyle}

USER QUESTION:
${userQuery}

CONTEXT (top search extracts):
${contextChunks.join("\n\n---\n\n")}
`;

    const geminiResp = await generativeModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const answer =
      geminiResp?.response?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "I found documents, but couldn't generate an answer.";

    return res.json({ answer, links });
  } catch (error) {
    console.error("CHAT ERROR:", error?.message || error);
    res.status(500).json({
      answer: "Backend error. Check server logs.",
      error: error?.message || String(error),
    });
  }
});

// Render port binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
