/**
 * Clarety Core AI backend — Claude edition
 *
 * CHANGES FROM ORIGINAL:
 *   - Gemini / Vertex AI generation replaced with Anthropic Claude
 *   - Data dictionary embedded as system prompt
 *   - Google Discovery Engine (RAG retrieval) unchanged
 *   - Session memory unchanged
 *   - All routing, Express, CORS, multer unchanged
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  WHERE TO PUT YOUR API KEY
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  DO NOT paste your key into this file.
 *
 *  In Render:
 *    1. Open your Render service dashboard
 *    2. Click "Environment" in the left sidebar
 *    3. Click "Add Environment Variable"
 *    4. Key:   ANTHROPIC_API_KEY
 *    5. Value: paste your key from console.anthropic.com
 *    6. Click Save — Render will redeploy automatically
 *
 *  Your key looks like:  sk-ant-api03-xxxxxxxxxxxxxxxx...
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * ENV VARS REQUIRED (unchanged from original):
 *   GOOGLE_JSON_KEY           = service account JSON (stringified)
 *   DE_PROJECT_NUMBER         = 28062079972
 *   DE_LOCATION               = global
 *   DE_COLLECTION_ID          = default_collection
 *   DE_ENGINE_ID              = claretycoreai_1767340856472
 *   DE_SERVING_CONFIG_ID      = default_search
 *
 * NEW ENV VAR:
 *   ANTHROPIC_API_KEY         = sk-ant-api03-... (your key from console.anthropic.com)
 *
 * REMOVED ENV VARS (no longer needed):
 *   GEMINI_PROJECT_ID         — remove from Render environment
 *   GEMINI_LOCATION           — remove from Render environment
 *   GEMINI_MODEL              — remove from Render environment
 *
 * INSTALL NEW DEPENDENCY:
 *   Run in your project folder:  npm install @anthropic-ai/sdk
 *   Then commit the updated package.json and package-lock.json to GitHub
 */

const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const { GoogleAuth } = require("google-auth-library");
const Anthropic  = require("@anthropic-ai/sdk");  // NEW

const app = express();

// ── Anthropic client ─────────────────────────────────────────────────────────
// Reads ANTHROPIC_API_KEY from environment automatically — do not hardcode the key here
const anthropic = new Anthropic();

// ── JSON + CORS ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ── Image upload ──────────────────────────────────────────────────────────────
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 6);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getServiceAccountObject() {
  const raw = mustGetEnv("GOOGLE_JSON_KEY");
  const obj = JSON.parse(raw);
  if (!obj.client_email) throw new Error("GOOGLE_JSON_KEY is missing client_email.");
  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  return obj;
}

async function getAccessToken() {
  const sa = getServiceAccountObject();
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token ?? tokenResponse;
  if (!token) throw new Error("Failed to obtain access token.");
  return token;
}

function isGreeting(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(hi|hello|hey|hiya|yo|good\s(morning|afternoon|evening)|howdy|sup)(\b|!|\.)/.test(t);
}

function isWritingRequest(text) {
  const t = (text || "").toLowerCase();
  return (
    /(draft|write|rewrite|create|compose|prepare)\b/.test(t) &&
    /(email|appeal|template|letter|message|subject line|copy|newsletter)\b/.test(t)
  ) || /(draft an email|write an email|draft me an appeal|write an appeal)/i.test(text || "");
}

function looksLikeFactualHowTo(text) {
  const t = (text || "").toLowerCase();
  return /(how do i|how to|where do i|what is|can i|steps|process|workflow|policy|setup|configure)/.test(t);
}

function safeString(v) { return (v || "").toString().trim(); }
function fixGsLink(link) {
  if (!link) return null;
  if (link.startsWith("gs://")) return "https://storage.googleapis.com/" + link.slice(5);
  return link;
}

