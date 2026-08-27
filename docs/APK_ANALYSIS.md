# APK analysis: `com.mattel.HWInfiniteLoop`

This document records clean-room interoperability observations from the APK supplied by the user.
It does not include or redistribute game assets.

## Fingerprint

- Package: `com.mattel.HWInfiniteLoop`
- Product: Hot Wheels Infinite Loop
- Version: `1.35.0` (`versionCode 378`)
- Engine: Unity `2019.4.27f1`
- Scripting backend: IL2CPP
- Architectures: ARMv7 and ARM64
- APK SHA-256: `20467bb7505b0a9b53012e738a0bfc663f352db4004cfdd35a0c8ddac7218399`

## Network observations

The IL2CPP metadata contains the following client-side implementation evidence:

- `NetworkServiceManager.CreateWebSocketAndConnect`
- authentication states ending in `ConnectedAuthenticated`
- Apache Thrift compact helpers: `WriteCompactThrift` and `ReadCompactThrift`
- request/response models including `TAuthRequest`, `TAuthResponse`, `TGetConfigRequest`,
  `TSyncRequest`, `TSaveRequest`, `TStartRaceSearchRequest`, and `TGameLiftEndPointResponse`
- Unity UNet race transport and UDP-oriented game server code
- AWS GameLift session and endpoint models

The `TRpcMethod` metadata also confirms the core numeric identifiers used by the gateway, including
`registration=0`, `auth=1`, `sync=2`, `save=3`, `get_time=73`, `offline_start_race=102`,
`online_races_enabled=119`, `start_league_race=120`, `get_config=128`, and `get_profile=153`.
Knowing the identifiers does not by itself define each complete Thrift response structure.

The Android network security configuration allows clear-text traffic and does not expose a
certificate-pinning rule in the manifest configuration. This should permit a test build to point at
a private HTTP/WebSocket endpoint once the serialized network settings are recovered.

## Missing external data

The APK is a bootstrap package. It includes only build scene `0` (`Init`) and code, while its build
settings name 22 scenes in total. The other 21 scene files and thousands of external objects are not
present. Important missing objects include:

- `networksettings` -> external asset `c482258c6c2335a4d80a56814f14756f`
- `unetwork` -> external asset `f12ef0cf4d36bfc479f334745035182e`
- localization resources
- car visual settings
- tracks, scenes, prefabs, sound banks, and other AssetBundles

Consequently, the APK alone cannot become a playable build. Version 0.2 supplies new JSON data and a
structural OBB, but the untouched Unity client cannot interpret them as replacements for its missing
serialized objects and scenes.

## Scope of version 0.2

The included server implements a safe clean-room foundation, binary diagnostic gateway, and content
server. The replacement pack contains only newly authored configuration and gameplay data. It is not
yet wire-compatible with the original production client. Unknown binary WebSocket and UDP frames are
fingerprinted for analysis; arbitrary UDP traffic is never reflected.
