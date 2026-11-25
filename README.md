# Axiscope

Camera-assisted XY tool alignment for [Bondtech INDX](https://github.com/BondtechAB/INDX) printers. Center each nozzle in the crosshair and INDX saves the offset. This is the [nozzle camera method](https://github.com/BondtechAB/INDX#method-3-nozzle-camera-most-precise-xy-higher-cost) from the INDX docs, as a guided web page.

## Table of Contents

- [Hardware](#hardware)
- [Running Axiscope](#running-axiscope)
  - [On your computer](#on-your-computer)
  - [On the printer](#on-the-printer)
- [Moonraker CORS](#moonraker-cors)
- [Usage Guide](#usage-guide)
  - [Auto center](#auto-center)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Credits](#credits)
- [License](#license)

## Hardware

| Option | Details |
|---|---|
| **DIY** | [XY Nozzle Alignment Camera](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera) (3D printed parts) + OV9726 camera module + 4x 5V 3mm round white (6000-6500K) LEDs |
| **Pre-assembled** | [Ember Prototypes CXC](https://www.emberprototypes.com/products/cxc) |

The camera can be connected to the printer (Crowsnest) or to the computer that runs the browser.

## Running Axiscope

**Prerequisites:** Klipper with the [INDX macros](https://github.com/BondtechAB/INDX) (docks calibrated) and Moonraker.

Axiscope is a static web page. There is nothing to install on the printer.

### On your computer

```bash
git clone https://github.com/nic335/Axiscope.git
cd Axiscope
python -m http.server 3000
```

Open `http://localhost:3000` and enter the printer address in the dialog.

This is the only way to use a camera plugged into your computer: browsers only allow camera access on `https` or `localhost`. Printer cameras work too. Moonraker must allow the `localhost` origin, see [Moonraker CORS](#moonraker-cors).

### On the printer

Build one HTML file and let the printer's web server host it next to Mainsail:

```bash
python3 build.py
scp dist/axiscope.html pi@<your-printer>:~/mainsail/
```

Open `http://<your-printer>/axiscope.html`. The page talks to Moonraker through Mainsail's web server, so no CORS change is needed.

- Over plain `http` the browser blocks local cameras, so only printer cameras work.
- A Mainsail update can replace the `~/mainsail` folder. Copy the file again after updating.

jQuery and Bootstrap load from their CDNs, so the browser needs internet access in both cases.

## Moonraker CORS

When the page is not served by the printer itself (e.g. from `localhost`), Moonraker must allow its origin in `moonraker.conf`:

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

1. Open Axiscope, see [Running Axiscope](#running-axiscope)
2. Enter the printer address and connect. Axiscope checks for the INDX calibration macros.
3. Select the camera

The right panel guides you through every tool. It uses the INDX macros, so the offsets are stored by INDX in `save_variables` (`t{n}_offset_x` / `t{n}_offset_y`) and applied on the next tool pickup.

1. **Prepare:** home the printer. The docks must be calibrated.
2. **T0:** pick up T0, center it in the crosshair, save it as camera reference (`CAL_ONE_SET_CAMERA_REF`).
3. **T1 to Tn:** for each tool, pick it up and move it to the camera (`CAL_TWO_PREP_TOOL_CAL TOOL=n`), center it, save the offset (`CAL_THREE_SAVE_XY_OFFSET`). The guide shows the live offset while you jog.
4. **Done:** check all offsets, then run `CAL_Z` for the Z offsets.

The tool count comes from `tool_count` in `[gcode_macro TOOL_POSITIONS]`. You can click any step to redo it. If you change the T0 reference, redo every tool.

### Auto center

Axiscope finds the nozzle hole in the camera image and can move the head until the hole sits in the crosshair. The detected hole is drawn green, the nozzle face yellow.

1. With a tool over the camera and the hole detected, press **Calibrate camera** once. It moves 0.5 mm in X and Y to learn the scale and rotation of the camera. Redo it when the camera, its position or its resolution changes.
2. Press **Auto center**. It moves in small steps until the hole is less than 0.005 mm off. Each move ends from the same side, so backlash is the same every time. **Stop** ends it before the next move. If a move does not bring the hole closer, for example because the camera was rotated after calibration, it stops and asks you to calibrate again.
3. Save the position in the guide as usual.

The hole is found by its round outline, not its color, so empty, dark and white filled holes all work. It must sit inside the nozzle face and most of its outline must be visible. If not, Axiscope reports no hole and does not move. Tips:

- An empty, clean hole gives the best result. Unload the filament first (`CAL_Z` needs that anyway).
- Avoid overexposure: white filament that turns pure white can merge with ooze on the nozzle face.
- The readout below the switch shows the offset in pixels and how much of the hole outline was found.

Auto center needs to read the camera pixels. This works for local cameras and for printer cameras when the page is served by the printer. A printer stream opened from another origin cannot be read by the browser.

## Troubleshooting & FAQ

### Camera doesn't show up in Axiscope

For a printer camera, make sure it is configured in both Crowsnest and Mainsail:

- [Configuring a camera in Crowsnest](https://mellow.klipper.cn/en/docs/DebugDoc/BasicTutorial/camera/)
- [Configuring the camera in Mainsail](https://docs.mainsail.xyz/settings/webcams)

For a local camera, run Axiscope [on your computer](#on-your-computer).

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
