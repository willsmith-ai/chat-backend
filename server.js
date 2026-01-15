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
const DATA_STORE_ID = "claretycommunityai_1767529726880"; 
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

        // --- THE FIX IS HERE ---
        // We changed 'dataStores' to 'engines' because you are using a Search App.
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${DATA_STORE_ID}/servingConfigs/default_search`;

        const request = {
            servingConfig: servingConfig,
            query: userQuery,
            pageSize: 3,
            contentSearchSpec: {
                summarySpec: {
                    summaryResultCount: 5,
                    includeCitations: true
                }
            }
        };

        const [response] = await client.search(request);

        let answer = "I couldn't find an answer in the documents.";
        if (response.summary && response.summary.summaryText) {
            answer = response.summary.summaryText;
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
