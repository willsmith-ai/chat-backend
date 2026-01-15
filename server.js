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
const ENGINE_ID = "claretycoreai_1767340856472";
// ==========================================

function getCredentials() {
  if (!process.env.GOOGLE_JSON_KEY) throw new Error("Missing GOOGLE_JSON_KEY");
  const creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  return creds;
}

function getUserInfo() {
  // This is ONLY for debugging ACL/identity filtering.
  // If this makes results appear, we’ve proven access control is enabled.
  const email = (process.env.TEST_USER_EMAIL || "").trim();
  if (!email) return undefined;
  return { userId: email };
}

function unwrapStruct(s) {
  if (!s) return {};
  if (!s.fields) return s;
  const out = {};
  for (const k of Object.keys(s.fields)) out[k] = unwrapValue(s.fields[k]);
  return out;
}
function unwrapValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.structValue) return unwrapStruct(v.structValue);
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
  console.log("CHAT REQUEST", req.body);
  console.log("TEST_USER_EMAIL", process.env.TEST_USER_EMAIL ? "[set]" : "[not set]");
  console.log("=================================");

  try {
    const query = (req.body.query || "").trim();
    if (!query) return res.json({ answer: "Please type a question.", links: [] });

    const client = new SearchServiceClient({ credentials: getCredentials() });

    // Engine serving config (matches Preview “App” behaviour most closely)
    const servingConfig =
      `projects/${PROJECT_NUMBER}/locations/${LOCATION}/collections/${COLLECTION_ID}` +
      `/engines/${ENGINE_ID}/servingConfigs/default_search`;

    console.log("Using servingConfig:", servingConfig);

    const request = {
      servingConfig,
      query,
      pageSize: 10,

      // ✅ critical for ACL setups
      userInfo: getUserInfo(),

      // still helpful
      userPseudoId: "clarety-web-user",
      spellCorrectionSpec: { mode: "AUTO" },
      queryExpansionSpec: { condition: "AUTO" },
      contentSearchSpec: { snippetSpec: { returnSnippet: true } }
    };

    const [response] = await client.search(request, { autoPaginate: false });

    const results = response.results || [];
    console.log("Results:", results.length);

    const titles = [];
    const links = [];

    for (const r of results) {
      const data = unwrapStruct(r.document?.derivedStructData);
      if (data.title) titles.push(data.title);
      if (data.link) {
        links.push({
          title: data.title || "Source",
          url: fixLink(data.link)
        });
      }
    }

    const answer =
      titles.length > 0
        ? `Documents found:\n• ${titles.join("\n• ")}`
        : "No documents found";

    res.json({ answer, links, debug: { count: titles.length } });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.status(500).json({ answer: "Search failed", error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
