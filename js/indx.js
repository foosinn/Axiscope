// Guided XY calibration for Bondtech INDX printers.
// Uses the INDX camera macros (CAL_ONE / CAL_TWO / CAL_THREE), so offsets
// are stored by INDX itself in save_variables as t{n}_offset_x / t{n}_offset_y.

const INDX_QUERY = 'save_variables&gcode_macro%20TOOL_POSITIONS';

let indxStep = -1;      // -1 = prepare, 0..n-1 = tool, n = done
let indxBusy = null;    // label of the running command
let indxError = '';
let indxStatus = null;

async function isIndxPrinter(ip) {
  const data = await $.get(printerUrl(ip, '/printer/objects/list'));
  const objects = data.result.objects;
  return objects.includes('gcode_macro TOOL_POSITIONS') &&
         objects.includes('gcode_macro CAL_ONE_SET_CAMERA_REF');
}

function startIndxGuide() {
  indxStep = -1;
  indxBusy = null;
  indxError = '';
  indxStatus = null;
  $('#indx-guide').html('<div class="text-secondary p-3">Loading INDX state...</div>');
}

function updateIndxGuide(status) {
  indxStatus = status;
  renderIndxGuide();
}

async function indxRun(label, script, nextStep) {
  indxBusy = label;
  indxError = '';
  renderIndxGuide();
  try {
    await $.get(gcodeUrl(script));
    if (nextStep !== undefined) indxStep = nextStep;
  } catch (xhr) {
    indxError = (xhr.responseJSON && xhr.responseJSON.error && xhr.responseJSON.error.message) ||
                `${script} failed`;
  }
  indxBusy = null;
  renderIndxGuide();
}

function indxState() {
  const s = indxStatus;
  const vars = s.save_variables.variables;
  const tp = s['gcode_macro TOOL_POSITIONS'];
  const pos = s.toolhead.position;
  const hasRef = vars.cam_pos_x !== undefined && vars.cam_pos_y !== undefined && vars.cam_pos_z !== undefined;
  return {
    vars: vars,
    toolCount: parseInt(tp.tool_count),
    docksCalibrated: tp.docks_calibrated,
    homed: s.toolhead.homed_axes === 'xyz',
    active: parseInt(vars.active_tool ?? -1),
    pos: pos,
    hasRef: hasRef,
    ref: hasRef ? [vars.cam_pos_x, vars.cam_pos_y, vars.cam_pos_z] : null
  };
}

function fmt(value) {
  return value === undefined ? '--' : Number(value).toFixed(3);
}

function indxButton(label, script, opts) {
  opts = opts || {};
  const disabled = indxBusy || opts.disabled ? 'disabled' : '';
  const busy = indxBusy === label
    ? '<span class="spinner-border spinner-border-sm me-1" role="status"></span>' : '';
  return `<button type="button" class="btn ${opts.cls || 'btn-primary'} w-100 mb-2 indx-run" ${disabled}
            data-label="${label}" data-script="${script}"
            ${opts.next !== undefined ? `data-next="${opts.next}"` : ''}>${busy}${label}</button>`;
}

function indxPrepareBody(st) {
  const check = (ok, text) =>
    `<li class="${ok ? 'text-success' : 'text-danger'}"><i class="bi ${ok ? 'bi-check-circle' : 'bi-x-circle'}"></i> ${text}</li>`;
  return `
    <ul class="list-unstyled mb-2">
      ${check(st.docksCalibrated, 'Docks calibrated')}
      ${check(st.homed, 'Printer homed')}
      ${check(true, `${st.toolCount} tools found (T0 - T${st.toolCount - 1})`)}
    </ul>
    <ol class="small mb-2">
      <li>Put the camera on the bed, lens facing up.</li>
      <li>Clean all nozzle tips.</li>
      <li>All offsets are measured against T0. If you change the T0 reference, redo every tool.</li>
    </ol>
    ${st.homed ? '' : indxButton('Home all', 'G28', { cls: 'btn-warning' })}
    ${indxButton('Start', '', { next: 0, disabled: !st.homed || !st.docksCalibrated })}`;
}

function indxT0Body(st) {
  const holding = st.active === 0;
  return `
    <ol class="small mb-2">
      <li>Pick up T0.</li>
      <li>Move the nozzle over the camera. Use the big jog buttons first${st.hasRef ? ', or move to the saved reference' : ''}.</li>
      <li>Center the nozzle tip in the crosshair with the fine jog buttons. Zoom in for the last steps.</li>
      <li>Save the position as camera reference.</li>
    </ol>
    ${indxButton('Pick up T0', 'T0', { disabled: holding, cls: holding ? 'btn-outline-secondary' : 'btn-primary' })}
    ${st.hasRef ? indxButton('Move to saved reference', '_CAL_GOTO_CAMPOS', { disabled: !holding, cls: 'btn-secondary' }) : ''}
    ${indxButton('Save T0 as reference', 'CAL_ONE_SET_CAMERA_REF', { disabled: !holding, next: 1, cls: 'btn-success' })}
    <div class="small text-secondary">
      Saved reference: ${st.hasRef ? st.ref.map(fmt).join(' / ') : 'none'}
    </div>`;
}

