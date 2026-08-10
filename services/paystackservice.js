// services/paystackservice.js
// ============================================================
// Thin wrapper around Paystack's Transaction API. No extra
// dependency — uses native fetch (Node 18+).
//
// Docs: https://paystack.com/docs/api/transaction/
//
// Usage:
//   const PaystackService = require("./paystackservice");
//   const { authorization_url, access_code } =
//     await PaystackService.initializeTransaction({ email, amount, reference });
//   const tx = await PaystackService.verifyTransaction(reference);
// ============================================================

const { AppError } = require("../utils/errorhandler");

const PAYSTACK_BASE_URL = "https://api.paystack.co";

const getSecretKey = () => {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new AppError(
      "Paystack is not configured (missing PAYSTACK_SECRET_KEY)",
      500,
      false,
    );
  }
  return key;
};

class PaystackService {
  // ── initializeTransaction ─────────────────────────────────
  // Starts a transaction on Paystack's side.
  // amount is in GHS (major unit) — converted to pesewas here.
  //
  // @returns { authorization_url, access_code, reference }
  static async initializeTransaction({
    email,
    amount,
    reference,
    callback_url,
    metadata,
  }) {
    if (!email) {
      throw new AppError(
        "Email is required to initialize a Paystack transaction",
        400,
      );
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError("Amount must be a positive number", 400);
    }
    if (!reference) {
      throw new AppError(
        "Reference is required to initialize a Paystack transaction",
        400,
      );
    }

    let response;
    try {
      response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getSecretKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: Math.round(parsedAmount * 100), // GHS → pesewas
          currency: "GHS",
          reference,
          callback_url,
          metadata,
        }),
      });
    } catch (networkErr) {
      throw new AppError(
        `Could not reach Paystack: ${networkErr.message}`,
        502,
      );
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.status) {
      throw new AppError(
        data?.message || "Failed to initialize Paystack transaction",
        502,
      );
    }

    return data.data; // { authorization_url, access_code, reference }
  }

  // ── verifyTransaction ─────────────────────────────────────
  // Confirms a transaction's real status directly with Paystack.
  // This is the ONLY source of truth — never trust a client-reported
  // or webhook-reported status without calling this first.
  //
  // @returns { status: 'success'|'failed'|'abandoned', amount, channel,
  //            id, authorization: { last4, card_type, bank, ... }, ... }
  static async verifyTransaction(reference) {
    if (!reference) throw new AppError("Reference is required", 400);

    let response;
    try {
      response = await fetch(
        `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${getSecretKey()}` },
        },
      );
    } catch (networkErr) {
      throw new AppError(
        `Could not reach Paystack: ${networkErr.message}`,
        502,
      );
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.status) {
      throw new AppError(
        data?.message || "Failed to verify Paystack transaction",
        502,
      );
    }

    return data.data;
  }
}

module.exports = PaystackService;
