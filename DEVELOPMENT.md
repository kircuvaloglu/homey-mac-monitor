# Development notes

## Overview

Monitors Macs from a Homey Pro. Two parts:

- `agent/` runs on each Mac as a root LaunchDaemon. It reads the sensors,
  serves JSON on port 8787 (token protected) and announces itself over Bonjour
  as `_homeymac._tcp`.
- `app/` is the Homey app (SDK v3). Each device polls its agent every 30 seconds.

```
Homey Pro --HTTP + bearer token--> agent on the Mac --SMC / IOKit--> sensors
          <--------- JSON --------
```

## Design rules

- The agent only reads the SMC. There is no SMC write call (`kSMCWriteKey`) and
  no fan control, and there should never be.
- Apple silicon only (macOS 14 or later), aimed at desktop Macs.
- Restart and shutdown stay disabled unless the user enables them on both sides.

## Macs on several networks

A Mac can have addresses on more than one network (for example separate
VLANs). The address Homey needs is the one on Homey's network, which is not
necessarily the default route. The installer lists all addresses for that
reason. Bonjour discovery may suggest a Wi-Fi address; a wired address is more
stable. A Homey Pro may not answer ping even when HTTP works.

The device setting `info_ip` shows the default route address, which can differ
from the address Homey uses. Cosmetic only.

## Install and deploy

Agent (needs an admin password):

```bash
cd agent && sudo ./install.sh
```

Check the agent:

```bash
curl -s http://127.0.0.1:8787/ping
sudo cat /usr/local/etc/homey-mac-agent/config.json
```

Homey app (must be on the same LAN; the CLI only uses local connections for a
Homey Pro):

```bash
cd app
homey select --id <homey-id>
homey app install
```

Run `homey select --id` first when the CLI is not interactive, otherwise it
crashes on the Homey selection prompt (`homey list` shows the id). Homey rate
limits API calls, so space out repeated installs and API requests.

## Notes

**Sensors**

- `IOHIDEventSystemClient` no longer returns services on macOS 26. Reading the
  SMC directly works and does not need root.
- In `SMCParamStruct` the `key` and `dataType` fields are native little-endian
  `UInt32`. Writing them as big-endian bytes returns `kSMCKeyNotFound` (132).
  Values are big-endian, except `flt`.
- M4 keys: `Tp*` performance cores, `Te*` efficiency cores, `Tg*` GPU, `TH0*` SSD,
  `F0Ac/Mn/Mx` fan, `PSTR` total power.
- The GPU sensor is powered down while the GPU is idle. GPU temperature, fan
  speed and power are optional capabilities: removed if never seen, otherwise
  the last value is kept (`setOptional()` in `app/drivers/mac/device.js`).
- Wake-on-LAN cannot start a Mac that is fully shut down; it only wakes from sleep.

**Agent**

- A `macsensors` binary copied from another Mac is quarantined and unsigned,
  and Gatekeeper kills it. `install.sh` builds it locally when `swiftc` exists,
  and otherwise removes the quarantine flag and signs it ad hoc.
- `softwareupdate -l --no-scan` only reads the local cache. The agent runs a
  real scan every six hours.
- `checkUpdates()` replaces `updateCache`, so `/status?updates=refresh` must
  point the snapshot at the new object.
- Without Local Network permission macOS returns `02:00:00:00:00:00` as the MAC
  address, even through a child `ifconfig`. As a root LaunchDaemon the real
  addresses come through. Wake-on-LAN depends on this.

**Session data**

- The display state belongs to the logged-in user's session. The agent runs
  `macsession` with `launchctl asuser <uid>`, which checks `CGDisplayIsAsleep`.
- Idle time comes from `HIDIdleTime` (`ioreg -c IOHIDSystem`), the lock state from
  `CGSSessionScreenIsLocked` in `IOConsoleUsers` (`ioreg -n Root -d1`).
- Memory pressure is `kern.memorystatus_vm_pressure_level` (1, 2, 4), the thermal
  state is `ProcessInfo.thermalState`, disk health is the SMART status from
  `diskutil info disk0`.
