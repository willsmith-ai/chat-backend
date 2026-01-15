const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: "*",
  })
);

// --- CONFIGURATION (KNOWN-GOOD PATH STYLE) ---
const PROJECT = "28062079972"; // project number
const LOCATION = "global";
const COLLECTION_ID = "default_collection";
const ENGINE_ID = "claretycoreai_1767340856472";
const SERVING_CONFIG_ID = "default_serving_config";
// --------------------------------------------

function fixLink(link) {
  if (!link) return "#";
  if (link.startsWith("gs://")) {
    return "https://storage.googleapis.com/" + link.substring(5);
  }
  return link;
}

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

function getClient() {
  if (!process.env.GOOGLE_JSON_KEY) throw new Error("Missing GOOGLE_JSON_KEY env var on Render");
  const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  return new SearchServiceClient({ credentials });
}

function getServingConfig() {
  return `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;
}

app.get("/", (req, res) => res.send("Backend is running!"));

// 🔎 Debug endpoint: hit /debug in your browser once after deploy
app.get("/debug", async (req, res) => {
  try {
    const client = getClient();
    const servingConfig = getServingConfig();

    // broad queries to test if anything is searchable
    const tests = ["contact", "log", "docx", "clarety"];

    const results = [];
    for (const q of tests) {
      const [resp] = await client.search(
        { servingConfig, query: q, pageSize: 3 },
        { autoPaginate: false }
      );

      const items =
        (resp.results || []).map((r) => {
          const derived = smartUnwrap(r.document?.derivedStructData);
          return {
            title: derived?.title || null,
            link: derived?.link ? fixLink(derived.link) : null,
            id: r.document?.id || null,
          };
        }) || [];

      results.push({ query: q, count: (resp.results || []).length, sample: items });
    }

    res.json({ servingConfig, results });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code, details: e.details });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body.query || "").trim();
    console.log("------------------------------------------------");
    console.log("User asked:", userQuery);

    if (!userQuery) return res.json({ answer: "Ask me something like 'Contact Change Log'.", links: [] });

    if (/^(hi|hello|hey|greetings)\b/i.test(userQuery)) {
      return res.json({ answer: "Hello! Try searching 'Contact Change Log' or 'Letter Export'.", links: [] });
    }

    const client = getClient();
    const servingConfig = getServingConfig();
    console.log("Connecting to:", servingConfig);

    // Minimal request — no snippetSpec, no summarySpec
    const [response] = await client.search({ servingConfig, query: userQuery, pageSize: 5 }, { autoPaginate: false });

    const found = response.results || [];
    console.log(`Found ${found.length} results.`);

    const titles = [];
    const links = [];

    for (const r of found) {
      const derived = smartUnwrap(r.document?.derivedStructData);
      if (derived?.title) titles.push(derived.title);
      if (derived?.link) links.push({ title: derived.title || "View Document", url: fixLink(derived.link) });
    }

    const answer =
      titles.length > 0
        ? `I found these matching documents:\n• ${titles.join("\n• ")}`
        : "I searched the database but didn't find a match. Try searching for the exact filename.";

    res.json({ answer, links });
  } catch (error) {
    console.error("Backend Error Code:", error.code);
    console.error("Backend Error Details:", error.details);
    console.error("Backend Error Message:", error.message);
    res.status(500).json({ answer: "Backend connection error.", code: error.code, details: error.details, message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
