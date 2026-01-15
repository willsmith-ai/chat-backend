const express = require("express");
const cors = require("cors");
const { ConversationalSearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({ origin: "*" }));

// --- CONFIGURATION ---
const PROJECT = "28062079972"; 
const LOCATION = "global";
const COLLECTION_ID = "default_collection";

// IMPORTANT: Using DATA STORE ID (Not Engine ID)
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store";

// Serving config name
const SERVING_CONFIG_ID = "default_search";
// ---------------------

function fixLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) {
    return "https://storage.googleapis.com/" + link.substring(5);
  }
  return link;
}

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
  try {
    const userQuery = (req.body?.query || "").trim();
    console.log("------------------------------------------------");
    console.log("User asked:", userQuery);

    if (!userQuery) {
      return res.json({ answer: "Ask me a question.", links: [] });
    }

    if (/^(hi|hello|hey|greetings)\b/i.test(userQuery)) {
      return res.json({
        answer: "Hi! Ask me about Clarety documents (e.g. Contact Change Log).",
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

    const client = new ConversationalSearchServiceClient({ credentials });

    // Resource Path: Data Store Conversational
    const conversationName = `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/conversations/-`;

    // Serving Config Path
    const servingConfig = `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;

    console.log("Conversation name:", conversationName);
    console.log("Serving config:", servingConfig);

    const request = {
      name: conversationName,
      servingConfig: servingConfig,
      query: { text: userQuery },
    };

    const [response] = await client.converseConversation(request);

    // Answer Extraction
    const answer = response?.reply?.reply || "No answer returned.";

    // Link Extraction
    const links = [];
    const refs = response?.reply?.references || [];
    for (const r of refs) {
      // Try to find the title in various places
      const title =
        r?.document?.title ||
        r?.document?.id ||
        "Document";

      // Try to find the link in various places
      const rawLink = r?.document?.derivedStructData?.link || r?.uri;
      const url = fixLink(rawLink);

      if (url) links.push({ title, url });
    }

    res.json({ answer, links });

  } catch (error) {
    console.error("Backend Error Code:", error.code);
    console.error("Backend Error Details:", error.details);
    console.error("Backend Error Message:", error.message);

    res.status(500).json({
      answer: "Backend chat error (see logs).",
      code: error.code,
      details: error.details,
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
