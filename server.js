const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({ origin: "*" }));

// --- CONFIGURATION ---
// We are not guessing anymore. We are using the EXACT string provided by your /configs endpoint.
const SERVING_CONFIG = "projects/28062079972/locations/global/collections/default_collection/engines/claretycoreai_1767340856472/servingConfigs/default_search";
// ---------------------

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

function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        const credentials = getCredentials();
        const client = new SearchServiceClient({ credentials });

        console.log("Connecting to:", SERVING_CONFIG); 

        const request = {
            servingConfig: SERVING_CONFIG,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: { snippetSpec: { returnSnippet: true } }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        let answer = "";
        const links = [];

        // Check for AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        }

        // Process Results
        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             for (const result of response.results) {
                 const data = result.document.derivedStructData;
                 // Unwrap fields if needed (sometimes Google wraps them, sometimes not)
                 const fields = data.fields ? unwrapFields(data.fields) : data;

                 if (fields.link) {
                     links.push({ 
                         title: fields.title || "View Document", 
                         url: fixLink(fields.link) 
                     });
                 }
                 if (fields.title) foundTitles.push(fields.title);
             }

             // If no AI summary, use the titles
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
        res.status(500).json({ answer: "Connection error.", error: error.message });
    }
});

// Helper to handle Google's inconsistent JSON structures
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
