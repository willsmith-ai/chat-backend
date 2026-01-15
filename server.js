const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

// Allow requests from any website
app.use(cors({ origin: "*" }));

// --- THE TRUTH TABLE CONFIGURATION ---
const PROJECT_ID = "groovy-root-483105-n9"; 
const LOCATION = "global"; 
const COLLECTION_ID = "default_collection";
const ENGINE_ID = "claretycoreai_1767340856472"; 
const SERVING_CONFIG_ID = "default_search";
// -------------------------------------

// Helper: Fix Google's "gs://" links to be clickable "https://" links
function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}

// Helper: Unwrap Google's complex JSON fields
function unwrapFields(fields) {
    const result = {};
    for (const key in fields) {
        const val = fields[key];
        result[key] = val.stringValue || val;
    }
    return result;
}

app.get("/", (req, res) => {
    res.send("Clarety Core Backend is Live!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        // 1. Authenticate
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        // Fix private key formatting issues
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
        }
        const client = new SearchServiceClient({ credentials });

        // 2. Build the Exact Path (Engine + Collection + Config)
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;

        console.log("Connecting to:", servingConfig); 

        // 3. Send the Search Request
        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: { 
                snippetSpec: { returnSnippet: true } 
            },
            // Enable auto-correction for typos
            queryExpansionSpec: { condition: "AUTO" },
            spellCorrectionSpec: { mode: "AUTO" }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        // 4. Format the Answer
        let answer = "";
        const links = [];

        // Priority 1: AI Summary (If available)
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        }

        // Priority 2: Document Results
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

             // If no AI summary, construct a helpful list
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
        res.status(500).json({ answer: "I'm having trouble connecting to the database.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
