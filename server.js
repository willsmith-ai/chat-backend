const express = require("express");
const cors = require("cors");
const { ConversationalSearchServiceClient } =
  require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({ origin: "*" }));

// --- CONFIGURATION (REPLACE THESE IF NEEDED) ---
const PROJECT = "28062079972"; // numeric project number is fine
const LOCATION = "global";
const COLLECTION_ID = "default_collection";

// IMPORTANT: Use your DATA STORE ID here (not engine ID)
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store";

// Serving config for datastore-based conversational search
const SERVING_CONFIG_ID = "default_search";
// ---------------------------------------------

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

    // Small greeting shortcut (optional)
    if (/^(hi|hello|hey|greetings)\b/i.test(userQuery)) {
      return res.json({
        answer: "Hi! Ask me about Clarety documents (e.g. Contact Change Log).",
        links: [],
