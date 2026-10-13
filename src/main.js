import { Client, Databases, ID } from "node-appwrite";
import { Webhook } from "standardwebhooks";

const allowedOrigins = new Set([
  "http://localhost:5173",
  "https://ciphertext.app",
  "https://www.ciphertext.app",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const url = new URL(origin);

    return (
      allowedOrigins.has(origin) ||
      (url.protocol === "https:" &&
        url.hostname.endsWith(".ngrok-free.dev") &&
        url.port === "")
    );
  } catch {
    return false;
  }
}

const client = new Client()
  .setEndpoint(process.env.SPONSOR_APPWRITE_ENDPOINT)
  .setProject(process.env.SPONSOR_APPWRITE_PROJECT_ID)
  .setKey(process.env.SPONSOR_APPWRITE_API_KEY);

const databases = new Databases(client);

const databaseId = process.env.SPONSOR_DATABASE_ID;
const collectionId = process.env.SPONSOR_COLLECTION_ID;

function getHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, webhook-id, webhook-timestamp, webhook-signature",
    Vary: "Origin",
  };

  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function getBody(req) {
  if (req.bodyJson && typeof req.bodyJson === "object") {
    return req.bodyJson;
  }

  if (typeof req.bodyText === "string" && req.bodyText) {
    return JSON.parse(req.bodyText);
  }

  return {};
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function validateWebsite(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Invalid company website.");
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid company website.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname.includes(".") ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid company website.");
  }

  return url.toString();
}