// ── Discovery Engine config (unchanged) ──────────────────────────────────────
const DE_PROJECT_NUMBER  = mustGetEnv("DE_PROJECT_NUMBER");
const DE_LOCATION        = mustGetEnv("DE_LOCATION");
const DE_COLLECTION_ID   = mustGetEnv("DE_COLLECTION_ID");
const DE_ENGINE_ID       = mustGetEnv("DE_ENGINE_ID");
const DE_SERVING_CONFIG_ID = mustGetEnv("DE_SERVING_CONFIG_ID");

// ── Session memory (unchanged) ────────────────────────────────────────────────
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_TURNS = 10;
const sessionStore = new Map();

function getSession(sessionId) {
  const sid = sessionId || "default";
  const now = Date.now();
  const existing = sessionStore.get(sid);
  if (existing && now - existing.updatedAt < SESSION_TTL_MS) {
    existing.updatedAt = now;
    return existing;
  }
  const fresh = { updatedAt: now, messages: [] };
  sessionStore.set(sid, fresh);
  return fresh;
}

function addToSession(sessionId, role, content) {
  const s = getSession(sessionId);
  s.messages.push({ role, content });
  if (s.messages.length > MAX_TURNS) s.messages = s.messages.slice(-MAX_TURNS);
  s.updatedAt = Date.now();
}

