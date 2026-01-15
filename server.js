const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
// 1. PROJECT NUMBER (Numeric is confirmed working)
const PROJECT_ID = "28062079972"; 
const LOCATION = "global"; 

// 2. COLLECTION ID (Must be 'default_collection' for Data Store access)
const COLLECTION_ID = "default_collection";

// 3. DATA STORE ID (This is the one that found the image!)
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
function fixLink(link) {
    if (!link) return "#";
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
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        const lowerQ = (userQuery || "").toLowerCase();
        if (lowerQ.match(/^(hi|hello|hey|greetings)/)) {
            return res.json({ answer: "Hello! I am connected to the Clarety Knowledge Database.", links: [] });
        }

        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        // Safety fix for private key newlines
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
        }
        const client = new SearchServiceClient({ credentials });

        // --- PATH CONSTRUCTION ---
        // We use the DATA STORE path. This is the only path that has ever returned data (the image).
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores/${DATA_STORE_ID}/servingConfigs/default_search`;

        console.log("Connecting to:", servingConfig); 

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                // Minimal request to avoid errors
                snippetSpec: { returnSnippet: true }
            }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        // 3. ANSWER LOGIC (The Fix)
        let answer = "";
        const links = [];

        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             
             for (const result of response.results) {
                 const data = smartUnwrap(result.document.derivedStructData);
                 
                 // Link
                 if (data.link) {
                     links.push({ 
                         title: data.title || "View Document", 
                         url: fixLink(data.link) 
                     });
                 }

                 // Title
                 if (data.title) foundTitles.push(data.title);
             }

             // THE KEY FIX: If we have titles but no text summary, show the titles!
             // Previously, this scenario resulted in "0 results found" displayed to you.
             if (foundTitles.length > 0) {
                 answer = `I found these documents matching your query:\n• ${foundTitles.join("\n• ")}`;
             } else {
                 answer = "I found some relevant files. Please check the links below.";
             }
        } 
        
        if (!answer) {
            answer = "I searched the database but couldn't find a direct match. Try searching for a specific filename.";
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error Code:", error.code);
        console.error("Backend Error Details:", error.details);
        console.error("Backend Error Message:", error.message);
        
        res.status(500).json({ 
            answer: "I'm having trouble connecting. Check the server logs.", 
            error: error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
