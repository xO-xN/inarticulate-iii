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
  console.log("OSC → " + oscHost + ":" + oscPort);
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

let clientCounter = 1;
let freedIds = [];
let assignedIds = new Set(); // Track specifically assigned IDs (1, 2, 3)

// Function to broadcast the current client count
function broadcastClientCount() {
  // Calculate actual connected clients by subtracting freed IDs from the highest assigned ID
  const actualConnectedClients = clientCounter - 1 - freedIds.length;
  io.emit("clientCount", actualConnectedClients);
}

io.on("connection", (socket) => {
  // Initially assign a temporary ID
  if (freedIds.length > 0) {
    socket.clientId = Math.min(...freedIds);
    freedIds = freedIds.filter((id) => id !== socket.clientId);
  } else {
    socket.clientId = clientCounter++;
  }

  socket.emit("clientId", socket.clientId);
  broadcastClientCount();

  // Handle ID selection from client
  socket.on("selectId", (data) => {
    const userType = data.userType;

    // For IDs 1, 2, 3 - check if already taken
    if (userType !== "OB" && assignedIds.has(userType)) {
      socket.emit("idConfirmation", {
        status: "rejected",
        userType: userType,
        message: "ID already taken",
      });
      return;
    }

    // If user had a previous ID (not OB), free it
    if (socket.userType && socket.userType !== "OB") {
      assignedIds.delete(socket.userType);
    }

    // Assign new ID
    socket.userType = userType;
    if (userType !== "OB") {
      assignedIds.add(userType);
      // For numeric IDs, set clientId to match the selected number
      socket.clientId = parseInt(userType);
    }

    socket.emit("idConfirmation", {
      status: "accepted",
      userType: userType,
    });

    //console.log(`Client ${socket.id} selected ID type: ${userType}`);
  });

  socket.on("point", (data) => {
    // Only process data from non-observer clients
    if (socket.userType === "OB") return;

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
    if (socket.userType === "OB") return;

    client.send("/" + data.id, data.stroke, (err) => {
      if (err) {
        console.error("Error sending OSC line message:", err);
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected, cleared clientId:", socket.clientId);

    // Send OSC clear signals for points and amplitude
    client.send("/p" + socket.clientId, 0, (err) => {
      if (err) {
        console.error(
          "Error sending OSC clear message for client " + socket.clientId + ":",
          err,
        );
      }
    });
    client.send("/p" + socket.clientId + "amp", 0, (err) => {
      if (err) {
        console.error(
          "Error sending OSC clear amp message for client " +
            socket.clientId +
            ":",
          err,
        );
      }
    });

    // Tell all other clients to remove this client's point
    socket.broadcast.emit("pointSend", {
      clear: true,
      clientId: socket.clientId,
    });

    // Free the numeric ID if it was assigned
    if (socket.userType && socket.userType !== "OB") {
      assignedIds.delete(socket.userType);
    }

    freedIds.push(socket.clientId);
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
