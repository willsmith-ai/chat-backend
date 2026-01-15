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
const APP_ID = "claretycoreai_1767340856472"; 
const LOCATION = "global"; 
// ---------------------

// --- HELPER: DATA CLEANER (The "Unwrapper") ---
// Google sends data wrapped in weird objects. This fixes it.
function unwrap(value) {
    if (!value) return null;
    if (value.stringValue) return value.stringValue;
    if (value.structValue) return unwrapStruct(value.structValue);
    if (value.listValue) return value.listValue.values.map(unwrap);
    return value; 
}
function unwrapStruct(struct) {
    if (!struct || !struct.fields) return {};
    const result = {};
    for (const key in struct.fields) {
        result[key] = unwrap(struct.fields[key]);
    }
    return result;
}
// ----------------------------------------------

app.get("/", (req, res) => {
    res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("User asked:", userQuery);

        // --- 1. PERSONALITY LAYER ---
        const lowerQ = userQuery.toLowerCase();
        
        if (lowerQ.includes("how are you")) {
            return res.json({ answer: "I'm functioning perfectly and ready to help! Thanks for asking.", links: [] });
        }
        if (lowerQ.includes("topics") || lowerQ.includes("what do you know")) {
            return res.json({ answer: "I have access to the Clarety Knowledge Database. I can help with Contact Change Logs, Letter Exports, Campaign Pages, and Email Templates.", links: [] });
        }
        if (lowerQ.match(/^(hi|hello|hey|greetings)/)) {
            return res.json({ answer: "Hello! Ask me anything about the Clarety community documents.", links: [] });
        }

        // --- 2. GOOGLE SEARCH ---
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });

        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${APP_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                summarySpec: { summaryResultCount: 5, ignoreAdversarialQuery: true },
                snippetSpec: { returnSnippet: true }
            }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        // --- 3. SMART ANSWER LOGIC ---
        let answer = "I found some documents that might help, but I couldn't find a specific answer inside them. Please check the links below.";
        
        // Strategy A: AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // Strategy B: Search for ANY valid text snippet
        else if (response.results && response.results.length > 0) {
             let foundText = false;

             for (const result of response.results) {
                 // CLEAN THE DATA
                 const data = unwrapStruct(result.document.derivedStructData);
                 
                 // Look for snippets
                 if (data.snippets && data.snippets.length > 0) {
                     let text = data.snippets[0].snippet;
                     if (text && !text.includes("No snippet is available")) {
                         // Clean HTML tags
                         answer = "Here is a relevant excerpt: " + text.replace(/<[^>]*>/g, "");
                         foundText = true;
                         break;
                     }
                 }
             }
             
             // Strategy C: If no text found, use the Title of the first doc
             if (!foundText) {
                 const firstData = unwrapStruct(response.results[0].document.derivedStructData);
                 if (firstData.title) {
                     answer = `I couldn't read the text preview, but I found a document named "${firstData.title}" that seems to answer your question.`;
                 }
             }
        }

        // --- 4. FORMAT LINKS ---
        const links = [];
        if (response.results) {
            response.results.forEach(result => {
                const data = unwrapStruct(result.document.derivedStructData);
                if (data.link) {
                    links.push({ title: data.title || "Document", url: data.link });
                }
            });
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "I'm having a little trouble connecting. Please try again.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
