const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
// I pulled these exactly from the successful log you just sent:
const PROJECT_NUMBER = "28062079972"; 
const LOCATION = "global"; 
const DATA_STORE_ID = "claretycoreai_1767340742213_gcs_store"; 
// ---------------------

// --- HELPER: DATA CLEANER ---
function smartUnwrap(data) {
    if (!data) return null;
    if (data.fields) {
        const result = {};
        for (const key in data.fields) {
            result[key] = unwrapValue(data.fields[key]);
        }
        return result;
    }
    return data;
}

function unwrapValue(value) {
    if (!value) return null;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.structValue) return smartUnwrap(value.structValue);
    if (value.listValue) return value.listValue.values.map(unwrapValue);
    return value; 
}

// --- HELPER: LINK FIXER ---
// Your logs show links like: gs://claretycoreaibucket/...
// Browsers can't open "gs://". We must change it to "https://"
function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        // We replace "gs://" with the public storage URL
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}

app.get("/", (req, res) => {
    res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("User asked:", userQuery);

        // 1. PERSONALITY LAYER
        const lowerQ = userQuery.toLowerCase();
        if (lowerQ.match(/^(hi|hello|hey)/)) {
            return res.json({ answer: "Hello! I am connected to the Clarety Knowledge Database.", links: [] });
        }

        // 2. CONNECT TO GOOGLE
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });

        // Using the DataStore path because your logs confirm this is what returns data
        const servingConfig = `projects/${PROJECT_NUMBER}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                // We ask for snippets, but we won't crash if we don't get them
                snippetSpec: { returnSnippet: true }
            }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        // 3. ROBUST ANSWER LOGIC
        let answer = "";
        const links = [];

        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             
             // Loop through EVERY result found
             for (const result of response.results) {
                 const data = smartUnwrap(result.document.derivedStructData);
                 
                 // Save the link if it exists
                 if (data.link) {
                     links.push({ 
                         title: data.title || "View Document", 
                         url: fixLink(data.link) 
                     });
                 }

                 // Collect the title
                 if (data.title) {
                     foundTitles.push(data.title);
                 }
             }
             
             // Construct the answer
             if (foundTitles.length > 0) {
                 answer = `I found the following matching documents:\n• ${foundTitles.join("\n• ")}`;
             } else {
                 answer = "I found some files, but they don't have clear titles. Please check the links below.";
             }
        } 
        
        if (!answer) {
            answer = "I searched the database but didn't find any matching documents. Try searching for a specific filename.";
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "Connection error.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
