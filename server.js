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

// --- HELPER: SMART UNWRAPPER ---
// Handles both "Messy" (Proto) and "Clean" (JSON) data from Google
function smartUnwrap(data) {
    if (!data) return null;
    
    // Case 1: It's the messy "fields" format
    if (data.fields) {
        const result = {};
        for (const key in data.fields) {
            result[key] = unwrapValue(data.fields[key]);
        }
        return result;
    }
    
    // Case 2: It's already clean! Return as-is.
    return data;
}

function unwrapValue(value) {
    if (!value) return null;
    if (value.stringValue) return value.stringValue;
    if (value.structValue) return smartUnwrap(value.structValue);
    if (value.listValue) return value.listValue.values.map(unwrapValue);
    return value; 
}

// --- HELPER: LINK FIXER ---
// Converts "gs://" links to clickable "https://" links
function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        // Remove "gs://" and prepend the public storage URL
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}
// ------------------------------

app.get("/", (req, res) => {
    res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("User asked:", userQuery);

        // --- 1. PERSONALITY LAYER ---
        const lowerQ = userQuery.toLowerCase();
        
        // Custom Greetings
        if (lowerQ.match(/^(hi|hello|hey|greetings)/)) {
            return res.json({ answer: "Hello! Ask me anything about the Clarety community documents.", links: [] });
        }
        // Custom Help Topics
        if (lowerQ.includes("topics") || lowerQ.includes("what do you know")) {
            return res.json({ answer: "I can help with Contact Change Logs, Letter Exports, Campaign Pages, and Email Templates. What do you need?", links: [] });
        }
        // Custom Status Check
        if (lowerQ.includes("how are you")) {
            return res.json({ answer: "I'm functioning perfectly and connected to the Knowledge Database.", links: [] });
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
        let answer = "";
        
        // Strategy A: AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // Strategy B: Search for ANY valid text snippet
        else if (response.results && response.results.length > 0) {
             
             // Try to find a good snippet
             for (const result of response.results) {
                 const data = smartUnwrap(result.document.derivedStructData);
                 
                 if (data.snippets && data.snippets.length > 0) {
                     let text = data.snippets[0].snippet;
                     if (text && !text.includes("No snippet is available")) {
                         answer = "Here is a relevant excerpt: " + text.replace(/<[^>]*>/g, "");
                         break;
                     }
                 }
             }
             
             // Strategy C: If STILL no text, list the Document Titles
             if (!answer) {
                 const titles = response.results
                    .map(r => smartUnwrap(r.document.derivedStructData).title)
                    .filter(t => t) // remove empty titles
                    .slice(0, 3);   // take top 3
                 
                 if (titles.length > 0) {
                     answer = "I found these documents that seem relevant:\n• " + titles.join("\n• ");
                 } else {
                     answer = "I found some documents, but I couldn't read their titles or content. Please check the links below.";
                 }
             }
        } else {
            answer = "I couldn't find any documents matching that question.";
        }

        // --- 4. FORMAT LINKS ---
        const links = [];
        if (response.results) {
            response.results.forEach(result => {
                const data = smartUnwrap(result.document.derivedStructData);
                if (data.link) {
                    links.push({ 
                        title: data.title || "Download Document", 
                        url: fixLink(data.link) // Convert gs:// to https://
                    });
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
