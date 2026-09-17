Monitor and control your Macs from Homey.

Mac Monitor adds your Macs to Homey as devices. It shows CPU and GPU
temperature, CPU usage, memory, disk space, fan speed, power draw, uptime and
pending macOS updates, and lets Flows put a Mac to sleep, wake it, lock it or
restart it. Everything stays on your local network.

FEATURES

- Live readings with Insights history.
- Flow triggers for CPU usage, memory, disk space, fan speed, macOS updates,
  restarts and the Mac going offline or coming back.
- Flow conditions for reachability, temperature, CPU usage, memory, disk space,
  fan speed, power draw and pending updates.
- Flow actions to sleep, wake (Wake-on-LAN), turn off the display, lock the
  screen, show a notification, run a command, check for updates, restart and
  shut down. Restart and shut down are off until you allow them.
- A dashboard widget with a card for every Mac.
- Device settings with model, serial number, macOS version, processor, memory,
  IP address, MAC address and boot time.

REQUIREMENTS

- A Mac with Apple silicon (M1 or later) running macOS 14 or later.
- Node.js 18 or later on the Mac (nodejs.org or Homebrew).
- A Homey Pro on the same local network as your Macs.

SETUP

1. Install the Mac Monitor agent on each Mac. Open Terminal and run:
   curl -fsSL https://raw.githubusercontent.com/kircuvaloglu/homey-mac-monitor/main/agent/get.sh | sudo bash
   The installer prints an access token.
2. In Homey, add a device: Mac Monitor, Mac. Select your Mac and enter the token.

Full guide: https://github.com/kircuvaloglu/homey-mac-monitor

NOTES

- Sensors are read only. The app never changes fan settings.
- The GPU sensor is only active while the GPU is in use, so
  the GPU temperature appears after the first reading and then keeps its last
  value. Fanless Macs do not show a fan speed.
- macOS updates are checked every six hours.
- A sleeping Mac can be woken up, but a Mac that is fully shut down cannot be
  turned on remotely.
