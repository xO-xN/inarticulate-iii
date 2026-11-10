# Inarticulate III 1.4.0 / PNDS App 1.6.2 adaptation

The installable project uses manifest schema 2 and these exact App shared
package references. PNDS App 1.6.2 or newer validates and supplies their
installed entries; the project never downloads packages at performance time.

| Package | Version | Use |
| --- | --- | --- |
| p5 | 2.3.4 | Score canvas and performer graphics |
| express | 5.3.0 | Performer and monitor HTTP servers |
| qrcode | 1.5.4 | Monitor performer QR code |
| socket.io | 4.8.4 | Performer controls, monitor and projection state |
| osc-min | 2.1.2 | Internal scsynth commands and External OSC transport |

`lib/shared-libraries.js` consumes `PNDS_SHARED_LIBRARIES` only for the
references declared in `manifest.json`. A supplied map must have the exact
version, kind, and existing absolute entry file for each reference. An invalid
Host map stops startup even if local npm packages are available. The Host
performs catalog and SHA-256 validation before injecting the map.

The two HTTP origins serve only the declared p5 and Socket.IO browser files
at `/__pnds/shared/p5.js` and `/__pnds/shared/socket.io.js`. No catalog,
package directory, or general filesystem route is exposed. Score images,
compiled synthdefs, SuperCollider source/debug bridges and source modules
remain project assets. Their musical mappings are unchanged.

For standalone development, use Node 24 and `npm ci`, then `npm run check`
and `npm test`. Without a Host map the loader requires this project's actual
local package metadata to match every fixed version. A wrong or missing
package reports its required version and asks for `npm ci`; startup never
chooses another version. `scripts/shared-env.cjs` is a development/CI helper
that emits a map for these exact locally installed packages.

`PNDS_PERFORMER_URL`, when supplied by the Host, is the complete HTTP or
HTTPS performer address used by the QR code, startup log and page config.
Without it, the address remains `http://<Host LAN IP>:<performerPort>/`.
The `/__config.js` response explicitly declares `role: "performer"` or
`role: "monitor"` for its serving origin; an HTTPS performer page need not
have the local performer port in its browser location. TLS and DNS are Host
responsibilities; the project still owns its two local HTTP listeners.

This work uses touch controls and does not declare `needsHttps: true`. Its
normal App entry and QR remain HTTP, including when the global HTTPS switch
is enabled. `supportsPerformerUrl: true` declares URL compatibility only.
The App selects HTTPS only for works explicitly requiring secure-context
APIs; this server always consumes the Host-selected URL when supplied.

osc-min 2 is an ESM package, imported asynchronously when the transport
starts. Its encoded DataView becomes a Buffer using `byteOffset` and
`byteLength` before UDP transmission. Independent OSC 1.0 packet literals
verify the work's `/p2xy` float arguments, `/sync` integer and `/synced`
reply through real UDP sockets. None mode does not open OSC transports.

The packaging workflow installs dependencies for CI checks and produces a
temporary CI Host map outside the bundle. The `.pnds` carries fixed shared
references, project source and assets, with no local `node_modules` or
copied App package payloads. The original bundle layout and exclusions
remain in effect. Packaging and native performance acceptance are separate
from publishing a release.

Runtime tests copy the project into a temporary directory and select
ephemeral ports. They verify shared-only startup, complete URL/QR, exact
same-origin browser files, bad-map rejection, standalone compatibility,
listener collision cleanup, player/projection behavior and prompt SIGTERM
with live clients. They do not require stopping an existing 6868/6869 dev
server. Actual browser canvas, phone HTTPS, physical audio and projection
window verification must also be performed before release.

For the #218 closeout, the author directly confirmed that real-device testing
passed. This records the author's overall acceptance without inventing device
models or per-mode operations. The work's normal entry remains HTTP; the
controlled HTTPS test demonstrates URL compatibility separately.
