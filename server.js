const express = require("express");
const cors = require("cors");
// IMPORT BOTH CLIENTS: One for searching, one for checking settings
const { SearchServiceClient, ServingConfigServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({ origin: "*" }));

// --- CONFIGURATION ---
const PROJECT = "28062079972"; 
const LOCATION = "global";
const COLLECTION_ID = "default_collection";
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store"; 
// ---------------------

// Helper for Credentials
function getCredentials() {
    if (!process.env.GOOGLE_JSON_KEY) {
        throw new Error("Missing GOOGLE_JSON_KEY env var");
    }
    const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
    if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }
    return credentials;
}

app.get("/", (req, res) => res.send("Backend is running!"));

// --- FIXED DIAGNOSTIC ENDPOINT ---
app.get("/configs", async (req, res) => {
    try {
        const credentials = getCredentials();
        // USE THE CORRECT CLIENT FOR LISTING CONFIGS
        const configClient = new ServingConfigServiceClient({ credentials });
        
        const parent = `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}`;
        
        console.log(`Listing configs for: ${parent}`);
        
        const [configs] = await configClient.listServingConfigs({ parent });

        res.json({
            parent,
            count: configs.length,
            configs: configs.map(c => ({
                name: c.name, 
                displayName: c.displayName,
                state: c.mediaState // Checks if it's active
            }))
        });
    } catch (e) {
        console.error("Config Error:", e);
        res.status(500).json({ code: e.code, details: e.details, message: e.message });
    }
});

// --- SEARCH ENDPOINT ---
app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        const credentials = getCredentials();
        const client = new SearchServiceClient({ credentials });

        // We are temporarily guessing 'default_search' until you run /configs
        const servingConfig = `projects/${PROJECT}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/default_search`;

        console.log("Connecting to:", servingConfig); 

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: { snippetSpec: { returnSnippet: true } }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        let answer = "";
        const links = [];

        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             for (const result of response.results) {
                 const data = result.document.derivedStructData;
                 
                 // Handle nested 'fields' structure if Google wraps it
                 const fields = data.fields ? unwrapFields(data.fields) : data;

                 if (fields.link) {
                     let url = fields.link;
                     if (url.startsWith("gs://")) {
                         url = "https://storage.googleapis.com/" + url.substring(5);
                     }
                     links.push({ title: fields.title || "Document", url });
                 }
                 if (fields.title) foundTitles.push(fields.title);
             }

             if (foundTitles.length > 0) {
                 answer = `I found these documents:\n• ${foundTitles.join("\n• ")}`;
             } else {
                 answer = "I found relevant files. Check the links below.";
             }
        } 
        
        if (!answer) answer = "No matching documents found.";

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "Connection error.", error: error.message });
    }
});

// Helper to unwrap Google's messy JSON if needed
function unwrapFields(fields) {
    const result = {};
    for (const key in fields) {
        const val = fields[key];
        result[key] = val.stringValue || val;
    }
    return result;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