- Time Machine dates are read with `plutil -p` from
  `/Library/Preferences/com.apple.TimeMachine.plist`; `plutil -convert json`
  fails on the date values.
- Network speed is the byte counter delta of the `en*` link rows in `netstat -ibn`.

**Homey pairing view**

These details come from Homey's own `/pair/` page and `/js/homey.drivers.js`;
the documentation does not cover them.

- The view HTML is inserted with jQuery `.html()` into `#hy-views`. The global
  `Homey` object is ready when the `_start` event arrives.
- Do not load `/homey.js` in the view. It replaces `window.Homey` with the
  constructor and breaks the page (`Homey.ready is not a function`).
- Keep the view script inside an IIFE. A global `const $` hides jQuery and
  breaks Homey's own code, and the script runs again when the view is shown
  again.
- `Homey.emit` supports both callbacks and promises.
- `homey api drivers emit-pairing-event --data` sends the data as a string, so
  the `connect` handler also accepts a JSON string. This allows testing the
  pairing backend from the command line.
- A faithful local test setup is possible: Homey's pair page, CSS and JS served
  locally, with the CrossFrame calls stubbed.

**Homey app**

- Homey creates Flow cards for standard capabilities (temperature, power, heat
  alarm), so the app does not define its own versions of those.
- Card ids on a device are `homey:device:<device-id>:<card-id>`. In zsh write
  `"${U}:wake"`, not `"$U:wake"`: `:w`, `:r`, `:a` etc. are variable modifiers.
- Homey refuses to run Flow actions on an unavailable device ("This device is
  currently unavailable"). An unreachable Mac is therefore kept available and
  shown with `setWarning()`, so Wake-on-LAN still works while it sleeps.
- `registerArgumentAutocompleteListener(name, listener)` needs the argument name;
  without it the driver fails to start and devices show "App Unavailable".
- `homey app run` removes the app from Homey when it exits, which deletes the
  paired devices. Use `homey app install` on a Homey with real devices.
- Flow cards can be tested from the CLI:
  `homey api flow run-flow-card-action --uri homey:device:<id> --id homey:device:<id>:<card> --args '{}'`.
- Actions that the Mac cannot run must throw, so the Flow shows an error. The
  agent returns HTTP 400 with an explanation, which the app passes through.

- Widgets require firmware 12.1.0 or later, so keep `compatibility` at that
  level.
- The widget sets its own height with `Homey.setHeight()` after each render; dark
  mode is signalled by the `.homey-dark-mode` class.
- The widget refresh button calls `POST /refresh`, which runs `device.poll()`.
- `homey app publish` only uploads a build; testing and certification are
  separate steps in Developer Tools.
- The app uses `.homeycompose`. The root `app.json` is generated; do not edit it.
- App image, driver image, icons and widget previews are generated by the scripts
  in `tools/` (need Pillow and resvg-py). The app image is a scene, the driver image
  is the device on white, and the icons are line drawings without gradients, as the
  App Store guidelines require. Images must not show Homey devices or logos.

## Links

- Homey Developer Tools: https://tools.developer.homey.app
- Homey Apps SDK: https://apps.developer.homey.app
- Setup and HTTP API: [README.md](README.md)

## Files

```
homey-mac-monitor/
├── CHANGELOG.md             release notes
├── DEVELOPMENT.md           this file
├── README.md                setup, architecture, HTTP API
├── agent/                   Mac side
│   ├── agent.js             HTTP service, polling, action table
│   ├── install.sh           LaunchDaemon install, token generation
│   ├── uninstall.sh
│   ├── build.sh             builds the bundled sensor reader
│   ├── macsensors           compiled sensor reader (arm64)
│   ├── macsession           compiled session reader (arm64)
│   └── src/                 Swift sources of both helpers
├── LICENSE
├── app/                     Homey app (SDK v3)
│   ├── .homeycompose/       app manifest, capabilities, discovery
│   ├── drivers/mac/         driver, device, Flow cards, pairing view
│   ├── widgets/macs/        widget manifest, API, view, previews
│   └── lib/agent-api.js
└── tools/                   image generators
```
