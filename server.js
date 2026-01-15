const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ===== CONFIG (only edit these) =====
const PROJECT = "28062079972";
const LOCATION = "global";
const COLLECTION_ID = "claretycoreai_1767340742213";
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store";
// ====================================

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.substring(5);
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

function datastoreServingConfig(id) {
  // ✅ DATA STORE path (NOT engines/)
  return `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/${id}`;
}

async function searchDatastore(client, query) {
  // Try both common ids
  const ids = ["default_search", "default_serving_config"];
  let lastErr;

  for (const id of ids) {
    const servingConfig = datastoreServingConfig(id);
    try {
      const request = {
        servingConfig,
        query,
        pageSize: 5,
        // Keep minimal; if this causes INVALID_ARGUMENT, we’ll remove it
        contentSearchSpec: { snippetSpec: { returnSnippet: true } },
      };

      const [resp] = await client.search(request, { autoPaginate: false });
      return { servingConfig, resp };
    } catch (e) {
      lastErr = e;
      // only try the next id if it’s likely just a naming mismatch
      if (![3, 5].includes(e.code)) break;
    }
  }

  throw lastErr || new Error("Search failed");
}

app.get("/", (req, res) => res.send("Backend is running!"));

// Debug endpoint: https://claretycoreapi.onrender.com/debug?q=contact
app.get("/debug", async (req, res) => {
  try {
    const q = (req.query.q || "contact").toString().trim();
    const client = getClient();
    const { servingConfig, resp } = await searchDatastore(client, q);

    const results = (resp.results || []).map((r) => {
      const derived = smartUnwrap(r.document?.derivedStructData);
      return {
        id: r.document?.id || null,
        title: derived?.title || null,
        link: fixLink(derived?.link || derived?.uri || null),
        derivedKeys: derived ? Object.keys(derived) : [],
      };
    });

    res.json({ servingConfig, count: results.length, results });
  } catch (e) {
    res.status(500).json({ code: e.code, details: e.details, message: e.message });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body?.query || "").trim();
    console.log("------------------------------------------------");
    console.log("User asked:", userQuery);

    if (!userQuery) return res.json({ answer: "Ask me something like 'Contact Change Log'.", links: [] });

    if (/^(hi|hello|hey|greetings)\b/i.test(userQuery)) {
      return res.json({
        answer: "Hi! I can search your Clarety Knowledge Database. Try 'Contact Change Log'.",
        links: [],
      });
    }

    const client = getClient();
    const { servingConfig, resp } = await searchDatastore(client, userQuery);

    console.log("Using servingConfig:", servingConfig);
    console.log("Results:", (resp.results || []).length);

    const links = [];
    const titles = [];

    for (const r of resp.results || []) {
      const derived = smartUnwrap(r.document?.derivedStructData);
      const title = derived?.title || r.document?.id || "Document";
      const url = fixLink(derived?.link || derived?.uri || null);

      titles.push(title);
      if (url) links.push({ title, url });
    }

    const answer =
      titles.length > 0
        ? `Top matching documents:\n• ${titles.join("\n• ")}`
        : "No matches found. Try searching the exact filename (e.g. 'Contact Change Log.docx').";

    return res.json({ answer, links });
  } catch (e) {
    console.error("Backend Error Code:", e.code);
    console.error("Backend Error Details:", e.details);
    console.error("Backend Error Message:", e.message);
    res.status(500).json({ answer: "Search backend error (see logs).", code: e.code, details: e.details, message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
