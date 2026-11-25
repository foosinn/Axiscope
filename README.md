# Axiscope

Camera-assisted XY tool alignment for [Bondtech INDX](https://github.com/BondtechAB/INDX) printers. Center each nozzle in the crosshair and INDX saves the offset. This is the [nozzle camera method](https://github.com/BondtechAB/INDX#method-3-nozzle-camera-most-precise-xy-higher-cost) from the INDX docs, as a guided web page.

## Table of Contents

- [Hardware](#hardware)
- [Installation](#installation)
- [Local Camera](#local-camera)
- [Remote Access (Hostname/Moonraker)](#remote-access-hostnamemoonraker)
- [Usage Guide](#usage-guide)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Credits](#credits)
- [License](#license)

## Hardware

| Option | Details |
|---|---|
| **DIY** | [XY Nozzle Alignment Camera](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera) (3D printed parts) + OV9726 camera module + 4x 5V 3mm round white (6000-6500K) LEDs |
| **Pre-assembled** | [Ember Prototypes CXC](https://www.emberprototypes.com/products/cxc) |

The camera can be connected to the printer (Crowsnest) or to the computer that runs the browser.

## Installation

**Prerequisites:**

- Klipper with the [INDX macros](https://github.com/BondtechAB/INDX), docks calibrated
- Moonraker
- SSH access to your printer

**Install on the printer:**

```bash
curl -sSL https://raw.githubusercontent.com/nic335/Axiscope/refs/heads/main/install.sh | bash
```

This script creates a Python virtual environment, sets up the `axiscope` systemd service and adds it to Moonraker.

**Start the service:**

1. Open Mainsail
2. Go to **Klipper → Service → Host Control** and find `axiscope`
3. Use the Start/Stop button

<img style="padding-bottom: 10px;" src="media/ServiceControl.png" alt="Service control" width="250"/><br/>

## Local Camera

After you connect to the printer, the camera list shows the printer cameras and the local cameras (marked with `Local:`). The browser asks once for camera access.

Browsers only allow camera access on `https` or `localhost`. When you open `http://<your-printer-ip>:3000`, local cameras are not listed. Run Axiscope on your computer instead and enter the printer IP in the dialog:

```bash
git clone https://github.com/nic335/Axiscope.git
cd Axiscope
python -m http.server 3000
```

Then open `http://localhost:3000`. Moonraker must allow this origin, see `*://localhost:*` below.

## Remote Access (Hostname/Moonraker)

If you connect using a hostname (e.g. `voron.local:3000`) or from `localhost`, add the origins to `moonraker.conf`:

```ini
[authorization]
trusted_clients:
    192.168.0.0/16
    10.0.0.0/8
    127.0.0.0/8
    169.254.0.0/16
    172.16.0.0/12
    FE80::/10
    ::1/128
cors_domains:
    *.lan
    *.local
    *.local:*
    *://localhost
    *://localhost:*
    *://my.mainsail.xyz
    *://app.fluidd.xyz
```

## Usage Guide

1. Open `http://<your-printer-ip>:3000` (or `http://localhost:3000` for a local camera)
2. Enter the printer address and connect. Axiscope checks for the INDX calibration macros.
3. Select the camera

The right panel guides you through every tool. It uses the INDX macros, so the offsets are stored by INDX in `save_variables` (`t{n}_offset_x` / `t{n}_offset_y`) and applied on the next tool pickup.

1. **Prepare:** home the printer. The docks must be calibrated.
2. **T0:** pick up T0, center it in the crosshair, save it as camera reference (`CAL_ONE_SET_CAMERA_REF`).
3. **T1 to Tn:** for each tool, pick it up and move it to the camera (`CAL_TWO_PREP_TOOL_CAL TOOL=n`), center it, save the offset (`CAL_THREE_SAVE_XY_OFFSET`). The guide shows the live offset while you jog.
4. **Done:** check all offsets, then run `CAL_Z` for the Z offsets.

The tool count comes from `tool_count` in `[gcode_macro TOOL_POSITIONS]`. You can click any step to redo it. If you change the T0 reference, redo every tool.

## Troubleshooting & FAQ

### Camera doesn't show up in Axiscope

For a printer camera, make sure it is configured in both Crowsnest and Mainsail:

- [Configuring a camera in Crowsnest](https://mellow.klipper.cn/en/docs/DebugDoc/BasicTutorial/camera/)
- [Configuring the camera in Mainsail](https://docs.mainsail.xyz/settings/webcams)

For a local camera, see [Local Camera](#local-camera).

### Camera only loads if plugged in before boot

Some cameras aren't auto-detected by Crowsnest if plugged in after boot. Restart the Crowsnest service instead of rebooting the whole printer.

## Credits

[Nic335](https://github.com/nic335) and [N3MI-DG](https://github.com/N3MI-DG)

## License

MIT License — see [LICENSE](LICENSE) or the full text below.

<details>
<summary>MIT License text</summary>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

</details>
