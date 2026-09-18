# Changelog

## 1.5.1

- Pairing screen builds its list with DOM elements instead of HTML strings
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