async function createCheckout(body, res, headers, log) {
  const purchase = body.purchase;

  if (!purchase || typeof purchase !== "object") {
    return res.json({ error: "Missing purchase details." }, 400, headers);
  }

  const slotId = String(purchase.slotId ?? "").trim();
  const logoName = String(purchase.logoName ?? "").trim();
  const email = String(purchase.email ?? "")
    .trim()
    .toLowerCase();
  const notes = String(purchase.notes ?? "").trim();
  const linkUrl = validateWebsite(purchase.linkUrl);

  if (!slotId || slotId.length > 100) {
    return res.json({ error: "Invalid sponsor slot." }, 400, headers);
  }

  if (!logoName || logoName.length > 255) {
    return res.json({ error: "Invalid company name." }, 400, headers);
  }

  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.json({ error: "Invalid contact email." }, 400, headers);
  }

  if (notes.length > 2000) {
    return res.json({ error: "Notes are too long." }, 400, headers);
  }

  const amount = Number(requiredEnv("SPONSOR_AMOUNT_MINOR"));
  const currency = requiredEnv("SPONSOR_CURRENCY").toUpperCase();

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("SPONSOR_AMOUNT_MINOR must be a positive integer.");
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("SPONSOR_CURRENCY must be a three-letter currency code.");
  }

  const productId = requiredEnv("DODO_PRODUCT_ID");
  const apiKey = requiredEnv("DODO_PAYMENTS_API_KEY");
  const environment = requiredEnv("DODO_PAYMENTS_ENVIRONMENT");

  if (!["test_mode", "live_mode"].includes(environment)) {
    throw new Error("Invalid DODO_PAYMENTS_ENVIRONMENT.");
  }

  const apiBase =
    environment === "test_mode"
      ? "https://test.dodopayments.com"
      : "https://live.dodopayments.com";

  const purchaseId = ID.unique();
  const now = new Date().toISOString();

  await databases.createDocument(databaseId, collectionId, purchaseId, {
    slotId,
    logoName,
    logoFileId: "",
    logoUrl: `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(
      new URL(linkUrl).origin,
    )}&sz=128`,
    linkUrl,
    email,
    notes,
    amount,
    currency,
    status: "pending",
    createdAt: now,
  });

  try {
    const response = await fetch(`${apiBase}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_cart: [
          {
            product_id: productId,
            quantity: 1,
          },
        ],
        customer: {
          email,
          name: logoName,
        },
        metadata: {
          sponsorship_id: purchaseId,
          slot_id: slotId,
        },
        return_url: requiredEnv("SPONSOR_RETURN_URL"),
      }),
    });

    const session = await response.json().catch(() => ({}));

    if (!response.ok) {
      log(`Dodo checkout creation failed with HTTP ${response.status}`);
      throw new Error("Payment provider could not create checkout.");
    }

    if (
      typeof session.checkout_url !== "string" ||
      typeof session.session_id !== "string"
    ) {
      throw new Error("Payment provider returned an invalid checkout session.");
    }

    const checkoutUrl = new URL(session.checkout_url);

    if (
      checkoutUrl.protocol !== "https:" ||
      !["checkout.dodopayments.com"].includes(checkoutUrl.hostname)
    ) {
      throw new Error("Payment provider returned an invalid checkout URL.");
    }

    await databases.updateDocument(databaseId, collectionId, purchaseId, {
      dodoCheckoutSessionId: session.session_id,
    });

    log(`Created pending sponsorship ${purchaseId}`);

    return res.json(
      {
        purchaseId,
        checkoutUrl: checkoutUrl.toString(),
      },
      200,
      headers,
    );
  } catch (err) {
    try {
      await databases.updateDocument(databaseId, collectionId, purchaseId, {
        status: "cancelled",
      });
    } catch (updateError) {
      error(`Could not mark failed checkout ${purchaseId} as cancelled.`);
    }

    throw err;
  }
}

async function handleWebhook(req, res, headers, log, error) {
  const secret = requiredEnv("DODO_PAYMENTS_WEBHOOK_KEY");
  const webhook = new Webhook(secret);

  const event = webhook.verify(req.bodyText, {
    "webhook-id": req.headers["webhook-id"],
    "webhook-timestamp": req.headers["webhook-timestamp"],
    "webhook-signature": req.headers["webhook-signature"],
  });

  if (event.type !== "payment.succeeded") {
    return res.json({ received: true }, 200, headers);
  }

  const payment = event.data;
  const sponsorshipId = payment.metadata?.sponsorship_id;

  if (!sponsorshipId || !payment.payment_id) {
    log("Ignoring payment event without sponsorship ID or payment ID.");
    return res.json({ received: true }, 200, headers);
  }

  if (payment.status !== "succeeded") {
    return res.json({ received: true }, 200, headers);
  }

  const sponsor = await databases.getDocument(
    databaseId,
    collectionId,
    sponsorshipId,
  );

  if (
    sponsor.status === "active" &&
    sponsor.dodoPaymentId === payment.payment_id
  ) {
    return res.json({ received: true, duplicate: true }, 200, headers);
  }

  if (sponsor.status !== "pending") {
    log(`Ignoring payment for purchase in status ${sponsor.status}.`);
    return res.json({ received: true }, 200, headers);
  }

  if (
    Number(sponsor.amount) !== Number(payment.total_amount) ||
    sponsor.currency?.toUpperCase() !== payment.currency?.toUpperCase()
  ) {
    log("Ignoring payment because amount or currency does not match.");
    return res.json({ received: true }, 200, headers);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await databases.updateDocument(databaseId, collectionId, sponsorshipId, {
    status: "active",
    dodoPaymentId: payment.payment_id,
    paidAt: now.toISOString(),
    startsAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  log(`Activated sponsorship ${sponsorshipId}`);

  return res.json({ received: true }, 200, headers);
}

export default async ({ req, res, log, error }) => {
  const headers = getHeaders(req.headers.origin);

  if (req.method === "OPTIONS") {
    return res.text("", 204, headers);
  }

  if (req.method !== "POST") {
    return res.json({ error: "Method not allowed." }, 405, headers);
  }

  try {
    if (!databaseId || !collectionId) {
      throw new Error("Missing sponsor database configuration.");
    }

    // Parse JSON only to route frontend checkout requests.
    // Webhook verification still uses the original raw body.
    const body = getBody(req);

    if (body.action === "create-checkout") {
      if (!isAllowedOrigin(req.headers.origin)) {
        return res.json({ error: "Origin not allowed." }, 403, headers);
      }

      return await createCheckout(body, res, headers, log);
    }

    // All non-checkout requests must pass Dodo signature verification.
    return await handleWebhook(req, res, headers, log, error);
  } catch (err) {
    error(`Sponsor function error: ${err.message}`);

    return res.json(
      { error: "Checkout or webhook processing failed." },
      400,
      headers,
    );
  }
};
