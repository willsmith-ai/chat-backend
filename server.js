const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ================= CONFIG =================
const PROJECT_NUMBER = "28062079972";
const LOCATION = "global";
const COLLECTION_ID = "default_collection";

// ✅ THIS is where your documents actually live
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

function getUserInfo() {
  const email = (process.env.TEST_USER_EMAIL || "").trim();
  if (!email) return undefined;
  return { userId: email };
}

function unwrapStruct(s) {
  if (!s || !s.fields) return {};
  const out = {};
  for (const k of Object.keys(s.fields)) {
    out[k] = unwrapValue(s.fields[k]);
  }
  return out;
}
function unwrapValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.structValue) return unwrapStruct(v.structValue);
  if (v.listValue?.values) return v.listValue.values.map(unwrapValue);
  return null;
}
function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) {
    return "https://storage.googleapis.com/" + link.substring(5);
  }
  return link;
}

app.get("/", (req, res) => res.send("Backend is running"));

app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT REQUEST", req.body);
  console.log("TEST_USER_EMAIL", process.env.TEST_USER_EMAIL ? "[set]" : "[not set]");
  console.log("=================================");

  try {
    const query = (req.body.query || "").trim();
    if (!query) {
      return res.json({ answer: "Please type a question.", links: [] });
    }

    const client = new SearchServiceClient({
      credentials: getCredentials()
    });

    // ✅ DATA STORE serving config (this is the key fix)
    const servingConfig =
      `projects/${PROJECT_NUMBER}/locations/${LOCATION}` +
      `/collections/${COLLECTION_ID}` +
      `/dataStores/${DATA_STORE_ID}` +
      `/servingConfigs/default_search`;

    console.log("Using servingConfig:", servingConfig);

    const [response] = await client.search(
      {
        servingConfig,
        query,
        pageSize: 10,

        // required for ACL
        userInfo: getUserInfo(),
        userPseudoId: "clarety-web-user",

        spellCorrectionSpec: { mode: "AUTO" },
        queryExpansionSpec: { condition: "AUTO" },
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true }
        }
      },
      { autoPaginate: false }
    );

    const results = response.results || [];
    console.log("Results:", results.length);

    const titles = [];
    const links = [];

    for (const r of results) {
      const data = unwrapStruct(r.document?.derivedStructData);

      if (data.title) titles.push(data.title);

      if (data.link) {
        links.push({
          title: data.title || "Source document",
          url: fixLink(data.link)
        });
      }
    }

    const answer =
      titles.length > 0
        ? `Documents found:\n• ${titles.join("\n• ")}`
        : "No documents found";

    res.json({ answer, links });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.status(500).json({
      answer: "Search failed",
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Server listening on port ${PORT}`)
);
