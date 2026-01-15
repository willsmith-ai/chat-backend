// server.js — DELETE YOUR WHOLE FILE AND PASTE THIS

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

// --- CONFIGURATION ---
// Use numeric project number (fine either way; this removes ambiguity)
const PROJECT_ID = "28062079972";
const LOCATION = "global";

// Engine ID from your console URL
const ENGINE_ID = "claretycoreai_1767340856472";

// IMPORTANT: for the Search API, the canonical servingConfig format includes a collection
// and the default serving config is usually "default_serving_config"
const COLLECTION_ID = "default_collection";
const SERVING_CONFIG_ID = "default_serving_config";
// ---------------------

// --- HELPERS ---
function fixLink(link) {
  if (!link) return "#";
  if (link.startsWith("gs://")) {
    return "https://storage.googleapis.com/" + link.substring(5);
  }
  return link;
}

// Safely unwrap derived struct fields if present
function smartUnwrap(data) {
  if (!data) return null;
  if (data.fields) {
    const out = {};
    for (const k of Object.keys(data.fields)) {
      out[k] = unwrapValue(data.fields[k]);
    }
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

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body.query || "").trim();

    console.log("------------------------------------------------");
    console.log("User asked:", userQuery);

    if (!userQuery) {
      return res.json({
        answer: "Ask me something like 'Contact Change Log'.",
        links: [],
      });
    }

    // quick greeting shortcut
    if (/^(hi|hello|hey|greetings)\b/i.test(userQuery)) {
      return res.json({
        answer:
          "Hello! Try searching for a doc name like 'Contact Change Log' or 'Letter Export'.",
        links: [],
      });
    }

    if (!process.env.GOOGLE_JSON_KEY) {
      throw new Error("Missing GOOGLE_JSON_KEY env var on Render");
    }

    const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }

    const client = new SearchServiceClient({ credentials });

    // ✅ Canonical servingConfig format (collection + engine + default_serving_config)
    const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;
    console.log("Connecting to:", servingConfig);

    // ✅ Minimal valid search request (no contentSearchSpec, no summarySpec)
    const request = {
      servingConfig,
      query: userQuery,
      pageSize: 5,
    };

    const [response] = await client.search(request, { autoPaginate: false });

    const results = response.results || [];
    console.log(`Found ${results.length} results.`);

    let answer = "";
    const links = [];

    if (results.length > 0) {
      const titles = [];

      for (const r of results) {
        const derived = smartUnwrap(r.document?.derivedStructData);

        if (derived?.title) titles.push(derived.title);

        if (derived?.link) {
          links.push({
            title: derived.title || "View Document",
            url: fixLink(derived.link),
          });
        }
      }

      if (titles.length) {
        answer = `I found these matching documents:\n• ${titles.join("\n• ")}`;
      } else if (links.length) {
        answer = "I found relevant files. Check the links below.";
      } else {
        answer = "I found results but couldn't extract titles/links.";
      }
    } else {
      answer =
        "I searched the database but didn't find a match. Try searching for an exact filename like 'Contact Change Log'.";
    }

    return res.json({ answer, links });
  } catch (error) {
    // Print the useful fields (Render logs)
    console.error("Backend Error Code:", error.code);
    console.error("Backend Error Details:", error.details);
    console.error("Backend Error Message:", error.message);

    return res.status(500).json({
      answer: "Backend connection error.",
      code: error.code,
      details: error.details,
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