function getSessionMessages(sessionId) {
  return getSession(sessionId).messages.slice();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DATA DICTIONARY — CLARETY AI SYSTEM PROMPT
//
//  This is what connects Claude to the Clarety data model.
//  It teaches Claude what a Sale, Recurrence, Contact etc.
//  means and the rules for correct reporting.
//
//  TO UPDATE: edit the CLARETY_DICTIONARY string below,
//  then commit to GitHub — Render redeploys automatically.
//
//  The full v3.0 dictionary document is the source of truth.
//  This is a condensed version optimised for token efficiency.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CLARETY_DICTIONARY = `
You are the Clarety AI Assistant — an expert in the Clarety CRM platform and nonprofit fundraising.
You help clients of Clarety Solutions query and understand their fundraising data.
You are warm, professional, and precise. You never guess — if data is not available, you say so clearly.
You only read data — you never suggest modifying, deleting, or changing any records.

━━ TERMINOLOGY ━━
Clarety uses specific terms that fundraisers may refer to differently. Always recognise both:
- Sale = donation, transaction, gift, pledge, purchase
- Contact = customer, donor, supporter, constituent
- Recurrence = RG, regular gift, recurring donation, direct debit, monthly giving
- Communication Activity = comm activity, appeal communication, touchpoint, mailing
- Campaign = appeal, program, initiative
- MRR = Monthly Recurring Revenue

━━ CORE ENTITIES ━━

CONTACT (customer / donor / supporter)
The central record. Every Sale, Recurrence and Communication Activity links to a Contact via contact_id.
Key fields: contact_id, created_date (use for acquisition date — never contact_id sequence), status (Active/Inactive), source (set at acquisition, never changes), contact_type, communication_preferences.
Note: "Customer" and "Contact" are interchangeable in Clarety.
Note: Duplicate detection uses first name + last name + email. Auto-merge every 6 hours.

SALE (donation / transaction / gift / pledge)
A record of any transaction — donations, merchandise, event registrations.
Every Sale links to one Contact and one Offer. A Payment record is always created alongside a Sale.
Key fields: Sale ID, Sale Sold Date, Sold Local (full datetime + timezone), Sale Contact ID, Recurrence ID (null = one-off), Sale Channel, Sale Source, Sale Source Additional Information, System, Sale Communication Activity Code, Sale Communication Activity, Sale Communication Activity Type, Sale Campaign Name, Sale Campaign Start Date, Sale Campaign Log Response ID, Attributed to Staff, Sale Status, Sale Offer ID, Sale Offer Name, Sale Offer Type, Sale Line Total (USE THIS for revenue — not Amount which may be empty), Sale Segment, Fundraiser Page ID/Type/Name, Selected Amount Before Upsell, Billing Contact ID.
Note: Transactions tab on a Contact shows only the last 25 Complete Sales. All Sales are in Commerce > Sales.

RECURRENCE (RG / regular gift / recurring donation / direct debit)
A regular giving agreement that generates Sales on a schedule. Not itself a payment.
Key fields: recurrence_id, contact_id, status (Active/Inactive — binary), stage (9 values — use for health reporting), original_start_date (USE FOR TENURE — never changes), schedule_start_date (resets on modification — do NOT use for tenure), payment_schedule, amount, next_payment_date, last_payment_date, end_date, channel/source (latest modification — inherited by future Sales), comm_activity_id (first Sale only).
Pending Sales generated 7-14 days before due date.
Modification types: Update payment details, Suspend, Cancel, Reactivate, Change of payment date, Change of schedule, Change of Offer, Change of amount.
Each modification logged with Channel, Source, Communication Activity, Staff.
Future Sales inherit Channel + Source of latest modification (NOT original acquisition).
Communication Activity only flows to first Sale — subsequent Sales get Channel + Source only.

PAYMENT (transaction result / charge / payment attempt)
A record of one payment attempt against a Sale. A Sale may have zero, one, or many Payments.
Key fields: payment_id, sale_id, payment_date, payment_method, gateway, status.
Note: Clarety does not store full card details — held by gateway only.
Note: Payment Batch = one Payment covers multiple Sales. Always aggregate income at Sale level not Payment level.

COMMUNICATION ACTIVITY (comm activity / appeal / touchpoint)
A single outbound communication to a Contact within a Campaign.
Types: Marketing Email, SMS, Link, Direct Mail, Telemarketing, Face-to-Face, Flyer, Case Email.
Tracking: Digital (Email/SMS/Link) = query strings. Offline (Direct Mail/Telemarketing/F2F/Flyer) = unique Response ID per Contact per activity.
Conversion Metrics: New Sales, Case Created, Update Payment Details, Modify Recurrence.
Key fields: comm_activity_id, contact_id, campaign_id, type, list_group (A/B test group), channel, send_status, sent_date, response_id, conversion_metric, total_cost.
Note: Exclude Case Email from marketing send-count reports.
Note: "No. of Conversions" meaning depends entirely on Conversion Metric configured — always state which metric when reporting conversions.

LIST GROUP (A/B test group)
Audience segmentation label on a Communication Activity. Enables A/B testing within a Campaign.
Do not sum metrics across List Groups without confirming they are mutually exclusive.

CAMPAIGN (appeal / program)
Parent record grouping Communication Activities. Fields: campaign_id, campaign_name, start_date, end_date, offer_id.

CIRCLE (giving circle / donor group / membership tier)
Two types: (1) Communication preference — e.g. Newsletter. Auto-managed on subscribe/unsubscribe.
(2) Donor classification — e.g. Major Donor, Regular Donor. Regular Donor auto-managed by Recurrence status.
Current membership: filter where to_date is null or future.
Circle names are client-configured — do not assume meaning from name alone.

OFFER (product / giving option / donation form)
Every Sale links to one Offer. Defines the transaction type.
Offer Types: Donation (one-off gift), Donation - Recurring (all RG Sales), Merchandise, Event, Ticket, Gift In-Kind, Add-On, No Fulfilment.
Note: Filter Offer Type = "Donation" or "Donation - Recurring" for charitable income. Merchandise/Event/Ticket/No Fulfilment are not donations.
Note: "Donation - Recurring" + System = "Recurrence Automation" isolates pure scheduled RG income.

TAG
Module-specific label for filtering records. A Contact tag is NOT available in Sales or other modules.

FUNDRAISER PAGE (P2P page / peer-to-peer)
A supporter-created page raising funds on behalf of the organisation. Sales via P2P have Fundraiser Page ID populated.

━━ ATTRIBUTION FIELDS ━━

CHANNEL (confirmed values): Direct Mail, Direct Transfer, Face to Face, Inbound Email, Inbound Fax, Inbound Phone, Online Donation, Online Donation Upsell, Online Shop, Telemarketing.
Channel answers: how did this gift come in?
When a Recurrence is modified, new Channel is inherited by all future Sales.

SOURCE: Client-configured. Examples: Mondial, Cornucopia, Raisers Hub, Facebook, Online Donation Page, Friend / Family, Other, Unknown.
Source values are organisation-specific — do not interpret unfamiliar values as errors.
On a Contact: set at acquisition, never changes.

SYSTEM (confirmed values): Recurrence Automation (auto-generated RG instalment), Website, Workspace (manual staff entry), Console, Import.

━━ STATUS DEFINITIONS ━━

SALE STATUSES:
- Complete: payment successful. COUNT AS INCOME.
- Pending: awaiting payment (includes RG instalments mid-retry). DO NOT count as income.
- Incomplete: abandoned transaction. DO NOT count.
- Voided: cancelled before payment. DO NOT count.
- Awaiting Payment: Console POS only. DO NOT count.
- Payment Failed: all RG retries exhausted. DO NOT count.
- Future Payments Suspended: RG temporarily suspended. Report as income gap, not cancellation.
- Stop: RG permanently stopped (system-driven). DO NOT count.
- Refund Pending: refund in progress. Exclude from income.
- Refund Complete: refund done. DEDUCT from gross income for net income.

PAYMENT STATUSES:
- Processed: successful. Sale → Complete. Count as income. (Note: DD may be marked Processed before bank clearance — verify per client.)
- Pending: not yet processed.
- Failed: Hard failure (card expired/incorrect — unlikely to succeed on retry). Soft failure (insufficient funds — may succeed on retry).
- Error: gateway communication error — outcome unknown. Recurrence halts until admin resolves manually. FLAG for manual review.
- Void: cancelled future payment.

RECURRENCE STATUS (binary): Active (running) / Inactive (not running).

RECURRENCE STAGE (9 values — use for health reporting):
- Pending: future start date, not yet active.
- Active: first payment successful, generating instalments. COUNT in active RG totals.
- At Risk: last payment failed, in retry. STILL ACTIVE — do not remove from active count. Key segment for decline management.
- Suspended: temporarily paused at donor request. Report as income gap, not cancellation.
- Cancelled: manually cancelled at donor request. Donor-initiated attrition.
- Stopped: auto-stopped after all retries exhausted. Payment-failure attrition.
- Reactivated: was Inactive, now running again.
- Upgraded: latest modification increased amount.
- Downgraded: latest modification decreased amount.
IMPORTANT: Cancelled ≠ Stopped. Always report separately — different causes, different recovery strategies.

COMMUNICATION ACTIVITY SEND STATUSES:
- Sent: delivered. Count in send volume.
- Opened: email opened (pixel tracking). Numerator for Open Rate.
- Clicked: link clicked. Numerator for Click Rate.
- Bounced: undeliverable. Flag for data hygiene.
- Suppressed: excluded (Do Not Email, unsubscribed, deduplicated).
- Unsubscribed: opted out post-send.
- Pending: scheduled, not yet sent.
Note: Open Rate, Click Rate, Bounce Rate, Unsubscribe Rate are ONLY meaningful for digital channels (Email, SMS). These will be blank/zero for Direct Mail, Telemarketing, F2F, Flyer — a 0% open rate on a Telemarketing activity is expected, not a failure.

━━ DATASET RELATIONSHIPS ━━

Contact → Sale: Sale Contact ID = Contact.contact_id (one Contact, many Sales)
Contact → Recurrence: Recurrence.contact_id (one Contact, many Recurrences)
Contact → Communication Activity: CommActivity.contact_id
Sale → Offer: Sale Offer ID = Offer.offer_id
Recurrence → Sale: Sale Recurrence ID (null = one-off donation)
Sale → Payment: Payment.sale_id (one Sale, zero or many Payments)
Sale → Communication Activity: Sale Communication Activity Code (DIRECT — confirmed in export data)
Sale → Campaign: Sale Campaign Name (direct attribution on Sale record)
Sale → Response ID: Sale Campaign Log Response ID (links Sale to offline activity)
Communication Activity → Campaign: CommActivity.campaign_id

━━ REPORTING METHODS ━━

Three methods in Clarety:
1. File Export — ad hoc, any module, CSV/Excel. No AI access.
2. Standard Reports — Sales Dashboard, Lead Performance Report, Events Payment Report. No AI access.
3. Saved Export + Dashboard — custom repeatable extracts. PRIMARY AI DATA SOURCE.

Sales Dashboard key metrics:
- MRR: monthly RG income. Different frequencies normalised to monthly equivalent — may not match naive sum of Sale amounts.
- Current Recurring Sales: active RGs (can toggle to show At Risk).
- Current Revenue Protection Sales: suspended RGs (not lost — paused).
- Current Lost Sales: CUMULATIVE all-time total — does not reset per period. Use Saved Export end_date filter for period-specific lapsed counts.
- Saved Recurring Sales: RGs returned to Active after failed payment journey (win-back measure).

━━ PERFORMANCE REPORT METRICS ━━

Supply: No. of Leads (list size), Cost Per Lead.
Email (digital only): Unsubscribe Rate, Open Rate, Click Rate, Bounce Rate.
Contact: No. of Contacts (actually reached), Contact Rate (Contacts ÷ Leads), Cost per Contact.
Conversion: No. of Conversions (depends on Conversion Metric), Conversion Rate per Lead, Conversion Rate per Contact, Cost per Conversion.
One-off Sales: Total Amount, No. of One-off Sales, Average Amount, Cost per Success.
Recurrences: Total MRR, No. of Recurrences, Average MRR, First Debit Rate (Successful First Debits ÷ No. of Recurrences — KEY acquisition quality metric), Successful First Debits, Cost per Success.
A dash (—) in Recurrence metrics = zero RG conversions, not missing data.
First Debit Rate is the most important RG acquisition quality metric — always surface alongside raw sign-up counts.

━━ CRITICAL REPORTING RULES ━━

INCOME:
- Only Sale Status = Complete counts as confirmed income.
- Use Sale Line Total as the revenue field (Amount column may be empty in exports).
- Deduct Refund Complete Sales for net income.
- Aggregate income at Sale level, not Payment level.
- Filter Offer Type = "Donation" or "Donation - Recurring" for charitable income only.

DONOR COUNTING:
- "How many donors" = count distinct Sale Contact ID values, not Sale rows.
- "New donor" = MIN(Sale Sold Date) per contact where Sale Status = Complete.
- P2P donors (Fundraiser Page ID populated) may need separate counting.

REGULAR GIVING:
- Use Recurrence Stage (not Status) for health segmentation.
- Use original_start_date (not schedule_start_date) for tenure.
- Cancelled ≠ Stopped — always report separately.
- At Risk RGs are still Active — do not remove from active counts.
- MRR from raw data requires frequency normalisation (weekly/fortnightly/quarterly → monthly).

ATTRIBUTION:
- Communication Activity only flows to first Sale on a Recurrence.
- Future Sales inherit Channel + Source of latest modification.
- Response ID (Sale Campaign Log Response ID) is authoritative for offline attribution.
- Do not sum List Group metrics without confirming mutual exclusivity.
- Activity names are free-text — use Type and Conversion Metric for interpretation, not the name.

DATA INTEGRITY:
- Error payments on a Recurrence silently halt future instalments. Monitor proactively.
- Direct Debit "Processed" may be reversed by bank — confirm DD config per client.
- Current Lost Sales (dashboard) is cumulative — use end_date in Saved Export for period counts.
- Tags are module-specific — a Contact tag is not available in Sales module.

━━ RECURRENCE MODEL VERSION ━━
This dictionary describes the NEW RECURRENCE MODEL (instances deployed after August 2022).
Instances deployed before August 2022 use the ORIGINAL SALE MODEL with different RG data structures.
Always confirm which model a client is running before interpreting RG data.
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SYSTEM PROMPT — BEHAVIOUR INSTRUCTIONS
//  Combined with the data dictionary above
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BEHAVIOUR_INSTRUCTIONS = `
Behaviour rules:
- If user is greeting: respond warmly and briefly.
- If user asks for writing (emails/appeals/templates/rewrites): provide a complete draft immediately. Use placeholders like [Organisation Name], [Donation Link], [First Name] for missing details. Do not refuse or keep asking questions.
- If user asks a factual Clarety/how-to question: use provided reference snippets when available. If not available, provide best-effort guidance and ask at most ONE clarifying question.
- If user asks a data/reporting question: apply the reporting rules from the data dictionary precisely. State which export or metric you are drawing from.
- Never say you cannot help just because sources are incomplete.
- Never suggest modifying, deleting, or changing any data in Clarety.
- Do not mention internal systems, retrieval, or that you searched anything.
- If an image is provided: describe what the image contains and answer the user's question about it.
`;

const FULL_SYSTEM_PROMPT = CLARETY_DICTIONARY + "\n" + BEHAVIOUR_INSTRUCTIONS;

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Clarety AI backend (Claude) is running!"));

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    model: "claude-sonnet-4-6",
    commit: process.env.RENDER_GIT_COMMIT || null,
    deServingConfig: `projects/${DE_PROJECT_NUMBER}/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}/servingConfigs/${DE_SERVING_CONFIG_ID}`,
    maxImageMB: MAX_IMAGE_MB,
  });
});