function indxToolBody(st, tool) {
  const holding = st.active === tool;
  const liveX = holding && st.hasRef ? st.pos[0] - st.ref[0] : undefined;
  const liveY = holding && st.hasRef ? st.pos[1] - st.ref[1] : undefined;
  return `
    <ol class="small mb-2">
      <li>Pick up T${tool}. It moves to the camera reference with its offset cleared.</li>
      <li>Center the nozzle tip in the crosshair with the fine jog buttons.</li>
      <li>Save the offset.</li>
    </ol>
    ${indxButton(`Pick up T${tool} and move to camera`, `CAL_TWO_PREP_TOOL_CAL TOOL=${tool}`,
                 { disabled: !st.hasRef, cls: holding ? 'btn-outline-secondary' : 'btn-primary' })}
    ${indxButton(`Save T${tool} offset`, 'CAL_THREE_SAVE_XY_OFFSET',
                 { disabled: !holding, next: tool + 1, cls: 'btn-success' })}
    <table class="table table-sm small mb-0">
      <tr><th></th><th>X</th><th>Y</th></tr>
      <tr><td>Saved</td><td>${fmt(st.vars[`t${tool}_offset_x`])}</td><td>${fmt(st.vars[`t${tool}_offset_y`])}</td></tr>
      <tr><td>Live</td><td>${fmt(liveX)}</td><td>${fmt(liveY)}</td></tr>
    </table>
    ${st.hasRef ? '' : '<div class="small text-danger">No camera reference. Do the T0 step first.</div>'}`;
}

function indxDoneBody(st) {
  let rows = '';
  for (let i = 0; i < st.toolCount; i++) {
    rows += `<tr><td>T${i}</td><td>${fmt(st.vars[`t${i}_offset_x`])}</td>
             <td>${fmt(st.vars[`t${i}_offset_y`])}</td><td>${fmt(st.vars[`t${i}_offset_z`])}</td></tr>`;
  }
  return `
    <p class="small mb-2">XY offsets are saved. INDX applies them on the next tool pickup.</p>
    <table class="table table-sm small">
      <tr><th></th><th>X</th><th>Y</th><th>Z</th></tr>
      ${rows}
    </table>
    ${indxButton('Park tool', 'PARK_TOOL', { cls: 'btn-secondary', disabled: st.active < 0 })}
    <p class="small mb-2">Next: calibrate Z with the load cell. Remove the camera and unload filament from all extruder gears first.</p>
    ${indxButton('Run CAL_Z', 'CAL_Z', { cls: 'btn-warning' })}`;
}

function indxStepTitle(step, st) {
  if (step < 0) return 'Prepare';
  if (step === 0) return 'T0 - camera reference';
  if (step >= st.toolCount) return 'Done';
  return `T${step} - XY offset`;
}

function renderIndxGuide() {
  if (!indxStatus) return;
  const st = indxState();
  const steps = [];
  for (let i = -1; i <= st.toolCount; i++) steps.push(i);

  let html = '<div class="list-group">';
  steps.forEach(step => {
    const current = step === indxStep;
    const done = step < indxStep;
    const icon = done ? 'bi-check-circle-fill text-success'
               : current ? 'bi-arrow-right-circle-fill text-primary' : 'bi-circle text-secondary';
    html += `<div class="list-group-item bg-body-tertiary ${current ? 'border-primary' : ''}">
      <div class="d-flex align-items-center indx-step" data-step="${step}" role="button">
        <i class="bi ${icon} me-2"></i><strong>${indxStepTitle(step, st)}</strong>
      </div>`;
    if (current) {
      html += '<div class="pt-2">';
      if (step < 0) html += indxPrepareBody(st);
      else if (step === 0) html += indxT0Body(st);
      else if (step >= st.toolCount) html += indxDoneBody(st);
      else html += indxToolBody(st, step);
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  if (indxError) html += `<div class="alert alert-danger small mt-2">${$('<div>').text(indxError).html()}</div>`;

  const $guide = $('#indx-guide');
  if ($guide.data('html') !== html) {
    $guide.data('html', html).html(html);
  }
}

$(document).ready(function() {
  $(document).on('click', '.indx-run', function() {
    const next = $(this).attr('data-next');
    if (!$(this).attr('data-script')) {
      indxStep = parseInt(next);
      renderIndxGuide();
      return;
    }
    indxRun($(this).attr('data-label'), $(this).attr('data-script'),
            next === undefined ? undefined : parseInt(next));
  });

  $(document).on('click', '.indx-step', function() {
    if (indxBusy) return;
    indxStep = parseInt($(this).attr('data-step'));
    indxError = '';
    renderIndxGuide();
  });
});
