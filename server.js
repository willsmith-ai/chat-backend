const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());

// Enable CORS
app.use(cors({
    origin: "*" 
}));

// --- CONFIGURATION ---
const PROJECT_ID = "groovy-root-483105-n9"; 
const APP_ID = "claretycoreai_1767340856472"; 
const LOCATION = "global"; 
// ---------------------

app.get("/", (req, res) => {
    res.send("Backend is running!");
});

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("User asked:", userQuery);

        // --- 1. HUMAN LAYER: GREETINGS ---
        const greetings = ["hi", "hello", "hey", "greetings", "good morning", "good afternoon"];
        // Clean up the input (remove punctuation, make lowercase)
        const cleanQuery = userQuery.toLowerCase().trim().replace(/[!.,?]/g, "");

        if (greetings.includes(cleanQuery)) {
            return res.json({ 
                answer: "Hi there! I'm Clarety AI. I can answer questions about our community documents. How can I help you today?", 
                links: [] 
            });
        }

        // --- 2. CONNECT TO GOOGLE ---
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });

        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${APP_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5, // Fetch a few more to increase chances of finding a good snippet
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

        const [response] = await client.search(request);
        
        // --- 3. SMART ANSWER LOGIC ---
        let answer = "I checked my documents, but I couldn't find specific information about that. Could you try rephrasing your question?";
        
        // A. Try to get the fancy AI Summary first
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // B. Fallback: Search for the first *valid* text snippet
        else if (response.results && response.results.length > 0) {
             
             for (const result of response.results) {
                 const data = result.document.derivedStructData;
                 if (!data) continue;

                 // Check for Extractive Answers (Best quality)
                 if (data.extractive_answers && data.extractive_answers.length > 0) {
                     answer = data.extractive_answers[0].content;
                     break; // Found a good one, stop looking
                 }
                 
                 // Check for Snippets (Standard quality)
                 if (data.snippets && data.snippets.length > 0) {
                     let snippetText = data.snippets[0].snippet;
                     
                     // CRITICAL FIX: Ignore useless "No snippet" messages
                     if (snippetText && !snippetText.includes("No snippet is available")) {
                         // Clean up HTML tags (remove <b>, </b>, etc.)
                         answer = "I found this in the documents: " + snippetText.replace(/<[^>]*>/g, "");
                         break; // Found a good one, stop looking
                     }
                 }
             }
        }

        // C. Extract Links
        const links = [];
        if (response.results) {
            response.results.forEach(result => {
                const data = result.document.derivedStructData;
                if (data && data.link) {
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
