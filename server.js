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
        // If the user just says hello, we answer immediately without bothering Google.
        const greetings = ["hi", "hello", "hey", "greetings", "good morning", "good afternoon"];
        const lowerQuery = userQuery.toLowerCase().trim().replace(/[!.]/g, ""); // remove punctuation

        if (greetings.includes(lowerQuery)) {
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
            pageSize: 3,
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
        // Default "Human" failure message
        let answer = "I checked my documents, but I couldn't find specific information about that. Could you try rephrasing your question?";
        
        // A. Try to get the fancy AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // B. Fallback: If no summary, grab the text snippet from the first result
        else if (response.results && response.results.length > 0) {
             const firstDoc = response.results[0];
             if (firstDoc.document && firstDoc.document.derivedStructData) {
                 const data = firstDoc.document.derivedStructData;
                 // Try to grab a snippet
                 if (data.snippets && data.snippets.length > 0) {
                     answer = "I didn't generate a full summary, but here is what I found: " + data.snippets[0].snippet;
                 } else if (data.extractive_answers && data.extractive_answers.length > 0) {
                      answer = "Result: " + data.extractive_answers[0].content;
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