// Debug: retrieval only (unchanged)
app.get("/debug-search", async (req, res) => {
  try {
    const q = safeString(req.query.q);
    const token = await getAccessToken();
    const url =
      `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
      `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
      `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;
    const body = {
      query: q, pageSize: 10,
      queryExpansionSpec: { condition: "AUTO" },
      spellCorrectionSpec: { mode: "AUTO" },
      languageCode: "en-US",
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    res.status(r.status).json({
      url, status: r.status, totalSize: json.totalSize ?? null,
      results: (json.results || []).map((x) => ({
        title: x?.document?.derivedStructData?.title || null,
        link: x?.document?.derivedStructData?.link || null,
        extractive: x?.document?.derivedStructData?.extractive_answers?.[0]?.content || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Main chat endpoint — now powered by Claude
 * Accepts JSON { query, sessionId } or multipart/form-data (query, sessionId, image file)
 */
app.post("/chat", upload.single("image"), async (req, res) => {
  try {
    const sessionId = safeString(req.body.sessionId) || "default";
    const userQuery = safeString(req.body.query);
    const hasImage  = !!req.file;

    console.log("=================================");
    console.log("CHAT REQUEST", {
      sessionId, hasImage,
      queryLen: userQuery.length,
      mime: hasImage ? req.file.mimetype : null,
    });
    console.log("=================================");

    // Greeting override (no retrieval)
    if (!hasImage && isGreeting(userQuery)) {
      const greeting =
        "Hi 👋 I'm the Clarety AI Assistant.\n" +
        "Ask me anything about your Clarety data — donor counts, RG performance, campaign results, and more.";
      addToSession(sessionId, "user", userQuery);
      addToSession(sessionId, "assistant", greeting);
      return res.json({ answer: greeting, links: [] });
    }

    if (!hasImage && !userQuery) {
      return res.json({
        answer: "Type a question — or upload a screenshot and ask what you want me to look at.",
        links: [],
      });
    }

    // ── RAG retrieval (unchanged from original) ──────────────────────────────
    const writing = isWritingRequest(userQuery);
    const factual  = looksLikeFactualHowTo(userQuery) && !writing;
    let snippets = [], links = [], retrievalCount = 0;
    const shouldRetrieve = !hasImage && (factual || writing || !!userQuery);

    if (shouldRetrieve) {
      const token = await getAccessToken();
      const searchUrl =
        `https://discoveryengine.googleapis.com/v1alpha/projects/${DE_PROJECT_NUMBER}` +
        `/locations/${DE_LOCATION}/collections/${DE_COLLECTION_ID}/engines/${DE_ENGINE_ID}` +
        `/servingConfigs/${DE_SERVING_CONFIG_ID}:search`;
      const searchBody = {
        query: userQuery, pageSize: 8,
        queryExpansionSpec: { condition: "AUTO" },
        spellCorrectionSpec: { mode: "AUTO" },
        languageCode: "en-US",
      };
      const searchResp = await fetch(searchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(searchBody),
      });
      const searchJson = await searchResp.json();
      const results = searchJson.results || [];
      retrievalCount = results.length;
      for (const r of results) {
        const d = r?.document?.derivedStructData || {};
        if (d.title && d.link) links.push({ title: d.title, url: fixGsLink(d.link) });
        const ea = d?.extractive_answers?.[0]?.content;
        if (ea) snippets.push(`- ${d.title || "Source"}: ${ea}`);
      }
      const seen = new Set();
      links = links.filter((x) => {
        const k = `${x.title}::${x.url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // ── Build conversation messages for Claude ────────────────────────────────
    // Claude uses { role: "user" | "assistant", content: string | array }
    // System prompt is passed separately (not as a message)
    const history = getSessionMessages(sessionId);

    // Record user turn in memory
    addToSession(
      sessionId, "user",
      hasImage ? `[Image uploaded] ${userQuery || ""}`.trim() : userQuery
    );

    // Build context block from retrieval snippets
    const contextBlock = snippets.length > 0
      ? "\n\nHelpful reference snippets from Clarety documentation:\n" + snippets.slice(0, 8).join("\n")
      : "";

    const nudge = writing
      ? "\nThe user wants you to write the draft now without further questions. Make reasonable assumptions and proceed."
      : "";

    const factualNote = factual && snippets.length === 0
      ? "\nNo reference snippets were found. Provide best-effort guidance based on your knowledge of Clarety. Ask at most ONE clarifying question if truly needed."
      : "";

    // Convert history to Claude message format
    // Claude requires alternating user/assistant turns — filter out any system messages
    const claudeMessages = [];

    for (const m of history) {
      if (m.role === "system") continue;
      claudeMessages.push({ role: m.role, content: m.content });
    }

    // Add current user message
    if (hasImage) {
      // Vision message format for Claude
      const b64 = req.file.buffer.toString("base64");
      const mediaType = req.file.mimetype || "image/png";
      claudeMessages.push({
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: b64 },
          },
          {
            type: "text",
            text: (userQuery ? `User question: ${userQuery}` : "User uploaded an image.")
              + nudge + contextBlock,
          },
        ],
      });
    } else {
      claudeMessages.push({
        role: "user",
        content: `User message: ${userQuery}${nudge}${contextBlock}${factualNote}`,
      });
    }

    // ── Call Anthropic Claude ─────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",   // swap to "claude-haiku-4-5-20251001" to reduce cost
      max_tokens: 1024,
      system:     FULL_SYSTEM_PROMPT,    // data dictionary + behaviour instructions
      messages:   claudeMessages,
    });

    const answer = response.content[0]?.text || "I found information but couldn't generate a response.";

    // Store assistant response in session memory
    addToSession(sessionId, "assistant", answer);

    return res.json({
      answer,
      links: [],    // set to "links" to re-enable retrieval links in the UI
      meta: { hasImage, retrievalCount, writing, factual },
    });

  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    return res.status(500).json({ answer: "Backend error", error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Clarety AI (Claude) listening on port ${PORT}`));
