// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports      → manifest.json (browser gets them via __config.js injected
//                 by the server)
//   Events     → here (events)
//   Player IDs → here (playerIds)
//   Storage    → here (storageKeys)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(readManifestPorts());
  } else {
    root.PNDS = factory(readConfig());
  }
})(typeof self !== "undefined" ? self : this, function (ports) {
  return {
    // Read from manifest.json (Node) or __config.js (browser).
    // Change ports ONLY in manifest.json.
    performerPort: ports.performerPort,
    monitorPort: ports.monitorPort,

    playerIds: ["1", "2", "3"],

    storageKeys: {
      playerId: "inarticulate-iii.player-id",
      playerClaim: "inarticulate-iii.player-claim",
    },

    events: {
      selectId: "selectId",
      idConfirmation: "idConfirmation",
      clientId: "clientId",
      clientCount: "clientCount",
      point: "point",
      pointSend: "pointSend",
      lineStroke: "lineStroke",
      oscActivity: "oscActivity",
      resetRoles: "resetRoles",
      rolesReset: "rolesReset",
    },
  };
});

// Node: read ports from manifest.json (the single source of truth).
function readManifestPorts() {
  var fs = require("node:fs");
  var path = require("node:path");
  // shared.js lives in public/; the manifest is one directory up.
  var manifestPath = path.join(__dirname, "..", "manifest.json");
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    performerPort: manifest.scoreServer.performerPort,
    monitorPort: manifest.scoreServer.monitorPort,
  };
}

// Browser: read the injected __config.js script.
function readConfig() {
  var cfg = window.__PNDS_CONFIG__;
  if (!cfg) {
    throw new Error(
      "__PNDS_CONFIG__ not set — ensure __config.js is loaded before shared.js",
    );
  }
  return cfg;
}
