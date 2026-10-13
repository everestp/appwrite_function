import { Client, Databases } from "node-appwrite";
import { Webhook } from "standardwebhooks";

const allowedOrigins = new Set([
  "http://localhost:5173",
  "https://ciphertext.app",
  "https://www.ciphertext.app",
  "https://your-subdomain.ngrok-free.dev",
]);
const client = new Client()
  .setEndpoint(process.env.SPONSOR_APPWRITE_ENDPOINT)
  .setProject(process.env.SPONSOR_APPWRITE_PROJECT_ID)
  .setKey(process.env.SPONSOR_APPWRITE_API_KEY);

const databases = new Databases(client);

export default async ({ req, res, log, error }) => {
  const origin = req.headers.origin;

  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, webhook-id, webhook-timestamp, webhook-signature",
    Vary: "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  if (req.method === "OPTIONS") {
    return res.text("", 204, headers);
  }

  if (req.method !== "POST") {
    return res.json({ error: "Method not allowed" }, 405, headers);
  }

  try {
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;

    if (!secret) {
      throw new Error("Missing webhook signing secret");
    }

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
      log("Payment ignored: missing sponsorship_id or payment_id");
      return res.json({ received: true }, 200, headers);
    }

    if (payment.status !== "succeeded") {
      return res.json({ received: true }, 200, headers);
    }

    const sponsor = await databases.getDocument(
      process.env.SPONSOR_DATABASE_ID,
      process.env.SPONSOR_COLLECTION_ID,
      sponsorshipId,
    );

    if (
      sponsor.status === "active" &&
      sponsor.dodoPaymentId === payment.payment_id
    ) {
      return res.json({ received: true, duplicate: true }, 200, headers);
    }

    if (sponsor.status !== "pending") {
      log(`Payment ignored: sponsorship status is ${sponsor.status}`);
      return res.json({ received: true }, 200, headers);
    }

    if (
      Number(sponsor.amount) !== Number(payment.total_amount) ||
      sponsor.currency?.toUpperCase() !== payment.currency?.toUpperCase()
    ) {
      log("Payment ignored: amount or currency mismatch");
      return res.json({ received: true }, 200, headers);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await databases.updateDocument(
      process.env.SPONSOR_DATABASE_ID,
      process.env.SPONSOR_COLLECTION_ID,
      sponsorshipId,
      {
        status: "active",
        dodoPaymentId: payment.payment_id,
        paidAt: now.toISOString(),
        startsAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    );

    log(`Activated sponsorship ${sponsorshipId}`);

    return res.json({ received: true }, 200, headers);
  } catch (err) {
    error(`Webhook error: ${err.message}`);

    return res.json(
      { error: "Webhook verification or processing failed" },
      400,
      headers,
    );
  }
};
