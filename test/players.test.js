const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decidePlayerClaim,
} = require("../lib/players");

const PLAYER_ID = "1";
const FIRST_SOCKET = "socket-first";
const SECOND_SOCKET = "socket-second";
const FIRST_CLAIM = "a".repeat(32);
const SECOND_CLAIM = "b".repeat(32);

test("player claim accepts a new player, transfers its own reconnect, and rejects another device", () => {
  const assignments = new Map();

  assert.deepEqual(
    decidePlayerClaim(assignments, {
      playerId: PLAYER_ID,
      socketId: FIRST_SOCKET,
      claimToken: FIRST_CLAIM,
    }),
    { status: "accepted" },
  );

  assignments.set(PLAYER_ID, {
    socketId: FIRST_SOCKET,
    claimToken: FIRST_CLAIM,
  });

  assert.deepEqual(
    decidePlayerClaim(assignments, {
      playerId: PLAYER_ID,
      socketId: SECOND_SOCKET,
      claimToken: FIRST_CLAIM,
    }),
    {
      status: "takeover",
      previousSocketId: FIRST_SOCKET,
    },
  );

  assert.deepEqual(
    decidePlayerClaim(assignments, {
      playerId: PLAYER_ID,
      socketId: SECOND_SOCKET,
      claimToken: SECOND_CLAIM,
    }),
    {
      status: "rejected",
      message: "ID already taken by another device.",
    },
  );
});
