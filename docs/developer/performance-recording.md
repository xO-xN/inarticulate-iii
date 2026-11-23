# PNDS recording adapter protocol 1

Implemented for PNDS App issue #257 on 2026-11-03. This project opts in with root `pnds.recording.json`; the existing performance works without an App recording operation. Do not infer recording capability from ordinary health or performer roster data.

The App calls loopback-only `GET|POST /__pnds/recording`. The endpoint rejects browser Origin headers and non-loopback access, accepts JSON requests up to 16 MiB, and serializes begin/poll/drive/end operations. The adapter retains accepted musical changes losslessly for the active operation, stamps integer monotonic milliseconds at the effective work handler, and assigns deterministic sequence order. It does not save recordings to the project. App owns durable records, provenance/compatibility, publication, common duration and playback scheduling.

`begin` takes `operationId`, mode `record` / `playback` / `overdub`, and for playback/overdub the saved `initialState` plus `replayPerformers`. The App supplies `livePassId` for recording and overdub; every response for that active operation echoes it as `passId`, so an older single-source adapter cannot silently satisfy a pass recording request. Capture snapshots the current work without START/reset. Replay/overdub releases old controls, restores saved state, establishes independent replay sources, and blocks live conducting at the effective server entry. Pure playback admits no live musical input.

A pass includes every live source accepted by the work, including sources that join after recording begins. An overdub maps each physical source to its own fresh recorded identity for this pass; reconnecting the same source retains that identity, and reusing the device in another pass gets a new one. Existing online sources emit time-zero join events, so fresh recorded identities have explicit initial membership even though they are absent from the original snapshot. Membership changes during restore also use time zero, before the new pass clock starts. App manages and replaces whole passes; work-side replay receives only the retained `replayPerformers` and their events. The project keeps its original selection/admission policy; App does not add a readiness step.

For compatibility, callers omitting `livePassId` may still use the older `livePerformerId` overdub API. Only that legacy path binds one recently registered online source. The current App uses pass recording and verifies the echoed `passId` on begin, poll and end.

`poll` returns events after `afterSequence`, current captured performers, and elapsedMs. `drive` receives elapsedMs and already ordered due events; it applies replay directly to the real work path without recording them again. Event sequence IDs remain unique but can be nonmonotonic after chronological overdub merge; replay deduplicates by sequence identity. `end` returns the final changes. Ordinary recording uses release:false and leaves live performance running. Replay/overdub use release:true, release their sources and unlock conducting. An early saved overdub emits an explicit release event for each recorded source at its end boundary, so its old held states cannot return in the remaining common duration. Stale operation identities and competing begins are rejected.

Recorded source IDs contain no claim tokens. Physical recovery identity, recorded performer identity and score number are separate. Each repeated hold input is retained; equal values are not deduplicated. Playback sources have distinct runtime keys from physical sockets.

III snapshots active points, all initial selections and pair-stroke controls. Playback restores points through the existing audio gates/positions and applies recorded distance-derived pair controls, rather than replaying visual points alone. Live overdubs still receive replay point broadcasts and can compute their interactive lines. The original exclusive 1/2/3 selection policy remains, including replay occupants. A creator can click the performer-number badge to choose another free role on the same connection; cancelling keeps the current role and claim. When a reused device still displays a role already occupied by replay, its new pass starts with null membership until the creator selects a free role. Null join/selection events do not claim or release another source's slot, and replay allows metadata for sources that remained unselected. Filtering out a pass also filters its initial snapshot membership and points through the retained recorded identities.

Checks: `npm run check` and `npm test`; real isolated HTTP/WebSocket tests in `test/recording.test.js` verify ordinary-stop behavior, accepted point and pair outputs, playback exclusion and three independent passes with one physical device, multi-device passes, late joins, merged replay and replay after removing the original pass. `test/performer-selection.test.js` exercises the real browser sketch's role-change handler, connection reuse and cancellation. Audio-control events are observable evidence, not proof of audible native output.

Native acceptance remains pending: use the actual updated App and devices to listen to III's three-pass distance interaction and Runes' restored random score, delayed START, pause/seek, same-number holds and release. Repository checks and network control output do not establish audible or macOS platform acceptance. No remote release or `.pnds` publication was performed.


Replay membership follows the saved initial membership plus ordered join/selection/
leave events. Distinct historical performers may reuse a slot after departure;
final performer metadata does not imply simultaneous membership. Each effective
audio slot belongs to its current runtime socket object, separate from physical
claims and recorded identity. Live watching/overdub devices cannot release or write
another owner through point, stroke, selection, disconnect or takeover. Delayed
release retries recheck ownership, and displaced reconnect transports cannot mark
the current same-identity source offline. Recording regressions observe real OSC
gates in External mode as well as score display events.
