// Global variables for camera transforms
let isFlippedHorizontal = false;
let isFlippedVertical = false;

// Function to get crosshair position from SVG
function getCrosshairPosition() {
    const svg = document.querySelector('.img-overlay-wrap svg');
    const circle = svg.querySelector('circle');
    return {
        x: parseFloat(circle.getAttribute('cx')),
        y: parseFloat(circle.getAttribute('cy'))
    };
}

// Function to calculate zoom origin based on crosshair
function calculateZoomOrigin() {
    const crosshair = getCrosshairPosition();
    // Convert SVG coordinates (200x200) to percentages
    const xPercent = (crosshair.x / 200) * 100;
    const yPercent = (crosshair.y / 200) * 100;
    return { x: xPercent, y: yPercent };
}

// Function to update transform with all transformations
function updateTransform() {
    const zoomSlider = document.getElementById('zoom-range');
    const scale = 1 + (parseInt(zoomSlider.value) / 100);
    const scaleX = isFlippedHorizontal ? -scale : scale;
    const scaleY = isFlippedVertical ? -scale : scale;
    
    // Get zoom origin based on crosshair position
    const origin = calculateZoomOrigin();
    
    document.querySelectorAll('.cam-feed').forEach(feed => {
        feed.style.transformOrigin = `${origin.x}% ${origin.y}%`;
        feed.style.transform = `scale(${scaleX}, ${scaleY})`;
    });
}

let localStream = null;

function localCamerasSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// Device labels are only visible after the user granted camera access once.
async function listLocalCameras() {
    if (!localCamerasSupported()) return [];
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach(track => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
}

async function startLocalCamera(deviceId) {
    stopLocalCamera();
    localStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } }
    });
    document.getElementById('zoom-video').srcObject = localStream;
}

function stopLocalCamera() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    document.getElementById('zoom-video').srcObject = null;
}

$(document).ready(function() {
    //Zoom
    const zoomSlider = document.getElementById('zoom-range');

    // Zoom event listener
    zoomSlider.addEventListener('input', () => {
        updateTransform();
    });

    // Flip controls event listeners
    document.getElementById('flip-horizontal').addEventListener('click', () => {
        isFlippedHorizontal = !isFlippedHorizontal;
        updateTransform();
        // Toggle active state of button
        document.getElementById('flip-horizontal').classList.toggle('btn-primary');
        document.getElementById('flip-horizontal').classList.toggle('btn-secondary');
    });

    document.getElementById('flip-vertical').addEventListener('click', () => {
        isFlippedVertical = !isFlippedVertical;
        updateTransform();
        // Toggle active state of button
        document.getElementById('flip-vertical').classList.toggle('btn-primary');
        document.getElementById('flip-vertical').classList.toggle('btn-secondary');
    });

    // Set initial transform
    updateTransform();
    //Contrast
    const slider = document.getElementById('contrast-range');

    function updateContrast() {
      const value = slider.value;
      document.querySelectorAll('.cam-feed').forEach(feed => {
        feed.style.filter = `contrast(${value}%)`;
      });
    }
    slider.addEventListener('input', updateContrast);
    updateContrast();

    //LED brightness (Ember Prototype V2 camera, optional)
    const ledSlider = document.getElementById('led-range');
    let ledSendTimeout = null;

    function sendLedValue(value) {
        const pwm = (value / 100).toFixed(3);
        $.get(printerUrl(printerIp, '/printer/gcode/script?script=' +
            encodeURIComponent('AXISCOPE_SET_LED VALUE=' + pwm)))
            .fail(function() {
                console.error('Failed to set LED brightness');
            });
    }

    ledSlider.addEventListener('pointerdown', () => {
        isLedSliderActive = true;
    });

    ledSlider.addEventListener('input', () => {
        clearTimeout(ledSendTimeout);
        ledSendTimeout = setTimeout(() => sendLedValue(ledSlider.value), 200);
    });

    ledSlider.addEventListener('pointerup', () => {
        isLedSliderActive = false;
    });
});