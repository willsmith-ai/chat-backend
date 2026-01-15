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
  if (!process.env.GOOGLE_JSON_KEY) {
    throw new Error("Missing GOOGLE_JSON_KEY");
  }
  const creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT REQUEST");
  console.log(req.body);
  console.log("=================================");

  try {
    const query = req.body.query || "";

    const client = new SearchServiceClient({
      credentials: getCredentials(),
    });

    const servingConfig = `
projects/${PROJECT_NUMBER}/locations/${LOCATION}
  /collections/${COLLECTION_ID}
  /engines/${ENGINE_ID}
  /servingConfigs/default_search
`.replace(/\s+/g, "");

    console.log("Using servingConfig:", servingConfig);

    const [response] = await client.search(
      {
        servingConfig,
        query,
        pageSize: 10,

        // 🔑 THIS IS THE FIX
        userPseudoId: "clarety-web-user",

        // Optional but recommended
        spellCorrectionSpec: { mode: "AUTO" },
        queryExpansionSpec: { condition: "AUTO" },
      },
      { autoPaginate: false }
    );

    console.log("Results:", response.results?.length || 0);

    const titles = [];

    if (response.results) {
      for (const r of response.results) {
        const fields = r.document?.derivedStructData?.fields;
        if (fields?.title?.stringValue) {
          titles.push(fields.title.stringValue);
        }
      }
    }

    res.json({
      answer:
        titles.length > 0
          ? "Documents found:\n• " + titles.join("\n• ")
          : "No documents found",
      debug: {
        count: titles.length,
      },
    });
  } catch (err) {
    console.error("ENGINE SEARCH ERROR:", err);
    res.status(500).json({
      answer: "Search failed",
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
