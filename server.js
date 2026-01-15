const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ================= CONFIG =================
// Numeric project number
const PROJECT_NUMBER = "28062079972";
const LOCATION = "global";

// IMPORTANT: this is the COLLECTION ID shown in your console URL / screenshots
const COLLECTION_ID = "claretycoreai_1767340742213";

// This is your Data Store ID shown on the Data Store page
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store";
// ==========================================

function getCredentials() {
  if (!process.env.GOOGLE_JSON_KEY) {
    throw new Error("Missing GOOGLE_JSON_KEY");
  }
  const creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

function unwrapProtoStruct(structData) {
  // derivedStructData comes back in a proto-ish structure; titles/links often live in fields
  if (!structData) return {};
  if (!structData.fields) return structData;

  const out = {};
  for (const k of Object.keys(structData.fields)) {
    const v = structData.fields[k];
    out[k] =
      v.stringValue ??
      v.numberValue ??
      v.boolValue ??
      (v.listValue?.values ? v.listValue.values.map(unwrapValue) : undefined) ??
      (v.structValue ? unwrapProtoStruct(v.structValue) : undefined) ??
      v;
  }
  return out;
}
function unwrapValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.structValue) return unwrapProtoStruct(v.structValue);
  if (v.listValue?.values) return v.listValue.values.map(unwrapValue);
  return v;
}

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.substring(5);
  return link;
}

app.get("/", (req, res) => res.send("Backend is running"));

app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT REQUEST");
  console.log(req.body);
  console.log("=================================");

  try {
    const query = (req.body.query || "").trim();
    if (!query) return res.json({ answer: "Please type a question.", links: [] });

    const client = new SearchServiceClient({ credentials: getCredentials() });

    // ✅ DATA STORE serving config (this is where your 69 docs live)
    const servingConfig = `projects/${PROJECT_NUMBER}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/default_search`;

    console.log("Using servingConfig:", servingConfig);

    const [response] = await client.search(
      {
        servingConfig,
        query,
        pageSize: 10,
        // include userPseudoId to match preview behaviour, harmless for datastore too
        userPseudoId: "clarety-web-user",
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true }
        },
        spellCorrectionSpec: { mode: "AUTO" },
        queryExpansionSpec: { condition: "AUTO" }
      },
      { autoPaginate: false }
    );

    const results = response.results || [];
    console.log("Results:", results.length);

    const links = [];
    const titles = [];
    let bestSnippet = "";

    for (const r of results) {
      const data = unwrapProtoStruct(r.document?.derivedStructData);

      if (data.title) titles.push(data.title);

      if (data.link) {
        links.push({
          title: data.title || "Source",
          url: fixLink(data.link)
        });
      }

      if (!bestSnippet && data.snippets && Array.isArray(data.snippets) && data.snippets.length > 0) {
        const snip = data.snippets[0]?.snippet;
        if (snip && !snip.includes("No snippet is available")) {
          bestSnippet = snip.replace(/<[^>]*>/g, "");
        }
      }
    }

    let answer = "";
    if (titles.length > 0) {
      answer = `Documents found:\n• ${titles.join("\n• ")}`;
    } else if (bestSnippet) {
      answer = `Here is what I found:\n"${bestSnippet}"`;
    } else {
      answer = "No documents found";
    }

    res.json({ answer, links });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.status(500).json({ answer: "Search failed", error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
