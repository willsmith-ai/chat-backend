const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({ origin: "*" }));

// --- CONFIGURATION ---
// 1. PROJECT ID: STRING (Confirmed working in Turn 5)
const PROJECT_ID = "groovy-root-483105-n9"; 
const LOCATION = "global"; 
const COLLECTION_ID = "default_collection";

// 2. TARGET: DATA STORE ID (Confirmed working in Turn 5)
// We are bypassing the Engine ID entirely.
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store"; 
const SERVING_CONFIG_ID = "default_search";
// ---------------------

function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}

function unwrapFields(fields) {
    const result = {};
    for (const key in fields) {
        const val = fields[key];
        result[key] = val.stringValue || val;
    }
    return result;
}

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
        }
        const client = new SearchServiceClient({ credentials });

        // --- THE CRITICAL FIX ---
        // We are using the DATA STORE path. This is the only path that has ever worked for you.
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;

        console.log("Connecting to:", servingConfig); 

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: { 
                snippetSpec: { returnSnippet: true } 
            },
            queryExpansionSpec: { condition: "AUTO" },
            spellCorrectionSpec: { mode: "AUTO" }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        let answer = "";
        const links = [];

        // 1. Check for AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        }

        // 2. Check for Documents
        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             
             for (const result of response.results) {
                 const data = result.document.derivedStructData;
                 const fields = data.fields ? unwrapFields(data.fields) : data;

                 if (fields.link) {
                     links.push({ 
                         title: fields.title || "View Document", 
                         url: fixLink(fields.link) 
                     });
                 }
                 if (fields.title) foundTitles.push(fields.title);
             }

             if (!answer) {
                 if (foundTitles.length > 0) {
                     answer = `I found these documents matching your query:\n• ${foundTitles.join("\n• ")}`;
                 } else {
                     answer = "I found some relevant files. Please check the links below.";
                 }
             }
        } 
        
        if (!answer) {
            answer = "I searched the database but couldn't find a direct match. Try searching for a specific filename.";
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "I'm having trouble connecting.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
