function isClaimToken(value) {
  return (
    typeof value === "string" &&
    value.length >= 24 &&
    value.length <= 128
  );
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
};
