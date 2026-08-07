// Client identity registry.
//
// Reusable PNDS core: Inarticulate III has fixed player IDs (1, 2, 3).
// A performer claims an ID and recovers it after a reconnect via a claim
// token. Two devices cannot share the same player ID unless they present
// the same token (takeover).

const crypto = require("node:crypto");

const TOKEN_MIN_LENGTH = 24;
const TOKEN_MAX_LENGTH = 128;

function isClaimToken(value) {
  return (
    typeof value === "string" &&
    value.length >= TOKEN_MIN_LENGTH &&
    value.length <= TOKEN_MAX_LENGTH
  );
}

function generateClaimToken() {
  return crypto.randomBytes(24).toString("hex");
}

function decidePlayerClaim(assignments, {
  playerId,
  socketId,
  claimToken,
}) {
  const current = assignments.get(playerId);

  if (!current || current.socketId === socketId) {
    return { status: "accepted" };
  }

  if (
    isClaimToken(claimToken) &&
    current.claimToken === claimToken
  ) {
    return {
      status: "takeover",
      previousSocketId: current.socketId,
    };
  }

  return {
    status: "rejected",
    message: "ID already taken by another device.",
  };
}

module.exports = {
  decidePlayerClaim,
  isClaimToken,
  generateClaimToken,
};
