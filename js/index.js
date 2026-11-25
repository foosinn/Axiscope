let printerIp = '';
let updateInterval = null;
let selectedCamera = null;
let lastStatus = null;

function printerUrl(ip, endpoint) {
    ip = ip.replace(/^https?:\/\//, '');
    return `http://${ip}${endpoint}`;
}

function gcodeUrl(script) {
    return printerUrl(printerIp, '/printer/gcode/script?script=' + encodeURIComponent(script));
}

function isValidIP(input) {
    input = input.trim().replace(/^https?:\/\//, '');
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:[0-9]+)?$/.test(input);
}

function showModalMessage(text, ok) {
    $('#ipError').toggleClass('text-success', ok).toggleClass('text-danger', !ok).text(text).show();
}

function updatePage() {
    $.get(printerUrl(printerIp, '/printer/objects/query?gcode_move&toolhead&quad_gantry_level&stepper_enable&' + INDX_QUERY), function(data) {
        const status = data.result.status;
        lastStatus = status;
        const pos = status.gcode_move.gcode_position;
        const homed = status.toolhead.homed_axes === 'xyz';

        $('#pos-x').text(pos[0].toFixed(3));
        $('#pos-y').text(pos[1].toFixed(3));
        $('#pos-z').text(pos[2].toFixed(3));

        setButtonState('#home-all', homed, 'btn-danger');
        setButtonState('.home-axis', homed, 'btn-dark');
        setButtonState('#qgl', status.quad_gantry_level && status.quad_gantry_level.applied, 'btn-danger');
        setButtonState('#disable-motors', Object.values(status.stepper_enable.steppers).some(on => on), 'btn-danger');

        updateIndxGuide(status);
    });
}

function setButtonState(selector, ok, offClass) {
    $(selector).toggleClass('btn-primary', !!ok).toggleClass(offClass, !ok);
}

// Overshoot by 0.5 mm and come back, so every jog ends from the same direction.
function bounceScript(axis, value) {
    const overshoot = value > 0 ? 0.5 : -0.5;
    return [
        'SAVE_GCODE_STATE NAME=bounce_move',
        'G91',
        `G0 ${axis}${(value + overshoot).toFixed(3)} F500`,
        `G0 ${axis}${(-overshoot).toFixed(3)} F500`,
        'RESTORE_GCODE_STATE NAME=bounce_move'
    ].join('\n');
}

const JOG_ROWS = [
    ['#BouncePositionBar', 'X', [0.5, 0.1, 0.05, 0.01]],
    ['#BouncePositionBar', 'Y', [0.5, 0.1, 0.05, 0.01]],
    ['#BigPositionBar', 'X', [50, 10, 5, 1]],
    ['#BigPositionBar', 'Y', [50, 10, 5, 1]],
    ['#BigPositionBar', 'Z', [25, 10, 1, 0.1]]
];

function jogButton(axis, value) {
    return $('<button>', {
        type: 'button',
        class: 'btn btn-secondary border',
        'data-gcode': bounceScript(axis, value),
        text: (value > 0 ? '+' : '') + value.toFixed(2)
    });
}

function buildJogBars() {
    JOG_ROWS.forEach(([container, axis, steps]) => {
        const $group = $('<div class="btn-group btn-group-sm ps-5 pe-5" role="group"></div>');
        steps.forEach(step => $group.append(jogButton(axis, -step)));
        $group.append($('<button>', {
            type: 'button',
            class: 'btn btn-dark border border-dark home-axis',
            'data-gcode': 'G28 ' + axis,
            text: axis
        }));
        [...steps].reverse().forEach(step => $group.append(jogButton(axis, step)));

        const $toolbar = $('<div class="btn-toolbar justify-content-center" role="toolbar"></div>').append($group);
        $(container).append($('<div class="row pb-1"></div>').append($toolbar));
    });
}

function cameraOption(dataAttrs, preview, name) {
    return `
        <div class="camera-option p-2" ${dataAttrs}>
            <div class="d-flex align-items-center">
                <div class="me-3">${preview}</div>
                <div>
                    <h6 class="mb-0">${name}</h6>
                    <small class="text-muted">Click to select</small>
                </div>
            </div>
        </div>`;
}

async function loadCameraList(ip) {
    const $cameraList = $('#cameraList');
    $cameraList.empty();

    try {
        const camData = await $.get(printerUrl(ip, '/server/webcams/list'));
        camData.result.webcams.forEach(function(cam) {
            let streamUrl;
            try {
                new URL(cam.stream_url);
                streamUrl = cam.stream_url;
            } catch (e) {
                streamUrl = printerUrl(ip, cam.stream_url);
            }
            const snapshotUrl = streamUrl.replace('?action=stream', '?action=snapshot');
            $cameraList.append(cameraOption(
                `data-url="${streamUrl}" data-flip-h="${cam.flip_horizontal}" data-flip-v="${cam.flip_vertical}"`,
                `<img src="${snapshotUrl}" class="camera-preview" alt="${cam.name}">`,
                cam.name
            ));
        });
    } catch (error) {
        console.error('Failed to fetch printer cameras:', error);
    }

    if (localCamerasSupported()) {
        try {
            const devices = await listLocalCameras();
            devices.forEach(function(device, i) {
                $cameraList.append(cameraOption(
                    `data-device-id="${device.deviceId}"`,
                    '<div class="camera-preview d-flex align-items-center justify-content-center bg-body-secondary fs-1"><i class="bi bi-webcam"></i></div>',
                    `Local: ${device.label || 'Camera ' + (i + 1)}`
                ));
            });
        } catch (error) {
            console.error('No access to local cameras:', error);
        }
    } else {
        $cameraList.append('<small class="text-muted">Local cameras need this page on https or localhost.</small>');
    }

    if ($cameraList.find('.camera-option').length === 0) {
        showModalMessage('No cameras found', false);
        return;
    }

    $('#camera-select').show();
    $('#saveIpBtn').text('Select Camera').prop('disabled', true);
}

async function connectPrinter() {
    const ip = $('#printerIp').val().trim().replace(/^https?:\/\//, '');
    if (!isValidIP(ip)) return;

    const $btn = $('#saveIpBtn');
    $btn.prop('disabled', true)
        .html('<span class="spinner-border spinner-border-sm" role="status"></span> Connecting...');

    try {
        const info = await $.get(printerUrl(ip, '/server/info'));
        if (!info.result.klippy_connected) {
            showModalMessage('Printer is not ready. Please check if Klippy is connected.', false);
            $btn.prop('disabled', false).text('Retry Connection');
            return;
        }
        if (!await isIndxPrinter(ip)) {
            showModalMessage('No INDX calibration macros found on this printer.', false);
            $btn.prop('disabled', false).text('Retry Connection');
            return;
        }
    } catch (error) {
        console.error('Connection failed:', error);
        showModalMessage('Could not connect to printer. Please check the IP address and ensure the printer is online.', false);
        $btn.prop('disabled', false).text('Retry Connection');
        return;
    }

    showModalMessage('Connected successfully!', true);
    $('#printerIp').val(ip).prop('disabled', true);
    $('#disconnectBtn').show();
    loadCameraList(ip);
}

async function connectCamera(source) {
    clearInterval(updateInterval);
    printerIp = $('#printerIp').val();

    stopLocalCamera();
    if (source.deviceId) {
        try {
            await startLocalCamera(source.deviceId);
        } catch (error) {
            console.error('Failed to start local camera:', error);
            showModalMessage('Could not start local camera', false);
            return;
        }
        $('#zoom-image').removeAttr('src').hide();
        $('#zoom-video').show();
    } else {
        $('#zoom-video').hide();
        $('#zoom-image').attr('src', source.url).show();
    }

    isFlippedHorizontal = source.flipH;
    isFlippedVertical = source.flipV;
    $('#flip-horizontal').toggleClass('btn-primary', isFlippedHorizontal).toggleClass('btn-secondary', !isFlippedHorizontal);
    $('#flip-vertical').toggleClass('btn-primary', isFlippedVertical).toggleClass('btn-secondary', !isFlippedVertical);
    updateTransform();

    $('#camContainer').fadeIn();
    $('#printerModal').modal('hide');

    startIndxGuide();
    updatePage();
    updateInterval = setInterval(updatePage, 1000);
}

function disconnect() {
    clearInterval(updateInterval);
    stopLocalCamera();
    printerIp = '';
    selectedCamera = null;
    lastStatus = null;

    $('#printerIp').prop('disabled', false);
    $('#disconnectBtn').hide();
    $('#camera-select').hide();
    $('#cameraList').empty();
    $('#camContainer').hide();
    $('#ipError').hide();
    $('#saveIpBtn').text('Connect').prop('disabled', false);
}

$(document).ready(function() {
    buildJogBars();

    $('#printerIp').val(window.location.hostname);
    $('#printerModal').modal('show');

    $('#ChangePrinter').on('click', function() {
        $('#printerModal').modal('show');
    });

    $('#printerIp').on('input', function() {
        const ip = $(this).val();
        const valid = !ip || isValidIP(ip);
        $('#ipError').toggle(!valid).removeClass('text-success').addClass('text-danger').text('Invalid IP address format');
        $('#saveIpBtn').prop('disabled', !valid);
    });

    $('#saveIpBtn').on('click', function() {
        if (selectedCamera) {
            connectCamera(selectedCamera);
        } else {
            connectPrinter();
        }
    });

    $('#disconnectBtn').on('click', disconnect);

    $(document).on('click', '.camera-option', function() {
        selectedCamera = {
            url: $(this).attr('data-url'),
            deviceId: $(this).attr('data-device-id'),
            flipH: $(this).attr('data-flip-h') === 'true',
            flipV: $(this).attr('data-flip-v') === 'true'
        };
        $('.camera-option').removeClass('selected');
        $(this).addClass('selected');
        $('#saveIpBtn').text('Connect to Camera').prop('disabled', false);
    });

    $(document).on('click', 'button[data-gcode]', function() {
        $.get(gcodeUrl($(this).attr('data-gcode')));
    });
});
