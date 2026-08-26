# Compatibility roadmap

## Completed in 0.1

- Persistent local profile identities using `profileId` and `profileSecret`
- Signed authentication tokens
- Profile load/save operations
- Configuration and server-time responses
- Local matchmaking tickets and endpoint discovery
- WebSocket diagnostic gateway
- Apache Thrift compact-message header inspection
- UDP diagnostic listener with safe, explicit discovery response
- Container deployment and automated tests

## Completed in 0.2

- Clean-room replacements for `NetworkSettings` and `UNetwork`
- New vehicle, track geometry, progression, localization, and default-profile data
- GUID mapping for the two critical missing Unity objects
- Inventory of all 22 build scenes, including the 21 absent from the APK
- Reproducible Android data tree and structural OBB builder
- SHA-256 content manifest
- HTTP content delivery with ETags and path-containment checks
- Automated content-integrity and OBB-container tests

## Next: client compatibility bridge

1. Replace or hook the IL2CPP resource loader so the client reads the clean-room JSON objects.
2. Build new Unity scenes, models, materials, UI prefabs, and sound banks without original assets.
3. Point the bridged client at the diagnostic WebSocket endpoint.
4. Capture or define the authentication, sync, config, and profile binary frames.
5. Finish the clean-room Thrift schemas and compatible response serialization.
6. Implement the clean-room UDP race packet registry and simulation.
7. Test startup, authentication, training, garage, offline races, and multiplayer in that order.

If an original OBB or legitimate backup becomes available, it can be analyzed separately for exact
interoperability without adding its proprietary content to this clean-room package.

## Hosting note

The HTTP/WebSocket endpoint can run behind a reverse proxy. Multiplayer race transport requires a
host that exposes UDP directly; many HTTP-only application platforms cannot provide that port. A VPS
or dedicated container host is the appropriate final target.
