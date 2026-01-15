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

// ================= CONFIG =================
const PROJECT_NUMBER = "28062079972";
const LOCATION = "global";
const COLLECTION_ID = "default_collection";
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

app.get("/", (req, res) => {
  res.send("Backend is running");
});

/**
 * STEP 2: Discovery Engine ONLY
 */
app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT HIT");
  console.log("Query:", req.body);
  console.log("=================================");

  try {
    const query = req.body.query || "";

    const client = new SearchServiceClient({
      credentials: getCredentials(),
    });

    const servingConfig = `projects/${PROJECT_NUMBER}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/default_search`;

    console.log("Using servingConfig:", servingConfig);

    const [response] = await client.search(
      {
        servingConfig,
        query,
        pageSize: 10,
      },
      { autoPaginate: false }
    );

    console.log("Result count:", response.results?.length || 0);

    const titles = [];

    if (response.results) {
      for (const r of response.results) {
        const data = r.document?.derivedStructData;
        if (data?.fields?.title?.stringValue) {
          titles.push(data.fields.title.stringValue);
        }
      }
    }

    return res.json({
      answer:
        titles.length > 0
          ? "Documents found:\n• " + titles.join("\n• ")
          : "No documents found",
      debug: {
        count: titles.length,
      },
    });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    return res.status(500).json({
      answer: "Discovery Engine error",
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
