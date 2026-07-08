const express = require("express");
const os = require("os");
const readline = require("readline");
const { Client } = require("node-osc");
const QRCode = require("qrcode");
const qrcode = require("qrcode-terminal");

const app = express();
let client = null; // created after user input

const sendOSC = (...args) => client && client.send(...args);

app.use(express.static("public"));

const server = app.listen(6868, () => {
  printServerInfo();
  promptOSCTarget();
});

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// OB operator view on port 6869
const obApp = express();
obApp.use(express.static("public"));
obApp.listen(6869, () => {
  console.log("Operator view: http://<ip>:6869");
});

function printServerInfo() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        const url = "http://" + net.address + ":6868";
        console.log("Server Address: " + url);
        qrcode.generate(url, { small: true });
      }
    }
  }
}
// QR code endpoint - generates SVG for the server URL
// Players scan this to quickly connect from their phones
const qrHandler = (req, res) => {
  const url = req.protocol + "://" + req.headers.host + "/";
  QRCode.toString(url, { type: "svg", width: 6, margin: 1 }, (err, svg) => {
    if (err) {
      res.status(500).send("Error generating QR code");
      return;
    }
    res.type("image/svg+xml");
    res.send(svg);
  });
};
app.get("/qr", qrHandler);
obApp.get("/qr", qrHandler);

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

    const pAddr = "/p" + socket.clientId; // on/off signal
    const xyAddr = "/p" + socket.clientId + "xy"; // position + amplitude

    // Broadcast to other clients for visual display (unchanged)
    if (Array.isArray(data) && data.length === 0) {
      socket.broadcast.emit("pointSend", {
        clear: true,
        clientId: socket.clientId,
      });
    } else if (data && data.main) {
      socket.broadcast.emit("pointSend", {
        clientId: socket.clientId,
        main: data.main,
        amp: data.amp,
      });
    }

    // OSC: /pN — send on/off with 3 repeats for both 0 and 1
    // Cancel any pending release retries when a new touch arrives
    if (socket._releaseRetry) {
      clearTimeout(socket._releaseRetry);
      socket._releaseRetry = null;
    }

    const isActive = !(Array.isArray(data) && data.length === 0);
    const newVal = isActive ? 1 : 0;

    if (isActive) {
      // Touch active: frame-driven 3-repeat (client keeps sending frames)
      if (socket.lastPVal === undefined) socket.lastPVal = -1;
      if (socket.pSendCount === undefined) socket.pSendCount = 0;
      if (newVal !== socket.lastPVal) {
        socket.lastPVal = newVal;
        socket.pSendCount = 0;
      }
      if (socket.pSendCount < 3) {
        sendOSC(pAddr, 1, (err) => {
          if (err)
            console.error("OSC p err for player " + socket.clientId + ":", err);
        });
        socket.pSendCount++;
      }
    } else {
      // Release: client sends point,[] only once, so repeat via timer
      socket.lastPVal = 0;
      socket.pSendCount = 0;
      const doSend = () => {
        sendOSC(pAddr, 0, (err) => {
          if (err)
            console.error("OSC p err for player " + socket.clientId + ":", err);
        });
        socket.pSendCount++;
        if (socket.pSendCount < 3) {
          socket._releaseRetry = setTimeout(doSend, 50);
        }
      };
      doSend();
    }

    // OSC: /pNxy — relX, relY, amp, only when values change
    if (socket.lastXY === undefined) {
      socket.lastXY = { relX: null, relY: null, amp: null };
    }

    if (isActive && data && data.main) {
      const relX = data.relX !== undefined ? data.relX : 0.5;
      const relY = data.relY !== undefined ? data.relY : 0.5;
      const amp = data.amp ? Math.min(data.amp.length, 1) : 0;

      const last = socket.lastXY;
      if (relX !== last.relX || relY !== last.relY || amp !== last.amp) {
        socket.lastXY = { relX, relY, amp };
        sendOSC(xyAddr, relX, relY, amp, (err) => {
          if (err)
            console.error(
              "OSC xy err for player " + socket.clientId + ":",
              err,
            );
        });
      }
    } else if (!isActive) {
      // Reset so first touch after release always sends
      socket.lastXY = { relX: null, relY: null, amp: null };
    }
  });

  socket.on("lineStroke", (data) => {
    // Only process line data from non-observer clients
    if (socket.userType === "0") return;

    sendOSC("/" + data.id, data.stroke, (err) => {
      if (err) {
        console.error("Error sending OSC line message:", err);
      }
    });
  });

  socket.on("disconnect", () => {
    const isPlayer = socket.userType && socket.userType !== "0";

    // Only actual players sent data — only they need cleanup
    if (isPlayer) {
      const playerId = parseInt(socket.userType); // 1, 2, or 3

      // OSC: clear this player's point, amp, and position signals
      sendOSC("/p" + playerId, 0, (err) => {
        if (err)
          console.error(
            "Error sending OSC clear for player " + playerId + ":",
            err,
          );
      });
      sendOSC("/p" + playerId + "amp", 0, (err) => {
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

// ── Init OSC target: from CLI args or interactive prompt ───────────
function promptOSCTarget() {
  const args = process.argv.slice(2);

  let cleanIP = args[0] || null;
  let cleanPort = args[1] ? parseInt(args[1], 10) : null;

  if (cleanIP) {
    // From command-line arguments
    if (!cleanPort || isNaN(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
      cleanPort = 3333;
    }
    client = new Client(cleanIP, cleanPort);
    console.log("OSC Send Address: " + cleanIP + ":" + cleanPort);
    console.log("");
    return;
  }

  // Interactive prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("  OSC Send Address (IP:Port): ", (input) => {
    const trimmed = input.trim();

    cleanIP = "127.0.0.1";
    cleanPort = 3333;

    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex > 0) {
      const possiblePort = parseInt(trimmed.slice(colonIndex + 1), 10);
      if (!isNaN(possiblePort) && possiblePort > 0 && possiblePort <= 65535) {
        cleanPort = possiblePort;
        cleanIP = trimmed.slice(0, colonIndex);
      } else {
        cleanIP = trimmed;
      }
    } else if (trimmed) {
      cleanIP = trimmed;
    }

    client = new Client(cleanIP, cleanPort);
    console.log("OSC Send Address: " + cleanIP + ":" + cleanPort);
    console.log("");
    rl.close();
  });
}
