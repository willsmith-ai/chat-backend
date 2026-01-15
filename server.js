const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
// 1. PROJECT NUMBER (Numeric)
const PROJECT_ID = "28062079972"; 
const LOCATION = "global"; 

// 2. ENGINE ID (The "Manager")
const ENGINE_ID = "claretycoreai_1767340856472"; 
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

        // 1. PERSONALITY LAYER
        const lowerQ = (userQuery || "").toLowerCase();
        if (lowerQ.match(/^(hi|hello|hey|greetings)/)) {
            return res.json({ answer: "Hello! I am connected to the Clarety Knowledge Database.", links: [] });
        }

        // 2. CONNECT TO GOOGLE
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        // Safety fix for private key newlines
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
        }
        const client = new SearchServiceClient({ credentials });

        // --- PATH CONSTRUCTION (The Golden Path) ---
        // 1. Use the Engine Path (No 'collections' folder)
        // 2. Use 'default_serving_config' (The one that didn't crash in your logs)
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/engines/${ENGINE_ID}/servingConfigs/default_serving_config`;

        console.log("Connecting to:", servingConfig); 

        // --- BARE MINIMUM REQUEST ---
        // Removed snippetSpec to prevent any chance of "Invalid Argument".
        // If this works, we can add snippets back later.
        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        // 3. ANSWER LOGIC
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
