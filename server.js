const express = require("express");
const cors = require("cors");
const { SearchServiceClient } = require("@google-cloud/discoveryengine").v1beta;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// --- CONFIGURATION (Confimed by your Screenshots) ---
const PROJECT_ID = "groovy-root-483105-n9"; 
const LOCATION = "global"; 
const COLLECTION_ID = "default_collection";
const ENGINE_ID = "claretycoreai_1767340856472"; 
const SERVING_CONFIG_ID = "default_search";
// ----------------------------------------------------

function fixLink(link) {
    if (!link) return "#";
    if (link.startsWith("gs://")) {
        return "https://storage.googleapis.com/" + link.substring(5);
    }
    return link;
}

app.get("/", (req, res) => res.send("Backend is running!"));

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        if (!process.env.GOOGLE_JSON_KEY) {
            throw new Error("Missing Google Credentials");
        }
        const credentials = JSON.parse(process.env.GOOGLE_JSON_KEY);
        if (credentials.private_key) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
        }
        const client = new SearchServiceClient({ credentials });

        // --- PATH: ENGINE PATH (Confirmed by your /configs test) ---
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}`;
        console.log("Connecting to:", servingConfig); 

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 5,
            // --- THE FIX: Force Extractive Segments & Summaries ---
            // This mimics the "Question Answering" behavior of the Preview window
            contentSearchSpec: { 
                snippetSpec: { returnSnippet: true },
                extractiveContentSpec: { maxExtractiveAnswerCount: 1 }, // "Find me the exact answer text"
                summarySpec: { 
                    summaryResultCount: 5, 
                    includeCitations: true,
                    ignoreAdversarialQuery: true 
                }
            },
            queryExpansionSpec: { condition: "AUTO" }, // Helps matches "log" to "logs"
            spellCorrectionSpec: { mode: "AUTO" }
        };

        const [response] = await client.search(request, { autoPaginate: false });
        
        console.log(`Found ${response.results ? response.results.length : 0} results.`);

        let answer = "";
        const links = [];

        // 1. Check for AI Summary (Best Match)
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
        }

        // 2. Check for Extractive Answers (Direct Text from Doc)
        if (!answer && response.results) {
            for (const result of response.results) {
                const data = result.document.derivedStructData;
                // Check if Google pulled out a specific text segment
                if (data.extractive_answers && data.extractive_answers.length > 0) {
                    answer = data.extractive_answers[0].content;
                    break;
                }
            }
        }

        // 3. Process Links
        if (response.results && response.results.length > 0) {
             const foundTitles = [];
             for (const result of response.results) {
                 const data = result.document.derivedStructData;
                 
                 // Handle Google's varying JSON structure
                 const fields = data.fields ? unwrapFields(data.fields) : data;

                 if (fields.link) {
                     links.push({ 
                         title: fields.title || "View Document", 
                         url: fixLink(fields.link) 
                     });
                 }
                 if (fields.title) foundTitles.push(fields.title);
             }

             if (!answer) {
                 if (foundTitles.length > 0) {
                     answer = `I found these documents matching your query:\n• ${foundTitles.join("\n• ")}`;
                 } else {
                     answer = "I found relevant files. Check the links below.";
                 }
             }
        } 
        
        if (!answer) {
            answer = "I searched the database but couldn't find a direct match. Try searching for a specific filename.";
        }

        res.json({ answer, links });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ answer: "Connection error.", error: error.message });
    }
});

// Helper to unwrap fields cleanly
function unwrapFields(fields) {
    const result = {};
    for (const key in fields) {
        const val = fields[key];
        result[key] = val.stringValue || val;
    }
    return result;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
