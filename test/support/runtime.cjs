const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "../..");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function sharedMap() {
  return process.env.PNDS_TEST_SHARED_LIBRARIES || execFileSync(
    process.execPath, [path.join(PROJECT_ROOT, "scripts/shared-env.cjs")],
    { encoding: "utf8" },
  );
}

async function runtimeFixture(t, { environment = {}, mode = "none", ports = {}, localDependencies = false, managed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pnds-iii-runtime-"));
  // Copy the runnable project, deliberately excluding all local npm packages.
  for (const name of ["server.js", "lib", "audio", "public", "supercollider"]) {
    fs.cpSync(path.join(PROJECT_ROOT, name), path.join(root, name), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json")));
  const performerPort = ports.performerPort || await freePort();
  let monitorPort = ports.monitorPort || await freePort();
  while (monitorPort === performerPort) monitorPort = await freePort();
  const listeners = [];
  let assignment;
  if (managed) {
    for (const role of ["performer", "monitor"]) {
      const listener = net.createServer();
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      listeners.push(listener);
    }
    assignment = { version: 1, runId: "managed-iii-test", reportPath: path.join(root, "bound.json"), services: listeners.map((listener, index) => ({
      role: index === 0 ? "performer" : "monitor", port: listener.address().port, fd: 3 + index,
    })) };
  }
  Object.assign(manifest.scoreServer, { performerPort, monitorPort });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  if (localDependencies === true) {
    fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"));
  } else if (localDependencies) {
    for (const [id, version] of Object.entries(localDependencies)) {
      const directory = path.join(root, "node_modules", id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: id, version }));
    }
  }
  const child = spawn(process.execPath, ["server.js", "--audio-mode", mode], {
    cwd: root,
    env: { ...process.env, PNDS_SHARED_LIBRARIES: sharedMap(), PNDS_HOST_IP: "127.0.0.1", ...(assignment ? { PNDS_RUNTIME_PORTS: JSON.stringify(assignment) } : {}), ...environment },
    stdio: ["ignore", "pipe", "pipe", ...listeners.map(listener => listener._handle.fd)],
  });
  for (const listener of listeners) await new Promise(resolve => listener.close(resolve));
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const actualPerformerPort = assignment?.services[0].port ?? performerPort;
  const actualMonitorPort = assignment?.services[1].port ?? monitorPort;
  const performerUrl = `http://127.0.0.1:${actualPerformerPort}`;
  const monitorUrl = `http://127.0.0.1:${actualMonitorPort}`;
  return { root, child, exited, assignment, performerPort: actualPerformerPort, monitorPort: actualMonitorPort, performerUrl, monitorUrl, output: () => output,
    async ready() {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Project exited before ready: ${output}`);
        try {
          const response = await fetch(`${performerUrl}/__pnds/health`);
          const body = await response.json();
          if (body.status === "ready") return body;
        } catch { /* wait for the bounded startup */ }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Project did not become ready: ${output}`);
    },
  };
}

module.exports = { PROJECT_ROOT, freePort, sharedMap, runtimeFixture };
