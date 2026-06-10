const express = require("express");
const os = require("os");
const app = express();
const server = app.listen(6868);
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
const { Client } = require("node-osc");
// OSC target configurable via env vars (e.g. OSC_HOST=192.168.1.5 OSC_PORT=3333)
const oscHost = process.env.OSC_HOST || "127.0.0.1";
const oscPort = parseInt(process.env.OSC_PORT, 10) || 3333;
const client = new Client(oscHost, oscPort);
const QRCode = require("qrcode");

app.use(express.static("public"));

// Print server URLs on startup
function printServerInfo() {
  console.log("Server started on port 6868");
  console.log("OSC \u2192 " + oscHost + ":" + oscPort);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        console.log("  http://" + net.address + ":6868");
      }
    }
  }
}
printServerInfo();
// QR code endpoint - generates SVG for the server URL
// Players scan this to quickly connect from their phones
app.get("/qr", (req, res) => {
  const url = req.protocol + "://" + req.headers.host + "/";
  QRCode.toString(url, { type: "svg", width: 6, margin: 1 }, (err, svg) => {
    if (err) {
      res.status(500).send("Error generating QR code");
      return;
    }
    res.type("image/svg+xml");
    res.send(svg);
  });
});

console.log("Server-side code running");

let nextTempId = 1;
let assignedIds = new Set(); // Player IDs ("1", "2", "3") currently in use

// Broadcast active player count (excludes "0" operator, excludes unselected connections)
function broadcastClientCount() {
  let count = 0;
  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType && sock.userType !== "0") count++;
  }
  io.emit("clientCount", count);
}

io.on("connection", (socket) => {
  // Assign a unique session-only temp ID (monotonic, never recycled)
  socket.clientId = nextTempId++;
  socket.emit("clientId", socket.clientId);
  broadcastClientCount();

  // Handle ID selection from client
  socket.on("selectId", (data) => {
    const userType = data.userType;

    // For IDs 1, 2, 3 - check if already taken
    if (userType !== "0" && assignedIds.has(userType)) {
      socket.emit("idConfirmation", {
        status: "rejected",
        userType: userType,
        message: "ID already taken",
      });
      return;
    }

    // If user had a previous ID (not the operator), free it
    if (socket.userType && socket.userType !== "0") {
      assignedIds.delete(socket.userType);
    }

    // Assign new ID
    socket.userType = userType;
    if (userType !== "0") {
      assignedIds.add(userType);
      // For numeric IDs, set clientId to match the selected number
      socket.clientId = parseInt(userType);
    }

    socket.emit("idConfirmation", {
      status: "accepted",
      userType: userType,
    });

    // After confirmation (so client has set selectionMade=true before receiving this),
    // tell the client their final clientId so line IDs use player numbers, not temp IDs
    // and broadcast the updated player count
    if (userType !== "0") {
      socket.emit("clientId", socket.clientId);
      broadcastClientCount();
    }

    //console.log(`Client ${socket.id} selected ID type: ${userType}`);
  });

  socket.on("point", (data) => {
    // Only process data from non-observer clients
    if (socket.userType === "0") return;

    // OSC: if point then 1
    const sendValue = Array.isArray(data) && data.length === 0 ? 0 : 1;
    client.send("/p" + socket.clientId, sendValue);

    // Broadcast updated data with clientId info for remote display
    if (Array.isArray(data) && data.length === 0) {
      // clear signal for this client
      socket.broadcast.emit("pointSend", {
        clear: true,
        clientId: socket.clientId,
      });
    } else if (data && data.main) {
      // attach clientId to point data (including optional amp)
      socket.broadcast.emit("pointSend", {
        clientId: socket.clientId,
        main: data.main,
        amp: data.amp,
      });
    }

    if (data && data.amp !== undefined) {
      // Received amp, process normally
      socket.lastAmpSent = "non-zero"; // record last sent non-zero amp
      const amps = Array.isArray(data.amp) ? data.amp : [data.amp];
      amps.forEach((ampVal) => {
        // OSC: send amplitude data with id
        client.send(
          "/p" + socket.clientId + "amp",
          Math.min(ampVal.length, 1),
          (err) => {
            if (err) {
              console.error(
                "Error sending OSC amp message for client " +
                  socket.clientId +
                  ":",
                err,
              );
            }
          },
        );
      });
    } else {
      // No amp provided, send 0 only once until next non-zero amp value received
      if (socket.lastAmpSent !== 0) {
        client.send("/p" + socket.clientId + "amp", 0, (err) => {
          if (err) {
            console.error(
              "Error sending OSC amp message for client " +
                socket.clientId +
                ":",
              err,
            );
          }
        });
        socket.lastAmpSent = 0;
      }
    }

    if (data.relX !== undefined && data.relY !== undefined) {
      client.send("/p" + socket.clientId + "x", data.relX, (err) => {
        if (err) {
          console.error(
            "Error sending OSC pX message for client " + socket.clientId + ":",
            err,
          );
        }
      });
      client.send("/p" + socket.clientId + "y", data.relY, (err) => {
        if (err) {
          console.error(
            "Error sending OSC pY message for client " + socket.clientId + ":",
            err,
          );
        }
      });
    }
  });

  socket.on("lineStroke", (data) => {
    // Only process line data from non-observer clients
    if (socket.userType === "0") return;

    client.send("/" + data.id, data.stroke, (err) => {
      if (err) {
        console.error("Error sending OSC line message:", err);
      }
    });
  });

  socket.on("disconnect", () => {
    const isPlayer = socket.userType && socket.userType !== "0";
    console.log(
      "Client disconnected" +
        (isPlayer ? " (player " + socket.userType + ")" : "") +
        ", id:",
      socket.clientId,
    );

    // Only actual players sent data — only they need cleanup
    if (isPlayer) {
      const playerId = parseInt(socket.userType); // 1, 2, or 3

      // OSC: clear this player's point, amp, and position signals
      client.send("/p" + playerId, 0, (err) => {
        if (err)
          console.error(
            "Error sending OSC clear for player " + playerId + ":",
            err,
          );
      });
      client.send("/p" + playerId + "amp", 0, (err) => {
        if (err)
          console.error(
            "Error sending OSC amp clear for player " + playerId + ":",
            err,
          );
      });

      // Broadcast: remove this player's point from other clients
      socket.broadcast.emit("pointSend", {
        clear: true,
        clientId: playerId,
      });

      // Free the player ID for reuse
      assignedIds.delete(socket.userType);
    }

    delete socket.clientId;
    delete socket.userType;
    broadcastClientCount();
  });
});

client.send("/server", "osc connected", (err) => {
  if (err) {
    console.error("Error sending OSC message:", err);
  } else {
    console.log("OSC message sent successfully.");
  }
});
