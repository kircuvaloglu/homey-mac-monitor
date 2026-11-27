# Changelog

## 1.7.0

### Added

- GPU usage, with a threshold trigger and a condition
- Internet access and latency, measured by the Mac, with triggers when the
  internet goes down or comes back and when the latency rises above a value, and
  a condition for whether the internet is reachable
- Triggers for when a chosen app or background process starts or stops. Only
  the apps used in these Flows are checked
- Agent version in the device settings, and a notification when a Mac runs an
  older agent

### Fixed

- A Mac with both Ethernet and Wi-Fi could stay unreachable when the address in
  use stopped answering. The addresses of its network ports are now tried as
  well, and the first one where the same Mac answers is kept

### Agent

- GPU usage from the graphics processor's own statistics
- Internet check every 30 seconds: a TCP connection to two public DNS resolvers
  (1.1.1.1 and 8.8.8.8) that is opened and closed again, without sending data.
  The Mac counts as offline after two failed checks in a row. Set
  `"internetCheck": false` in `config.json` to turn it off
- `GET /status?watch=Name,Other` adds whether those apps or processes are running

Install the new agent on each Mac with the same command as before; the existing
token is kept.

## 1.6.0

### Fixed

- Capability icons, the app icon and the device icon were drawn with strokes.
  Homey fills every shape in an icon, so the closed ones arrived as solid
  blocks. All icons are now drawn as filled outlines
- A Mac that is given another address is found again automatically, instead of
  staying unreachable until it is repaired by hand. The known address is only
  replaced once it stops answering and the new one does answer

### Changed

- Adding a Mac points out an agent that answers on a network the Homey cannot
  reach, and fills in the address when a single Mac is found
- Icons are drawn by the new `tools/make-icons.py`

## 1.5.2

- Pairing screen and widget build their content with DOM elements instead of
  HTML strings
- Shorter App Store text, a tagline, photos instead of illustrations and
  text-free widget previews

## 1.5.0

### Added

- Idle time, with Flow cards for "the Mac has been idle for" and "someone starts
  using the Mac again"
- Screen lock and display state, with triggers and conditions
- Download and upload speed, with threshold triggers
- Memory pressure (normal, warning, critical) and thermal state, with triggers on
  change and a memory pressure condition
- Disk health from the SMART status, with a trigger when the disk reports a problem
- Last Time Machine backup, with triggers when a backup finishes or is overdue,
  and a condition for the backup age
- External drives, with triggers when a drive is connected or disconnected and a
  condition for a specific drive
- Condition to check whether an app is running
- Actions to keep the Mac awake, allow it to sleep again and speak text
- Busiest process as a token on the CPU usage trigger
- Download speed tile and idle and lock status in the widget
- Link to the Homey Community topic

### Agent

- New `macsession` helper for the display state
- New `GET /processes` endpoint
- New actions: `say`, `keepawake`, `allowsleep`
- The installer allows Node.js through the macOS firewall when it is on

Install the new agent on each Mac with the same command as before; the existing
token is kept.

## 1.0.0

First release.

- CPU and GPU temperature, CPU usage, load per core, memory usage, free disk
  space, disk usage, fan speed, power draw, uptime, pending macOS updates and
  thermal throttling
- Flow cards to react to these values
- Actions to sleep, wake (Wake-on-LAN), turn off the display, lock the screen,
  show a notification, run a command, refresh, check for updates, restart and
  shut down
- Dashboard widget
