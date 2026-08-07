# Inarticulate III

[中文](README.zh-CN.md) | **English**

A networked digital score for three performers, built on **PNDS** (Platform for Networked Digital Score).

Three performers each hold a phone or tablet. A touch controls the position of that performer's own voice; a second touch bends its pitch. When two performers move close enough to each other, the score draws a line between them and couples their sound. A Node.js score server keeps every device in sync over Socket.IO and turns the interaction into sound, either through the SuperCollider engine built into PNDS App or through an external OSC target.

This work is the reference implementation of the PNDS V1 project contract.

---

## Play This Piece

You need two things: **PNDS App**, and **the packaged release of this work**.

### 1. Install PNDS App

Download the latest `.dmg` from the [PNDS App releases page](https://github.com/xO-xN/PNDS-App/releases/latest) and drag PNDS into your Applications folder. It requires a Mac with Apple Silicon.

On first launch macOS will report that the developer cannot be verified: right-click PNDS in Applications and choose **Open**, then click **Open** again in the dialog.

You do **not** need to install Node.js or SuperCollider. PNDS App ships with both runtimes.

### 2. Download this work

> [!IMPORTANT]
> Download `Inarticulate-III-<version>.zip` from the [releases page](https://github.com/xO-xN/inarticulate-iii/releases/latest).
>
> Do **not** download “Source code (zip)” or “Source code (tar.gz)” — GitHub attaches
> those to every release automatically — and do not use the green “Code → Download ZIP”
> button. They contain the source only, without the installed Node.js dependencies, and
> PNDS App will refuse to start the project with `Project dependencies are missing`.
>
> The correct archive unzips into a folder named `Inarticulate III` that contains a
> `node_modules` directory. If your folder is named something like
> `xO-xN-inarticulate-iii-8ef57e7`, you downloaded the source archive.

Unzip the archive anywhere you like. You get a single folder named `Inarticulate III` that is ready to run offline.

### 3. Open and perform

1. Put the Mac running PNDS App on a local network — a wired connection is recommended. Connect the three performer devices (phones or tablets) to the same network.
2. Launch PNDS App, click **Open**, and select the unzipped `Inarticulate III` folder.
3. Choose **Internal Synth** as the audio mode and pick your output device, then click **Load**.
4. The monitor/conductor page appears with a QR code. Performers scan it to reach the performer page and choose Player 1, 2, or 3.

To change the audio mode, output device, or master volume during a session, move the pointer to the left edge of the PNDS App window and the sidebar slides out.

---

## Running From Source

This path is for creators and developers who want to modify the work. It runs the score server directly, without PNDS App.

### Requirements

- Node.js and npm
- SuperCollider, for the Internal mode described below — running `scsynth` manually is only necessary outside PNDS App
- The compiled SynthDef, already included at `supercollider/synthdefs/inarticulate-iii.scsyndef`

Install the dependencies:

```sh
npm install
```

### None mode — pages and networking only

Starts no audio and sends no OSC:

```sh
node server.js --audio-mode none
```

### Internal Synth mode

Start a bare `scsynth` first:

```sh
/Applications/SuperCollider.app/Contents/Resources/scsynth \
  -u 57110 \
  -B 127.0.0.1
```

Then start the score server:

```sh
node server.js --audio-mode internal
```

The target can also be given explicitly:

```sh
PNDS_OSC_TARGET=127.0.0.1:57110 \
node server.js --audio-mode internal
```

Do not set `PNDS_AUDIO_OUTPUT_BUS` when starting manually. The project falls back to hardware output bus `0` and you hear it straight from the audio interface.

On success:

```text
[audio] Internal Synth ready.
```

### External OSC and the SuperCollider debug bridge

Run this in the SuperCollider IDE first:

```text
supercollider/debug/inarticulate-iii-debug.scd
```

Then start Node:

```sh
PNDS_OSC_TARGET=127.0.0.1:57120 \
node server.js --audio-mode external
```

Port `57120` is the work's own sclang debug bridge during development. It is not the `57110` scsynth port used by Internal mode. The bridge lets a creator verify browser interaction, the Node OSC mapping, and the sound design in `external` mode **without launching PNDS App**. It is not part of the app runtime: Internal mode only loads the compiled `.scsyndef` and never starts `sclang`.

The External OSC protocol of this work is:

```text
/p1, /p2, /p3                 gate
/p1xy, /p2xy, /p3xy           x, y, amp (amp drives the PitchShift amount)
/p1-p2, /p2-p1                couple12
/p1-p3, /p3-p1                couple13
/p2-p3, /p3-p2                couple23
```

These addresses belong to Inarticulate III. They are not a PNDS-wide standard.

## The Two Pages

Default ports come from `manifest.json`:

| Page               | Address                  | Purpose                                                     |
| ------------------ | ------------------------ | ----------------------------------------------------------- |
| Performer          | `http://localhost:6868/` | Choose Player 1, 2, or 3, then perform by touch              |
| Operator / Monitor | `http://localhost:6869/` | Watch the state and show the QR code performers scan to join |

A performer's primary touch controls position; a second touch maps to the PitchShift amount of that voice. When two performers come within the connection threshold, the page draws a line between them and sends pairwise coupling control.

The monitor page is a landscape observation interface: the centre keeps the full phone interaction area, the left shows the performance strategy, and the right lists the `/p*` control addresses of this work along with the last values sent. That right-hand column is a **work control stream** observer: in External mode those are the OSC addresses actually being sent, while in Internal mode Node maps the same semantics onto standard scsynth `/n_set`.

The QR code on the monitor page always points at the performer page. Node builds that URL from `PNDS_HOST_IP`, which PNDS App injects with the LAN IPv4 the user selected. When running manually on a machine with several network interfaces, set it explicitly:

```sh
PNDS_HOST_IP=192.168.1.42 \
node server.js --audio-mode internal
```

If it is unset, standalone debugging falls back to the first non-loopback IPv4.

## Runtime Health Endpoint

Both HTTP servers expose:

```text
GET /__pnds/health
```

For example:

```sh
curl http://127.0.0.1:6868/__pnds/health
```

A healthy Internal-mode start returns:

```json
{
  "status": "ready",
  "projectId": "inarticulate-iii",
  "audioMode": "internal",
  "audio": {
    "status": "ready",
    "target": "127.0.0.1:57110"
  },
  "scoreServer": {
    "performerPort": 6868,
    "monitorPort": 6869
  }
}
```

`status` can be `starting`, `ready`, `error`, or `stopping`. PNDS App treats `status === "ready"` in the JSON body as the signal that the project can be displayed, rather than just checking that HTTP responds.

## Stopping

Send `SIGINT` or `SIGTERM` to the Node score server, for example with `Ctrl-C` in the terminal. The project will:

1. Stop the Socket.IO clients
2. Free the Internal Synth node and group
3. Close the OSC UDP socket
4. Close the performer and monitor HTTP servers

On success:

```text
[shutdown] complete.
```

`scsynth` is owned by the host — PNDS App, or your terminal when running manually. The score server never kills it.

## Project Structure

```text
.
├── audio/
│   ├── audio-controller.js       # Work-level Internal / External audio semantics
│   └── osc-controller.js         # UDP and OSC request / reply transport
├── public/                       # p5.js visuals and the Socket.IO client
├── supercollider/
│   ├── dev/inarticulate-iii-debug.scd
│   ├── source/inarticulate-iii.scd
│   └── synthdefs/inarticulate-iii.scsyndef
├── test/output-bus.test.js       # Minimal regression check for output bus parsing
├── manifest.json                 # PNDS project runtime configuration
├── server.js                     # Express, Socket.IO, and the runtime lifecycle
└── PROJECT_HANDSOFF.md           # Handoff notes for other environments and AI agents
```

## Audio Conventions

- SynthDef file name: `inarticulate-iii.scsyndef`
- SynthDef internal name: `inarticulateIII`
- Internal group ID: `1000`
- Internal synth node ID: `1001`
- The root group of a bare `scsynth` is `0`. Do not attach the project group to group `1`; that group is normally created by an `sclang` client and does not exist in a bare scsynth.

### Output Bus

This project honours the PNDS V1 output bus contract:

| Running under      | `PNDS_AUDIO_OUTPUT_BUS` | synth `out` | Notes                                                                                     |
| ------------------ | ----------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| PNDS App           | injected by the app     | that value  | The app's master synth reads that private bus, applies master volume, and sends to bus `0` |
| Manual, standalone | unset                   | `0`         | Straight to the hardware, convenient for local debugging                                   |

If the variable is present but is not a non-negative integer, the project fails to start rather than falling back silently.

## Checks

```sh
npm run check
npm test
```

`check` runs a Node syntax check over `server.js`, both audio controllers, and `public/sketch.js`. `test` runs the output bus parsing regression check.

## Further Reading

- [`PROJECT_HANDSOFF.md`](PROJECT_HANDSOFF.md) — the actual on-disk state, constraints, and implementation notes, written for developers and AI agents continuing this work.
- [PNDS App](https://github.com/xO-xN/PNDS-App) — the macOS host application that runs this project, and the PNDS V1 project contract it implements.
