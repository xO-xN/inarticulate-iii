// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports      → manifest.json (browser gets them via __config.js injected
//                 by the server; ports are read lazily so the page never
//                 races on __config.js load order)
//   Events     → here (events)
//   Player IDs → here (playerIds)
//   Storage    → here (storageKeys)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({ getPorts: getPortsFromManifest });
  } else {
    root.PNDS = factory({ getPorts: getPortsFromConfig });
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  var getPorts = deps.getPorts;

  return {
    // Read from manifest.json (Node) or __config.js (browser).
    // Change ports ONLY in manifest.json.
    performerPort: getPorts().performerPort,
    monitorPort: getPorts().monitorPort,

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
function getPortsFromManifest() {
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

// Browser: read ports from the injected __config.js script.
// Uses a getter so the page reads __PNDS_PORTS__ only when it actually
// accesses performerPort / monitorPort — never races on load order.
function getPortsFromConfig() {
  var cfg = root.__PNDS_PORTS__;
  if (!cfg) {
    throw new Error(
      "__PNDS_PORTS__ not set — ensure __config.js is loaded before shared.js",
    );
  }
  return cfg;
}
