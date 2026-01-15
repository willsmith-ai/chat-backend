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
        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        const client = new SearchServiceClient({ credentials });
        const userQuery = req.body.query;

        console.log("Searching for:", userQuery);

        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${APP_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 3,
            contentSearchSpec: {
                summarySpec: {
                    summaryResultCount: 5,
                    includeCitations: true,
                    ignoreAdversarialQuery: true // helps with "safe" queries
                },
                snippetSpec: {
                    returnSnippet: true // Ensure we get text snippets
                }
            }
        };

        const [response] = await client.search(request);
        
        // LOGGING: This will print the raw Google response to your Render logs.
        // If it still fails, checking this log will tell us WHY.
        console.log("Google Response:", JSON.stringify(response, null, 2));

        // --- SMART ANSWER LOGIC ---
        let answer = "I couldn't find an answer in the documents.";
        
        // 1. Try to get the fancy AI Summary
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        } 
        // 2. Fallback: If no summary, grab the text snippet from the first result
        else if (response.results && response.results.length > 0) {
             const firstDoc = response.results[0];
             // Try to find a text snippet in the document data
             if (firstDoc.document && firstDoc.document.derivedStructData) {
                 const data = firstDoc.document.derivedStructData;
                 if (data.snippets && data.snippets.length > 0) {
                     answer = "I didn't generate a summary, but here is what I found: " + data.snippets[0].snippet;
                 } else if (data.extractive_answers && data.extractive_answers.length > 0) {
                      answer = "Result: " + data.extractive_answers[0].content;
                 }
             }
        }

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
        res.status(500).json({ answer: "Error connecting to AI.", error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
