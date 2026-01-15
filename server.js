const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
// We are using the PROJECT NUMBER from your logs (Safe Mode)
const PROJECT_ID = "28062079972"; 
const LOCATION = "global"; 
// We are using the APP ID (The Brain)
const APP_ID = "claretycoreai_1767340856472"; 
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
            return res.json({ answer: "Hello! I am connected to the Clarety Knowledge Database. Try searching for 'Contact Change Log'.", links: [] });
        }

        // 2. CONNECT TO GOOGLE
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });

        // We use the ENGINES path (The Brain)
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${APP_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                summarySpec: { 
                    summaryResultCount: 5, 
                    ignoreAdversarialQuery: true,
                    includeCitations: true
                },
                snippetSpec: { returnSnippet: true }
            }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);
        // DEBUG: Print the raw response to see if Google is sending warnings
        console.log(JSON.stringify(response, null, 2));

        // 3. ANSWER LOGIC
        let answer = "";
        
        // Priority A: AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // Priority B: Snippets
        else if (response.results && response.results.length > 0) {
             for (const result of response.results) {
                 const data = smartUnwrap(result.document.derivedStructData);
                 
                 // Look for text snippet
                 if (data.snippets && data.snippets.length > 0) {
                     let text = data.snippets[0].snippet;
                     if (text && !text.includes("No snippet is available")) {
                         answer = "Here is a relevant excerpt: " + text.replace(/<[^>]*>/g, "");
                         break;
                     }
                 }
             }
             
             // Priority C: Document Titles
             if (!answer) {
                 const titles = response.results
                    .map(r => smartUnwrap(r.document.derivedStructData).title)
                    .filter(t => t)
                    .slice(0, 3);
                 
                 if (titles.length > 0) {
                     answer = `I found these documents matching your query:\n• ${titles.join("\n• ")}\n\nPlease download them below.`;
                 }
             }
        } 
        
        if (!answer) {
            answer = "I searched the database, but couldn't find a direct match. Try searching for a simpler term like 'Letter' or 'Template'.";
        }

        // 4. LINKS
        const links = [];
        if (response.results) {
            response.results.forEach(result => {
                const data = smartUnwrap(result.document.derivedStructData);
                if (data.link) {
                    links.push({ 
                        title: data.title || "Download Document", 
                        url: fixLink(data.link) 
                    });
                }
            });
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
