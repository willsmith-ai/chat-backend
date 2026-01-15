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

// --- HELPER: UNWRAP GOOGLE DATA ---
// This function digs through the messy "fields" and "stringValue" layers
// to find the actual text, no matter how Google sends it.
function unwrap(value) {
    if (!value) return null;
    if (value.stringValue) return value.stringValue;
    if (value.structValue) return unwrapStruct(value.structValue);
    if (value.listValue) return value.listValue.values.map(unwrap);
    return value; // Return as-is if it's already simple
}

function unwrapStruct(struct) {
    if (!struct || !struct.fields) return {};
    const result = {};
    for (const key in struct.fields) {
        result[key] = unwrap(struct.fields[key]);
    }
    return result;
}
// ----------------------------------

app.get("/", (req, res) => {
    res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("User asked:", userQuery);

        // --- 1. GREETINGS ---
        const greetings = ["hi", "hello", "hey", "greetings", "good morning", "good afternoon"];
        const cleanQuery = userQuery.toLowerCase().trim().replace(/[!.,?]/g, "");

        if (greetings.includes(cleanQuery)) {
            return res.json({ 
                answer: "Hi there! I'm Clarety AI. I can answer questions about our community documents. How can I help you today?", 
                links: [] 
            });
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
                summarySpec: {
                    summaryResultCount: 5,
                    includeCitations: true,
                    ignoreAdversarialQuery: true 
                },
                snippetSpec: {
                    returnSnippet: true 
                }
            }
        };

        // We add { autoPaginate: false } to stop the logs from complaining
        const [response] = await client.search(request, { autoPaginate: false });
        
        // --- 3. SMART ANSWER LOGIC ---
        let answer = "I checked my documents, but I couldn't find specific information about that. Could you try rephrasing your question?";
        
        // A. Check for AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // B. Fallback: Dig through results using the UNWRAPPER
        else if (response.results && response.results.length > 0) {
             
             let foundGoodSnippet = false;

             for (const result of response.results) {
                 // Use our helper to clean the data!
                 const data = unwrapStruct(result.document.derivedStructData);
                 
                 // Now 'data' is clean! We can use data.snippets, data.title, etc.

                 // Check Snippets
                 if (data.snippets && Array.isArray(data.snippets) && data.snippets.length > 0) {
                     let snippetText = data.snippets[0].snippet;
                     
                     // Filter out the "No snippet" junk
                     if (snippetText && !snippetText.includes("No snippet is available")) {
                         // Clean up HTML tags
                         answer = "I found this in the documents: " + snippetText.replace(/<[^>]*>/g, "");
                         foundGoodSnippet = true;
                         break;
                     }
                 }
             }

             // Loop 2: If no text found, use the Title
             if (!foundGoodSnippet) {
                 // Unwrap the first document to get the title
                 const firstData = unwrapStruct(response.results[0].document.derivedStructData);
                 if (firstData.title) {
                     answer = `I found a document named "${firstData.title}" that seems relevant. You can open it below to read more.`;
                 }
             }
        }

        // --- 4. LINKS ---
        const links = [];
        if (response.results) {
            response.results.forEach(result => {
                const data = unwrapStruct(result.document.derivedStructData);
                if (data.link) {
                    links.push({ title: data.title || "Link", url: data.link });
                }
            });
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "I'm having a little trouble connecting to my brain right now. Please try again in a moment.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
