import { Client, Databases, Query, ID } from "node-appwrite";

const NETWORK = "devnet";
const RPC_URL = "https://api.devnet.solana.com";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RECEIVER = "2hwgmesxeu7LKt8fLSsYWdnV8AshKHyC19svMZACi2Gf";
const AMOUNT_ATOMIC = "500000";
const PRICE_USDC = 0.5;
const DURATION_MS = 24 * 60 * 60 * 1000;

const client = new Client()
  .setEndpoint(
    process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT,
  )
  .setProject(
    process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID,
  )
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const COLLECTION_ID = process.env.APPWRITE_SPONSOR_COLLECTION_ID;

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error("Solana RPC request failed.");
  }

  const result = await response.json();

  if (result.error) {
    throw new Error("Solana RPC verification failed.");
  }

  return result.result;
}

async function findExistingSignature(signature) {
  const result = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
    Query.equal("signature", signature),
    Query.limit(1),
  ]);

  return result.documents.length > 0;
}

async function verifyTransaction(signature, walletAddress) {
  const transaction = await rpc("getTransaction", [
    signature,
    {
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    },
  ]);

  if (!transaction) {
    throw new Error("Transaction not found or not finalized on Solana Devnet.");
  }

  if (transaction.meta?.err) {
    throw new Error("The Solana transaction failed.");
  }

  const message = transaction.transaction?.message;
  const accountKeys = message?.accountKeys || [];

  const walletSigned = accountKeys.some(
    (key) => key.pubkey === walletAddress && key.signer === true,
  );

  if (!walletSigned) {
    throw new Error("The submitted wallet did not sign this transaction.");
  }

  const balances = [
    ...(transaction.meta?.preTokenBalances || []),
    ...(transaction.meta?.postTokenBalances || []),
  ];

  const accountOwners = new Map();

  for (const balance of balances) {
    if (balance.owner && balance.mint) {
      accountOwners.set(
        `${balance.accountIndex}:${balance.mint}`,
        balance.owner,
      );
    }
  }

  const allInstructions = [
    ...(message?.instructions || []),
    ...(transaction.meta?.innerInstructions || []).flatMap(
      (group) => group.instructions || [],
    ),
  ];

  const validTransfer = allInstructions.some((instruction) => {
    if (
      instruction.program !== "spl-token" ||
      instruction.parsed?.type !== "transferChecked"
    ) {
      return false;
    }

    const info = instruction.parsed.info;
    const amount = info.tokenAmount?.amount;

    if (
      info.mint !== USDC_MINT ||
      info.authority !== walletAddress ||
      amount !== AMOUNT_ATOMIC
    ) {
      return false;
    }

    const sourceIndex = accountKeys.findIndex(
      (key) => key.pubkey === info.source,
    );

    const destinationIndex = accountKeys.findIndex(
      (key) => key.pubkey === info.destination,
    );

    if (sourceIndex < 0 || destinationIndex < 0) {
      return false;
    }

    const sourceOwner = accountOwners.get(`${sourceIndex}:${USDC_MINT}`);

    const destinationOwner = accountOwners.get(
      `${destinationIndex}:${USDC_MINT}`,
    );

    return sourceOwner === walletAddress && destinationOwner === RECEIVER;
  });

  if (!validTransfer) {
    throw new Error(
      "No matching 0.5 USDC transfer to the sponsorship wallet was found.",
    );
  }

  // Independently verify the receiver's net USDC increase.
  const pre = transaction.meta?.preTokenBalances || [];
  const post = transaction.meta?.postTokenBalances || [];

  const totalForOwner = (entries) =>
    entries
      .filter((entry) => entry.owner === RECEIVER && entry.mint === USDC_MINT)
      .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);

  const receiverIncrease = totalForOwner(post) - totalForOwner(pre);

  if (receiverIncrease !== BigInt(AMOUNT_ATOMIC)) {
    throw new Error(
      "The receiver's USDC balance change does not match the required payment.",
    );
  }

  return true;
}

