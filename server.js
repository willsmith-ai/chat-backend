const express = require("express");
const cors = require("cors");
const { SearchServiceClient } =
  require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// =====================
// CONFIG (DO NOT GUESS)
// =====================
const PROJECT_NUMBER = "28062079972";
const LOCATION = "global";
const COLLECTION_ID = "default_collection";
const ENGINE_ID = "claretycoreai_1767340856472";

// This is the SEARCH serving config used by Preview
const SERVING_CONFIG_ID = "default_search";

// =====================

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) {
    return "https://storage.googleapis.com/" + link.substring(5);
  }
  return link;
}

app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
  try {
    const query = (req.body?.query || "").trim();
    console.log("------------------------------------------------");
    console.log("User asked:", query);

    if (!query) {
      return res.json({ answer: "Ask me something.", links: [] });
    }

    if (!process.env.GOOGLE_JSON_KEY) {
      throw new Error("Missing GOOGLE_JSON_KEY");
    }

    const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }

    const client = new SearchServiceClient({ credentials });

    // 🔑 THIS IS THE PREVIEW PATH
    const servingConfig =
      `projects/${PROJECT_NUMBER}` +
      `/locations/${LOCATION}` +
      `/collections/${COLLECTION_ID}` +
      `/engines/${ENGINE_ID}` +
      `/servingConfigs/${SERVING_CONFIG_ID}`;

    console.log("Using servingConfig:", servingConfig);

    const request = {
      servingConfig,
      query,
      pageSize: 5,
      contentSearchSpec: {
        snippetSpec: { returnSnippet: true }
      }
    };

    const [response] = await client.search(request);

    console.log("Results:", response.results?.length || 0);

    // =====================
    // FORMAT LIKE PREVIEW
    // =====================
    let answer = "";
    const links = [];

    if (response.results && response.results.length > 0) {
      const titles = [];

      for (const r of response.results) {
        const data = r.document?.derivedStructData?.fields || {};

        const title = data.title?.stringValue;
        const link = data.link?.stringValue;

        if (title) titles.push(title);
        if (link) {
          links.push({
            title: title || "View document",
            url: fixLink(link)
          });
        }
      }

      answer =
        "Here’s what I found:\n\n" +
        titles.map(t => `• ${t}`).join("\n");
    } else {
      answer = "No matching documents found.";
    }

    res.json({ answer, links });
  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({
      answer: "Backend error",
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
