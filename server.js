const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: "*",
  })
);

app.get("/", (req, res) => {
  res.send("Backend is running");
});

/**
 * STEP 1: CHAT ENDPOINT PROBE
 * This endpoint does ONE thing:
 *  - Logs when it is hit
 *  - Returns a simple JSON response
 * No Google, no Gemini, no Discovery Engine.
 */
app.post("/chat", async (req, res) => {
  console.log("=================================");
  console.log("CHAT ENDPOINT HIT");
  console.log("Time:", new Date().toISOString());
  console.log("Body:", req.body);
  console.log("=================================");

  return res.json({
    answer: "Chat endpoint reached successfully",
    debug: "No AI logic executed yet",
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
