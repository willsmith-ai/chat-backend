const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// --- CONFIGURATION ---
const PROJECT_ID = "groovy-root-483105-n9"; 
const LOCATION = "global"; 
const COLLECTION_ID = "default_collection";
// We use the Engine path because the Preview uses it
const ENGINE_ID = "claretycoreai_1767340856472"; 
const SERVING_CONFIG_ID = "default_search";
// ---------------------

app.get("/", (req, res) => res.send("Raw Backend is Live!"));

app.post("/chat", async (req, res) => {
    try {
        const userQuery = req.body.query;
        console.log("------------------------------------------------");
        console.log("User asked:", userQuery);

        // 1. Get a fresh Access Token (The raw key to the door)
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            credentials: JSON.parse(process.env.GOOGLE_JSON_KEY)
        });
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        // 2. Build the Raw URL
        const url = `https://discoveryengine.googleapis.com/v1beta/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/servingConfigs/${SERVING_CONFIG_ID}:search`;

        console.log("Hitting URL:", url);

        // 3. Send the Raw Request (Mimicking the Preview Window)
        const payload = {
            query: userQuery,
            pageSize: 5,
            contentSearchSpec: {
                snippetSpec: { returnSnippet: true },
                summarySpec: { 
                    summaryResultCount: 5,
                    includeCitations: true,
                    ignoreAdversarialQuery: true
                }
            },
            queryExpansionSpec: { condition: "AUTO" },
            spellCorrectionSpec: { mode: "AUTO" }
        };

        const response = await axios.post(url, payload, {
            headers: {
                "Authorization": `Bearer ${accessToken.token}`,
                "Content-Type": "application/json"
            }
        });

        // 4. Handle the Raw Response
        const data = response.data;
        console.log(`Google responded with: ${data.results ? data.results.length : 0} results.`);

        let answer = "";
        const links = [];

        // Extract Summary
        if (data.summary && data.summary.summaryText) {
            answer = data.summary.summaryText;
        }

        // Extract Documents
        if (data.results) {
            data.results.forEach(item => {
                const docData = item.document.derivedStructData;
                const title = docData.title || docData.fields?.title?.stringValue || "Document";
                let link = docData.link || docData.fields?.link?.stringValue || "";
                
                if (link.startsWith("gs://")) {
                    link = "https://storage.googleapis.com/" + link.substring(5);
                }

                if (link) {
                    links.push({ title, url: link });
                }
            });
        }

        if (!answer) {
             if (links.length > 0) {
                 answer = "I found these relevant documents:";
             } else {
                 answer = "I couldn't find a direct answer in the documents.";
             }
        }

        res.json({ answer, links });

    } catch (error) {
        // Detailed Error Logging
        if (error.response) {
            console.error("Google API Error:", JSON.stringify(error.response.data, null, 2));
            res.status(500).json({ answer: "Google API Error", details: error.response.data });
        } else {
            console.error("Server Error:", error.message);
            res.status(500).json({ answer: "Server connection failed." });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
