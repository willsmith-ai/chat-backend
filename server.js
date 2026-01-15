const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
const PROJECT_ID = "groovy-root-483105-n9"; 
const LOCATION = "global"; 
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
        const lowerQ = userQuery.toLowerCase();
        if (lowerQ.match(/^(hi|hello|hey|greetings)/)) {
            return res.json({ answer: "Hello! I am connected to the Clarety Knowledge Database. Ask me about Contact Change Logs, Letter Exports, or Templates.", links: [] });
        }

        // 2. CONNECT TO GOOGLE
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });

        // --- PATH CONSTRUCTION (The ChatGPT Fix) ---
        // We talk strictly to the Engine. The Engine knows where the data is.
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/engines/${ENGINE_ID}/servingConfigs/default_search`;

        console.log("Connecting to:", servingConfig); 

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                snippetSpec: { returnSnippet: true },
                // We keep summarySpec because the Engine is smart enough to handle it
                summarySpec: { summaryResultCount: 5, ignoreAdversarialQuery: true }
            }
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
             let bestSnippet = "";

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

                 // Snippet
                 if (!answer && !bestSnippet && data.snippets && data.snippets.length > 0) {
                     let text = data.snippets[0].snippet;
                     if (text && !text.includes("No snippet is available")) {
                         bestSnippet = text.replace(/<[^>]*>/g, "");
                     }
                 }
             }

             // Final Answer Construction
             if (!answer) {
                 if (bestSnippet) {
                     answer = `Here is what I found:\n"${bestSnippet}"`;
                 } else if (foundTitles.length > 0) {
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
        res.status(500).json({ answer: "I'm having trouble connecting. Please try again.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