async function handlePayment(payment) {
  if (
    !payment ||
    typeof payment.signature !== "string" ||
    typeof payment.walletAddress !== "string"
  ) {
    return {
      status: 400,
      body: { verified: false, error: "Missing signature or wallet address." },
    };
  }

  const signature = payment.signature.trim();
  const walletAddress = payment.walletAddress.trim();

  if (
    signature.length < 80 ||
    signature.length > 100 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)
  ) {
    return {
      status: 400,
      body: { verified: false, error: "Invalid transaction signature." },
    };
  }

  // FIRST: reject signatures already stored in the database.
  if (await findExistingSignature(signature)) {
    return {
      status: 409,
      body: {
        verified: false,
        error: "Transaction already processed.",
      },
    };
  }

  // Only the server's fixed values are used for verification.
  if (
    payment.network !== NETWORK ||
    payment.tokenMint !== USDC_MINT ||
    payment.amountAtomic !== AMOUNT_ATOMIC
  ) {
    return {
      status: 400,
      body: { verified: false, error: "Invalid payment configuration." },
    };
  }

  const slotId =
    typeof payment.slotId === "string" ? payment.slotId.trim() : "";

  const logoName =
    typeof payment.logoName === "string" ? payment.logoName.trim() : "";

  const email =
    typeof payment.email === "string" ? payment.email.trim().toLowerCase() : "";

  let linkUrl;

  try {
    linkUrl = new URL(payment.linkUrl);

    if (
      !["https:", "http:"].includes(linkUrl.protocol) ||
      !linkUrl.hostname.includes(".") ||
      linkUrl.username ||
      linkUrl.password
    ) {
      throw new Error();
    }
  } catch {
    return {
      status: 400,
      body: { verified: false, error: "Invalid website URL." },
    };
  }

  if (
    !slotId ||
    !logoName ||
    logoName.length > 255 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return {
      status: 400,
      body: { verified: false, error: "Invalid sponsorship details." },
    };
  }

  // Prevent buying a slot that is already active.
  const existingSlots = await databases.listDocuments(
    DATABASE_ID,
    COLLECTION_ID,
    [
      Query.equal("slotId", slotId),
      Query.equal("status", "active"),
      Query.limit(100),
    ],
  );

  const now = Date.now();

  const slotTaken = existingSlots.documents.some(
    (purchase) => purchase.expiresAt && Date.parse(purchase.expiresAt) > now,
  );

  if (slotTaken) {
    return {
      status: 409,
      body: {
        verified: false,
        error: "This sponsorship slot is already taken.",
      },
    };
  }

  // Verify the actual finalized transaction on Solana.
  await verifyTransaction(signature, walletAddress);

  const startsAt = new Date().toISOString();
  const expiresAt = new Date(now + DURATION_MS).toISOString();

  try {
    const purchase = await databases.createDocument(
      DATABASE_ID,
      COLLECTION_ID,
      ID.unique(),
      {
        slotId,
        slotNumber:
          Number.isSafeInteger(payment.slotNumber) && payment.slotNumber > 0
            ? payment.slotNumber
            : 1,
        logoName,
        logoUrl: `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(
          linkUrl.origin,
        )}&sz=128`,
        linkUrl: linkUrl.href,
        email,
        notes:
          typeof payment.notes === "string"
            ? payment.notes.trim().slice(0, 2000)
            : "",

        amount: PRICE_USDC,
        currency: "USDC",
        status: "active",

        walletAddress,
        signature,
        network: NETWORK,
        tokenMint: USDC_MINT,
        amountAtomic: AMOUNT_ATOMIC,

        createdAt: startsAt,
        paidAt: startsAt,
        startsAt,
        expiresAt,
      },
    );

    return {
      status: 200,
      body: {
        verified: true,
        message: "Payment verified. Sponsorship activated for 24 hours.",
        purchaseId: purchase.$id,
      },
    };
  } catch (error) {
    // A unique signature index prevents concurrent duplicate inserts.
    if (await findExistingSignature(signature)) {
      return {
        status: 409,
        body: {
          verified: false,
          error: "Transaction already processed.",
        },
      };
    }

    throw error;
  }
}

export default async ({ req, res, log, error }) => {
  try {
    const body = req.bodyJson || JSON.parse(req.bodyRaw || "{}");

    if (body.action !== "verify-phantom-payment") {
      return res.json(
        { error: "Unsupported action in this payment handler." },
        400,
      );
    }

    const result = await handlePayment(body.payment);

    return res.json(result.body, result.status);
  } catch (err) {
    error(String(err));

    return res.json(
      {
        verified: false,
        error:
          err instanceof Error ? err.message : "Payment verification failed.",
      },
      500,
    );
  }
};
