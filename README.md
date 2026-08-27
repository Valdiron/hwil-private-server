# HW Infinite Loop private server and replacement data

Version 0.6.0 adds a room-based JSON race relay for matchmaking, player presence, movement,
rotation, and nitro state. It shares the same Render HTTP listener instead of opening a second
public port. The original client's five-byte binary RPC framing and `/api` bootstrap remain intact.

This is a clean-room private-server foundation, replacement content pack, and protocol diagnostic
gateway for the user-supplied Hot Wheels Infinite Loop `1.35.0` APK. It contains no Mattel or
Creative Mobile assets.

> Status: the server, binary bootstrap, offline-race start response, and JSON multiplayer relay are
> covered by automated tests. The original Unity race transport is binary rather than this clean-room
> JSON protocol, so device captures are still required before claiming original-client multiplayer
> compatibility.

## What works

- local profile creation and authentication (`profileId` + `profileSecret`)
- signed session tokens
- profile persistence in `data/state.json`
- configuration and server time
- local matchmaking tickets
- WebSocket JSON RPC at `/ws` and `/rpc`
- JSON race matchmaking and movement relay at `/race`, `/ws`, and `/rpc`
- safe inspection of unknown binary WebSocket frames
- UDP discovery and diagnostic listener
- clean-room vehicle, track, progression, profile, and localization data
- replacement `NetworkSettings` and `UNetwork` JSON schemas
- hashed content manifest and structural Android OBB
- content delivery at `/v1/content/manifest` and `/content/*`
- Docker deployment and graceful shutdown

See [docs/APK_ANALYSIS.md](docs/APK_ANALYSIS.md) for the APK findings and
[docs/ROADMAP.md](docs/ROADMAP.md) for the compatibility plan.

## Run with Docker

```bash
cp .env.example .env
```

Change `TOKEN_SECRET` to a long random value and set `PUBLIC_HOST` to the IP or hostname reachable by
the Android device. Then run:

```bash
docker compose up --build -d
curl http://127.0.0.1:8080/health
```

Expose TCP `8080` for HTTP/WebSocket and UDP `7777` for race diagnostics.

## Deploy on Render

1. Push this folder to a GitHub, GitLab, or Bitbucket repository.
2. In Render, create a new Blueprint and select the repository.
3. Render reads `render.yaml`, generates `TOKEN_SECRET`, mounts persistent profile storage, and
   checks `/health` before marking the service healthy.

The public Render service supports HTTP and WebSocket. Render does not expose the UDP diagnostic
port; use Docker on a VPS or local network when UDP capture is required.

## Run with Node.js 22+

```bash
npm ci
npm run build:data
TOKEN_SECRET='replace-this-with-a-long-random-secret' npm start
```

Run the validation suite with:

```bash
npm test
```

## Replacement data

The generated Android tree is under `replacement-data/build/Android`. It includes:

- `Android/data/com.mattel.HWInfiniteLoop/files/private-content`
- `Android/obb/com.mattel.HWInfiniteLoop/main.378.com.mattel.HWInfiniteLoop.obb`

Every source JSON is listed with its size and SHA-256 digest in `manifest.json`. Before testing on a
physical phone, replace `127.0.0.1` in `config/networksettings.json` with the private server address
reachable by that device and rebuild the pack.

## First profile

Create a local profile:

```bash
curl -s http://127.0.0.1:8080/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"displayName":"Junior"}'
```

The response contains `profileSecret` only for the new identity. Keep it private.

## Clean-room JSON RPC

Connect to `ws://SERVER:8080/rpc`, receive the hello message, then send:

```json
{"id":1,"method":"time","params":{}}
```

Supported method aliases include `Auth`, `GetConfig`, `GetProfile`, `SaveProfile`,
`StartRaceSearch`, `StopRaceSearch`, and `GetGameliftEndpoints`. These aliases help organize the
compatibility work but do not claim that the original binary RPC envelope is already implemented.

## JSON multiplayer relay

Connect two or more clients to `ws://SERVER:8080/race`. Join the shared room with:

```json
{"type":"JOIN_MATCH","carId":"car_twin_mill"}
```

The server returns `MATCH_FOUND` with a stable connection player ID. Send movement with:

```json
{
  "type":"UPDATE_POSITION",
  "position":{"x":0,"y":0,"z":0},
  "rotation":{"x":0,"y":0,"z":0,"w":1},
  "isBoosting":false
}
```

Other players in `room_1` receive `OPPONENT_MOVE`; the sender does not receive its own movement.
Disconnects produce `PLAYER_LEFT`. Input vectors and car IDs are validated, and all public WebSocket
traffic uses the same Render `PORT` listener.

## Diagnostic binary capture

Binary WebSocket frames are fingerprinted in structured logs. To save raw frames locally for
clean-room interoperability analysis, set `CAPTURE_BINARY_FRAMES=true`. Captures are written with
restricted permissions under `data/captures/`. Do this only on a private test instance.

## Important limits

This repository contains no proprietary Unity assets. A user-provided APK/OBB can be patched and
distributed separately, but it must still speak the implemented server protocol. The JSON race relay
is intended for a clean-room client or a later client patch; the untouched original race transport is
not JSON. Do not expose the server with the default secret.
