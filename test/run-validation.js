#!/usr/bin/env node
/* Harness for the can't-be-wrong validation pass.
 * WiringGuide.validate is pure (no DOM), so it runs straight in node:
 *     node test/run-validation.js
 * Checks: every shipped spec validates clean EXCEPT the deliberate
 * pin-15-VCC demo, which MUST be rejected with an error naming pin 15,
 * its real function (GPIO22) and where 3V3 actually lives. Also runs a
 * table of inline negative cases (one wrongness each). Exit 0 = all good. */
'use strict';
const fs = require('fs');
const path = require('path');

const WG = require(path.join(__dirname, '..', 'wiring.js')).WiringGuide;
if (!WG || typeof WG.validate !== 'function') {
  console.error('FATAL: wiring.js did not export WiringGuide.validate');
  process.exit(2);
}
const strip = h => String(h).replace(/<[^>]+>/g, '');
let failures = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- 1. shipped specs ----
const specDir = path.join(__dirname, '..', 'specs');
for (const f of fs.readdirSync(specDir).filter(f => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(fs.readFileSync(path.join(specDir, f), 'utf8'));
  const { errors, warnings } = WG.validate(spec);
  const msgs = errors.map(strip);
  const warningMsgs = warnings.map(strip);
  if (f === 'demo-pin15-vcc-wrong.json') {
    const hit = msgs.some(m => /physical pin 15\b/.test(m) && /GPIO22/.test(m) && /POWER|3V3/.test(m) && /pins 1, 2, 4, 17\b/.test(m));
    report(`specs/${f} REJECTED with precise error`, errors.length > 0 && hit,
      errors.length ? msgs.join(' | ') : 'validated clean — the guarantee is broken');
  } else {
    report(`specs/${f} validates clean`, errors.length === 0,
      msgs.concat(warningMsgs.map(m => 'WARNING: ' + m)).join(' | '));
  }
}

// ---- 1b. starter templates all validate clean ----
const tplDir = path.join(__dirname, '..', 'templates');
for (const f of fs.readdirSync(tplDir).filter(f => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(fs.readFileSync(path.join(tplDir, f), 'utf8'));
  const { errors, warnings } = WG.validate(spec);
  const msgs = errors.map(strip);
  report(`templates/${f} validates clean`, msgs.length === 0,
    msgs.concat(warnings.map(w => 'WARNING: ' + strip(w))).join(' | '));
}

// ---- 2. inline negative cases (each must produce >=1 error matching `want`) ----
const pinList = labels => labels.map(label => ({ label }));
const pi = labels => ({ id: 'pi', pinout: 'raspberry-pi-40', pins: pinList(labels) });
const cases = [
  ['pin NAME lies about a power pin (P15 3V3)',
    { components: [pi(['P15 3V3'])] }, /name says 3V3.*physical pin 15.*GPIO22/i],
  ['power pin disguised with a signal name (P20 SENSOR_EN)',
    { components: [pi(['P20 SENSOR_EN'])] }, /physical pin 20 is GND.*named for what it is/i],
  ['GPIO number wrong in the name (P15 GPIO23)',
    { components: [pi(['P15 GPIO23'])] }, /says GPIO23.*physical pin 15.*GPIO22/i],
  ['pin number that does not exist (P41)',
    { components: [pi(['P41 GPIO99'])] }, /physical pin 41 does not exist/i],
  ['pinout pin without a resolvable physical number',
    { components: [pi(['MOSI'])] }, /cannot determine its physical position/i],
  ['explicit net role 5V onto a 3V3 pin',
    { mode: 'point-to-point', components: [pi(['P1 3V3']), { id: 's', pins: pinList(['VIN']) }],
      nets: [{ id: 'N1', role: '5V', from: 'pi.P1 3V3', to: 's.VIN' }] }, /5V connection.*physical pin 1.*3V3/i],
  ['GND wire onto a 5V pin ([col,row] perfboard form)',
    { components: [Object.assign(pi([]), { pins: [{ label: 'P2 5V', loc: [1, 1] }] }), { id: 's', pins: [{ label: 'GND', loc: [5, 5] }] }],
      nets: [{ id: 'N1', from: [1, 1], to: [5, 5] }] }, /the two ends disagree|GND connection.*physical pin 2/i],
  ['two ends disagree (3V3 wired to GND)',
    { mode: 'point-to-point', components: [pi(['P1 3V3']), { id: 's', pins: pinList(['GND']) }],
      nets: [{ id: 'N1', from: 'pi.P1 3V3', to: 's.GND' }] }, /two ends disagree/i],
  ['label override renumbers a pin (9 -> 7)',
    { components: [Object.assign(pi([]), { pins: [{ label: 'P9 GND', loc: [2, 5] }] })], labels: { '2,5': '7' },
      nets: [] }, /label override "7".*physical pin 9/i],
  ['pinRoles override forces a check (NSS as SIGNAL on a GND pin)',
    { mode: 'point-to-point',
      components: [Object.assign(pi(['P6 GND']), { pinRoles: { 'P6 GND': 'SIGNAL' } }), { id: 's', pins: pinList(['CS']) }],
      nets: [{ id: 'N1', from: 'pi.P6 GND', to: 's.CS' }] }, /SIGNAL connection.*physical pin 6.*GND/i],
  ['wiring anything to a reserved ID EEPROM pin',
    { mode: 'point-to-point', components: [pi(['P27 ID_SD']), { id: 's', pins: pinList(['SDA']) }],
      nets: [{ id: 'N1', role: 'SIGNAL', from: 'pi.P27 ID_SD', to: 's.SDA' }] }, /reserved/i],
  ['reserved pin caught even with NO role resolved (role-independent)',
    { mode: 'point-to-point', components: [pi(['P27 ID_SD']), { id: 's', pins: pinList(['IO']) }],
      nets: [{ id: 'N1', from: 'pi.P27 ID_SD', to: 's.IO' }] }, /reserved/i],
  ['custom inline pinout (spec.pinouts) validates a user-defined board',
    { pinouts: { myb: { label: 'My Board', pins: { '1': '3V3', '2': 'GPIO0' } } },
      components: [{ id: 'b', pinout: 'myb', pins: pinList(['P1 3V3', 'P2 GPIO0']) }, { id: 'm', pins: pinList(['VCC']) }],
      nets: [{ id: 'N1', role: 'POWER', from: 'b.P2 GPIO0', to: 'm.VCC' }] }, /GPIO0.*not POWER|POWER connection/i],
  ['Pico built-in: a power wire onto a GP signal pin is rejected',
    { components: [{ id: 'pico', pinout: 'raspberry-pi-pico', pins: pinList(['P1 GP0']) }, { id: 'm', pins: pinList(['VCC']) }],
      nets: [{ id: 'N1', role: 'POWER', from: 'pico.P1 GP0', to: 'm.VCC' }] }, /GP0.*SIGNAL|not POWER/i],
  ['Pico built-in: naming the 3V3_EN control pin just "3V3" (a lie) is rejected',
    { components: [{ id: 'pico', pinout: 'raspberry-pi-pico', pins: pinList(['P37 3V3']) }],
      nets: [] }, /3V3_EN|the name says/i],
  // ---- label-addressed boards (Arduino/ESP; addressing:'label') ----
  ['label board (Uno): a SIGNAL net onto the 5V pin is rejected',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['5V', 'D2']) }],
      nets: [{ id: 'N1', role: 'SIGNAL', from: 'u.5V', to: 'u.D2' }] }, /not SIGNAL|two ends disagree/i],
  ['label board (ESP32): a 3V3 wire onto a GPIO signal pin is rejected',
    { mode: 'point-to-point', components: [{ id: 'e', pinout: 'esp32-devkitc-38pin', pins: pinList(['GPIO21', '3V3']) }],
      nets: [{ id: 'N1', role: '3V3', from: 'e.3V3', to: 'e.GPIO21' }] }, /not 3V3|3V3 connection/i],
  ['label board (ESP32): wiring to a flash-reserved pin (GPIO6) is rejected',
    { mode: 'point-to-point', components: [{ id: 'e', pinout: 'esp32-devkitc-38pin', pins: pinList(['GPIO6', 'GND']) }],
      nets: [{ id: 'N1', from: 'e.GPIO6', to: 'e.GND' }] }, /reserved|not usable for I\/O/i],
  ['label board (Uno): an unknown silkscreen label is rejected with the valid list',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['D99']) }],
      nets: [] }, /no pin labeled "D99".*valid labels/i],
  // ---- common breakout MODULES (role-typed pins, no hand annotation) ----
  ['module (HC-SR04): a 5V rail wired to its TRIG signal pin is rejected',
    { mode: 'point-to-point', components: [{ id: 'd', module: 'hc-sr04' }, { id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['5V', 'D2']) }],
      nets: [{ id: 'N1', from: 'u.5V', to: 'd.TRIG' }] }, /two ends disagree|not SIGNAL|not 5V/i],
  ['module (SSD1306): a SIGNAL net onto its VCC (power) pin is rejected',
    { mode: 'point-to-point', components: [{ id: 'o', module: 'ssd1306-oled' }, { id: 'e', pinout: 'esp32-devkitc-38pin', pins: pinList(['GPIO21']) }],
      nets: [{ id: 'N1', role: 'SIGNAL', from: 'e.GPIO21', to: 'o.VCC' }] }, /two ends disagree|not SIGNAL|VCC/i],
  ['module: an unknown module id is rejected with the known list',
    { mode: 'point-to-point', components: [{ id: 'x', module: 'not-a-real-module' }], nets: [] }, /unknown module "not-a-real-module".*known modules/i],
  ['module: declaring both a module and a board pinout on one part is rejected',
    { mode: 'point-to-point', components: [{ id: 'x', module: 'dht22', pinout: 'raspberry-pi-40' }], nets: [] }, /both.*module.*and.*pinout|either a board header/i],
  // ---- RAW regulator inputs (VIN/VSYS) and REFERENCE pins are NOT rails ----
  // Coarse role checking: a regulated 3V3/5V rail (explicit or inferred) may not
  // land on a board's raw regulator input, and a supply may not land on a
  // reference pin. Roleless nets are not checked — the author owns the goal.
  ['Uno VIN: an explicit 5V net into VIN is rejected (VIN is the regulator input, not the 5V rail)',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 'psu', pins: pinList(['OUT']) }],
      nets: [{ id: 'N1', role: '5V', from: 'psu.OUT', to: 'u.VIN' }] }, /5V connection.*u\.VIN.*= VIN \(the raw supply input.*not a regulated rail\), not 5V.*5V lives on pin 5V/i],
  ['Uno VIN: a 5V net INFERRED from the source pin name is rejected too',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'u.VIN' }] }, /5V connection.*u\.VIN.*raw supply input/i],
  ['Uno VIN: a 3V3 net into VIN is rejected',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 'psu', pins: pinList(['3V3']) }],
      nets: [{ id: 'N1', from: 'psu.3V3', to: 'u.VIN' }] }, /3V3 connection.*u\.VIN.*raw supply input.*not 3V3/i],
  ['Nano VIN: a 5V net into VIN is rejected',
    { mode: 'point-to-point', components: [{ id: 'n', pinout: 'arduino-nano-v3', pins: pinList(['VIN']) }, { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'n.VIN' }] }, /5V connection.*n\.VIN.*Nano.*raw supply input/i],
  ['Nano VIN: a 3V3 net into VIN is rejected',
    { mode: 'point-to-point', components: [{ id: 'n', pinout: 'arduino-nano-v3', pins: pinList(['VIN']) }, { id: 'psu', pins: pinList(['3V3']) }],
      nets: [{ id: 'N1', from: 'psu.3V3', to: 'n.VIN' }] }, /3V3 connection.*n\.VIN.*raw supply input/i],
  ['Pico VSYS: a 5V net into VSYS is rejected (VSYS is the SMPS input, not a rail)',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P39 VSYS']) }, { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'p.P39 VSYS' }] }, /5V connection.*physical pin 39.*VSYS \(the raw supply input/i],
  ['Pico VSYS: a 3V3 net into VSYS is rejected',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P39 VSYS']) }, { id: 'psu', pins: pinList(['3V3']) }],
      nets: [{ id: 'N1', from: 'psu.3V3', to: 'p.P39 VSYS' }] }, /3V3 connection.*physical pin 39.*VSYS \(the raw supply input/i],
  ['Uno VIN: powering a sensor VCC (generic POWER) from VIN is rejected — VIN is raw, not 3V3-or-5V',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 's', pins: pinList(['VCC']) }],
      nets: [{ id: 'N1', from: 'u.VIN', to: 's.VCC' }] }, /POWER connection.*u\.VIN.*raw supply input.*not POWER/i],
  ['Pico: disguising VSYS (pin 39) under a signal-ish name is rejected',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P39 SUPPLY']) }], nets: [] },
    /physical pin 39 is VSYS.*named for what it is/i],
  ['Uno IOREF: a 5V net onto the IOREF reference pin is rejected (reference, not a supply)',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['5V', 'IOREF']) }],
      nets: [{ id: 'N1', from: 'u.5V', to: 'u.IOREF' }] }, /5V connection.*u\.IOREF.*= IOREF \(a voltage-reference pin, not a supply\), not 5V/i],
  ['Uno AREF: a 3V3 net onto AREF is rejected',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['3V3', 'AREF']) }],
      nets: [{ id: 'N1', from: 'u.3V3', to: 'u.AREF' }] }, /3V3 connection.*u\.AREF.*voltage-reference pin.*not 3V3/i],
  ['Nano AREF: a 5V net onto AREF is rejected',
    { mode: 'point-to-point', components: [{ id: 'n', pinout: 'arduino-nano-v3', pins: pinList(['5V', 'AREF']) }],
      nets: [{ id: 'N1', from: 'n.5V', to: 'n.AREF' }] }, /5V connection.*n\.AREF.*voltage-reference pin/i],
  ['Pico ADC_VREF: a 3V3 net onto ADC_VREF is rejected',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P36 3V3(OUT)', 'P35 ADC_VREF']) }],
      nets: [{ id: 'N1', from: 'p.P36 3V3(OUT)', to: 'p.P35 ADC_VREF' }] }, /3V3 connection.*physical pin 35.*ADC_VREF \(a voltage-reference pin/i],
  ['Pico ADC_VREF: a 5V net onto ADC_VREF is rejected',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P40 VBUS', 'P35 ADC_VREF']) }],
      nets: [{ id: 'N1', from: 'p.P40 VBUS', to: 'p.P35 ADC_VREF' }] }, /5V connection.*physical pin 35.*ADC_VREF \(a voltage-reference pin/i],
  ['custom pinout: a "VIN" function is the raw input there too — a 5V rail onto it is rejected',
    { mode: 'point-to-point', pinouts: { myb: { label: 'My Board', pins: { '1': 'VIN', '2': 'GND' } } },
      components: [{ id: 'b', pinout: 'myb', pins: pinList(['P1 VIN']) }, { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'b.P1 VIN' }] }, /5V connection.*P1 VIN.*raw supply input/i],
];
for (const [name, spec, want] of cases) {
  const msgs = WG.validate(spec).errors.map(strip);
  const hit = msgs.some(m => want.test(m));
  report(`negative: ${name}`, hit, hit ? msgs.find(m => want.test(m)) : ('got: ' + (msgs.join(' | ') || 'NO ERRORS')));
}

// ---- 2b. label-board positives: valid specs + alias resolution produce NO errors ----
const positives = [
  ['label board (Uno) LED/power/ground spec validates clean',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['D13', '5V', 'GND']) }], nets: [] }],
  ['label alias: ESP8266 pin addressed as "D2" resolves clean',
    { mode: 'point-to-point', components: [{ id: 'e', pinout: 'esp8266-nodemcu-v1', pins: pinList(['D2']) }], nets: [] }],
  ['label alias: the SAME ESP8266 pin addressed as "GPIO4" resolves clean',
    { mode: 'point-to-point', components: [{ id: 'e', pinout: 'esp8266-nodemcu-v1', pins: pinList(['GPIO4']) }], nets: [] }],
  ['module (HC-SR04 → Arduino Uno): a correct 5V/GND/signal harness validates clean',
    { mode: 'point-to-point',
      components: [{ id: 'd', module: 'hc-sr04' }, { id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['5V', 'GND', 'D2', 'D3']) }],
      nets: [
        { id: 'PWR', from: 'u.5V', to: 'd.VCC' }, { id: 'GND', from: 'u.GND', to: 'd.GND' },
        { id: 'TRIG', from: 'u.D2', to: 'd.TRIG' }, { id: 'ECHO', from: 'u.D3', to: 'd.ECHO' },
      ] }],
  ['module alias: "am2302" resolves to the dht22 module and validates clean',
    { mode: 'point-to-point', components: [{ id: 't', module: 'am2302' }], nets: [] }],
  // ---- raw regulator inputs / reference pins used as intended ----
  ['Uno VIN: a raw external supply (battery "+", no rail role) into VIN validates clean',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN', 'GND']) }, { id: 'bat', pins: pinList(['+', 'GND']) }],
      nets: [{ id: 'N1', from: 'bat.+', to: 'u.VIN' }, { id: 'N2', from: 'bat.GND', to: 'u.GND' }] }],
  ['Uno VIN: a supply whose own pin is labelled "VIN" (not a rail) into VIN validates clean',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 'jack', pins: pinList(['VIN']) }],
      nets: [{ id: 'N1', from: 'jack.VIN', to: 'u.VIN' }] }],
  ['Nano VIN: a raw external supply into VIN validates clean',
    { mode: 'point-to-point', components: [{ id: 'n', pinout: 'arduino-nano-v3', pins: pinList(['VIN']) }, { id: 'bat', pins: pinList(['+']) }],
      nets: [{ id: 'N1', from: 'bat.+', to: 'n.VIN' }] }],
  ['Pico VSYS: a raw external supply (LiPo "+") into VSYS validates clean',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P39 VSYS']) }, { id: 'bat', pins: pinList(['+']) }],
      nets: [{ id: 'N1', from: 'bat.+', to: 'p.P39 VSYS' }] }],
  ['Pico VBUS: a 5V net onto VBUS validates clean (VBUS is the 5 V USB input)',
    { mode: 'point-to-point', components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P40 VBUS']) }, { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'p.P40 VBUS' }] }],
  ['Uno IOREF: a roleless sense wire to a shield validates clean',
    { mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['IOREF']) }, { id: 'sh', pins: pinList(['IOREF_SENSE']) }],
      nets: [{ id: 'N1', from: 'u.IOREF', to: 'sh.IOREF_SENSE' }] }],
  ['custom pinout: a "VBUS_SENSE" function is a SIGNAL, not the 5V rail (exact-name classes, no prefix guessing)',
    { mode: 'point-to-point', pinouts: { myb: { label: 'My Board', pins: { '1': 'VBUS_SENSE', '2': 'GND' } } },
      components: [{ id: 'b', pinout: 'myb', pins: pinList(['P1 VSENSE']) }, { id: 'm', pins: pinList(['OUT']) }],
      nets: [{ id: 'N1', role: 'SIGNAL', from: 'm.OUT', to: 'b.P1 VSENSE' }] }],
];
// ---- endpoint-NAME inference treats "_" as part of the identifier (exact names, like fnClass) ----
{
  const clean = (name, spec) => { const m = WG.validate(spec).errors.map(strip); report(name, m.length === 0, m.join(' | ') || 'clean'); };
  const errs = spec => WG.validate(spec).errors.map(strip);
  // custom pinout function AND label both "VBUS_SENSE": a signal net is valid (inferred, and with explicit role SIGNAL)
  const vbusSpec = role => ({ mode: 'point-to-point', pinouts: { myb: { label: 'My Board', pins: { '1': 'VBUS_SENSE' } } },
    components: [{ id: 'b', pinout: 'myb', pins: pinList(['P1 VBUS_SENSE']) }, { id: 'm', pins: pinList(['OUT']) }],
    nets: [Object.assign({ id: 'N1', from: 'm.OUT', to: 'b.P1 VBUS_SENSE' }, role ? { role } : {})] });
  clean('name inference: a pin NAMED "VBUS_SENSE" accepts a signal net (no 5V inferred from the VBUS_ token)', vbusSpec(null));
  clean('name inference: …and an explicit role:"SIGNAL" on that net also validates clean', vbusSpec('SIGNAL'));
  // Pico BUILT-IN P37 3V3_EN is a control input: a signal net to it is valid
  const enSpec = role => ({ mode: 'point-to-point',
    components: [{ id: 'p', pinout: 'raspberry-pi-pico', pins: pinList(['P37 3V3_EN']) }, { id: 'm', pins: pinList(['EN_OUT']) }],
    nets: [Object.assign({ id: 'N1', from: 'm.EN_OUT', to: 'p.P37 3V3_EN' }, role ? { role } : {})] });
  clean('name inference: Pico built-in P37 "3V3_EN" accepts a signal net (no 3V3 inferred from the 3V3_ token)', enSpec(null));
  clean('name inference: …and with explicit role:"SIGNAL" too', enSpec('SIGNAL'));
  // a breakout pin named VCC_EN is an enable line, not power
  const vccEnSpec = role => ({ mode: 'point-to-point',
    components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['D4']) }, { id: 'bo', pins: pinList(['VCC_EN']) }],
    nets: [Object.assign({ id: 'N1', from: 'u.D4', to: 'bo.VCC_EN' }, role ? { role } : {})] });
  clean('name inference: a pin named "VCC_EN" accepts a signal net from a GPIO (no POWER inferred)', vccEnSpec(null));
  clean('name inference: …and with explicit role:"SIGNAL" too', vccEnSpec('SIGNAL'));
  // the plain names still infer their rail
  report('name inference: a pin named exactly "3V3" (Pi P1 3V3) still infers 3V3 — a signal net to it is rejected',
    errs({ mode: 'point-to-point', components: [pi(['P1 3V3']), { id: 'm', pins: pinList(['IO']) }],
      nets: [{ id: 'N1', role: 'SIGNAL', from: 'pi.P1 3V3', to: 'm.IO' }] }).some(m => /two ends disagree.*3V3|SIGNAL connection.*physical pin 1/.test(m)));
  report('name inference: a boardless pin named exactly "5V" still infers 5V (rejected onto a 3V3 pin)',
    errs({ mode: 'point-to-point', components: [pi(['P1 3V3']), { id: 'psu', pins: pinList(['5V']) }],
      nets: [{ id: 'N1', from: 'psu.5V', to: 'pi.P1 3V3' }] }).some(m => /two ends disagree|5V connection.*physical pin 1/.test(m)));
}
// …and the converse: because VBUS_SENSE is NOT the 5V class, a 5V rail onto it is refused
report('negative: custom pinout: a 5V net onto a "VBUS_SENSE" function pin is rejected (it is a signal)',
  WG.validate({ mode: 'point-to-point', pinouts: { myb: { label: 'My Board', pins: { '1': 'VBUS_SENSE' } } },
    components: [{ id: 'b', pinout: 'myb', pins: pinList(['P1 VSENSE']) }, { id: 'psu', pins: pinList(['5V']) }],
    nets: [{ id: 'N1', from: 'psu.5V', to: 'b.P1 VSENSE' }] }).errors.some(e => /5V connection.*VBUS_SENSE \(SIGNAL\), not 5V/.test(strip(e))));
for (const [name, spec] of positives) {
  const msgs = WG.validate(spec).errors.map(strip);
  report(`positive: ${name}`, msgs.length === 0, msgs.join(' | ') || 'clean');
}
// the net schema did not grow: `volts` is not a field and VIN/REF are not net roles
report('no net-level voltage field: `volts` on a net is ignored and buys no override',
  WG.validate({ mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['5V']) }, { id: 'bat', pins: pinList(['+']) }],
    nets: [{ id: 'N1', role: '5V', volts: 9, from: 'bat.+', to: 'u.5V' }] }).errors.length === 0 &&
  WG.validate({ mode: 'point-to-point', components: [{ id: 'u', pinout: 'arduino-uno-r3', pins: pinList(['VIN']) }, { id: 'bat', pins: pinList(['+']) }],
    nets: [{ id: 'N1', role: '5V', volts: 9, from: 'bat.+', to: 'u.VIN' }] }).errors.some(e => /raw supply input/.test(strip(e))));
report('no user-facing VIN/REF net roles: role "VIN" and role "REF" are unknown roles',
  ['VIN', 'REF'].every(r => WG.validate({ mode: 'point-to-point', components: [{ id: 'x', pins: pinList(['A']) }],
    nets: [{ id: 'N1', role: r, from: 'x.A', to: 'x.A' }] }).errors.some(e => /unknown role/.test(strip(e)))));
// provenance is in the tree, not in git history — and `source` is ONE clean URL
report('provenance: every built-in pinout carries a single clean source URL and a verified date',
  Object.keys(WG.PINOUTS).every(id => /^https:\/\/\S+$/.test(String(WG.PINOUTS[id].source)) && /^\d{4}-\d{2}-\d{2}$/.test(String(WG.PINOUTS[id].verified))),
  Object.keys(WG.PINOUTS).map(id => `${id}: ${/^https:\/\/\S+$/.test(String(WG.PINOUTS[id].source)) ? 'ok' : 'BAD ' + WG.PINOUTS[id].source}`).join(', '));
report('provenance: no built-in pinout ships a voltage window (unconfirmable data is not shipped as fact)',
  Object.keys(WG.PINOUTS).every(id => WG.PINOUTS[id].ranges === undefined));

// ---- 2c. meta.notes format is validated (warnings, never fatal) ----
const noteCases = [
  ['a plain string note is accepted with no warning', { meta: { notes: ['just text'] } }, false],
  ['a note object missing html warns (would render empty)', { meta: { notes: [{ type: 'ok' }] } }, /render empty/],
  ['an unknown note type warns', { meta: { notes: [{ html: 'x', type: 'bogus' }] } }, /unknown type/],
  ['meta.notes that is not an array warns', { meta: { notes: 'oops' } }, /must be an array/],
];
for (const [name, spec, want] of noteCases) {
  const w = WG.validate(spec).warnings.map(strip);
  const hit = want === false ? w.length === 0 : w.some(m => want.test(m));
  report(`notes: ${name}`, hit, want === false ? (w.join(' | ') || '(clean)') : (hit ? w.find(m => want.test(m)) : 'got: ' + (w.join(' | ') || 'NO WARNINGS')));
}

// ---- 2d. geometry + identity fail CLOSED (WG-02) ----
// Each of these used to validate clean and then render a plausible-looking
// wrong guide (fallback board, clipped wire, merged parts) or crash. Every one
// must now be a hard error naming the offending field.
const five = { preset: 'perf', cols: 5, rows: 5 };
const geomCases = [
  ['unknown board preset (typo) is rejected with the known list',
    { board: { preset: 'breadboard-hlaf' } }, /"breadboard-hlaf" is not a known preset.*breadboard-half/],
  ['board.cols = 0 is rejected (would silently become the 20-col default)',
    { board: { cols: 0 } }, /board\.cols must be a positive whole number/],
  ['board.rows negative is rejected',
    { board: { rows: -3 } }, /board\.rows must be a positive whole number/],
  ['board.cols fractional is rejected',
    { board: { preset: 'perf', cols: 2.5 } }, /board\.cols must be a positive whole number/],
  ['board.cols as a string is rejected',
    { board: { cols: '20' } }, /board\.cols must be a positive whole number/],
  ['board that is not an object is rejected',
    { board: 'breadboard-half' }, /board must be an object/],
  ['electrocookie boards:-1 is rejected',
    { board: { preset: 'electrocookie-strip', boards: -1 } }, /board\.boards must be a positive whole number.*got -1/],
  ['electrocookie boards:{x:0,y:0} is rejected (builder used to `|| 1` it into a 1x1)',
    { board: { preset: 'electrocookie-strip', boards: { x: 0, y: 0 } } }, /board\.boards must be.*got \{"x":0,"y":0\}/],
  ['electrocookie boards:"2" (string) is rejected',
    { board: { preset: 'electrocookie-strip', boards: '2' } }, /board\.boards must be.*got "2"/],
  ['electrocookie boards:0 is rejected',
    { board: { preset: 'electrocookie-strip', boards: 0 } }, /board\.boards must be.*got 0/],
  ['electrocookie boards:2.5 is rejected',
    { board: { preset: 'electrocookie-strip', boards: 2.5 } }, /board\.boards must be.*got 2\.5/],
  ['electrocookie boards:{} (no axis) is rejected (used to render the default 17x19)',
    { board: { preset: 'electrocookie-strip', boards: {} } }, /board\.boards must be.*\{\} names no axis/],
  ['electrocookie boards:{xx:2} (typo\'d axis) is rejected as an unknown key',
    { board: { preset: 'electrocookie-strip', boards: { xx: 2 } } }, /board\.boards must be.*unknown key xx in \{"xx":2\}/],
  ['electrocookie boards:{x:2,yy:3} is rejected as an unknown key (used to silently render 2x1)',
    { board: { preset: 'electrocookie-strip', boards: { x: 2, yy: 3 } } }, /unknown key yy in \{"x":2,"yy":3\}/],
  ['electrocookie boards:{cols:2,rows:1} is rejected — the undocumented cols/rows aliases are gone',
    { board: { preset: 'electrocookie-strip', boards: { cols: 2, rows: 1 } } }, /unknown keys cols, rows/],
  ['electrocookie boards:{x:"a"} (object form) is rejected',
    { board: { preset: 'electrocookie-strip', boards: { x: 'a' } } }, /board\.boards must be.*got \{"x":"a"\}/],
  ['a board over the per-axis cap (1001 cols) is rejected',
    { board: { cols: 1001 } }, /board resolves to 1001×20.*1 to 1000/],
  ['a 1000x1000 board (a million holes) is rejected by the total-hole cap',
    { board: { cols: 1000, rows: 1000 } }, /board resolves to 1000×1000 = 1000000 holes.*20000-hole limit/],
  ['a 200x101 board (20200 holes) is rejected by the total-hole cap',
    { board: { cols: 200, rows: 101 } }, /= 20200 holes.*20000-hole limit/],
  ['component pin at [99,99] on a 5x5 board is rejected',
    { board: five, components: [{ id: 'x', pins: [{ label: 'A', loc: [99, 99] }] }] }, /pin "A" at \[99,99\] is off the board.*5 cols × 5 rows/],
  ['component pin at [0,1] (0-indexed mistake) is rejected',
    { board: five, components: [{ id: 'x', pins: [{ label: 'A', loc: [0, 1] }] }] }, /pin "A" at \[0,1\] is off the board/],
  ['component pin with a fractional loc is rejected',
    { board: five, components: [{ id: 'x', pins: [{ label: 'A', loc: [1.5, 2] }] }] }, /loc must be a \[col, row\] coordinate of whole numbers/],
  ['component pin off the DEFAULT 20x20 board (no board given) is rejected',
    { components: [{ id: 'x', pins: [{ label: 'A', loc: [21, 1] }] }] }, /off the board.*20 cols × 20 rows/],
  ['net [col,row] endpoint at [99,99] on a 5x5 board is rejected',
    { board: five, nets: [{ id: 'N1', from: [1, 1], to: [99, 99] }] }, /net N1\.to = \[99,99\] is off the board/],
  ['net endpoint with non-integer coords is rejected',
    { board: five, nets: [{ id: 'N1', from: [1, 1], to: [2.5, 2] }] }, /net N1\.to = \[2\.5,2\].*whole numbers/],
  ['net endpoint of the wrong shape ([1,2,3]) is rejected',
    { board: five, nets: [{ id: 'N1', from: [1, 2, 3], to: [1, 1] }] }, /net N1\.from = \[1,2,3\].*whole numbers/],
  ['net endpoint naming an unknown COMPONENT in board mode is rejected (used to crash render)',
    { board: five, components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }], nets: [{ id: 'N1', from: 'nope.GND', to: [2, 2] }] },
    /net N1\.from = "nope\.GND": no component "nope" — components: esp/],
  ['net endpoint naming an unknown PIN in board mode is rejected (used to crash render)',
    { board: five, components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }], nets: [{ id: 'N1', from: 'esp.NOPE', to: [2, 2] }] },
    /net N1\.from = "esp\.NOPE": component "esp" has no pin "NOPE" — its pins: GND/],
  ['net endpoint {comp,pin} object form with an unknown pin is rejected',
    { board: five, components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }], nets: [{ id: 'N1', from: { comp: 'esp', pin: 'X' }, to: [2, 2] }] },
    /has no pin "X"/],
  ['net endpoint that is neither a hole nor a reference is rejected',
    { board: five, nets: [{ id: 'N1', from: 'justtext', to: [2, 2] }] }, /neither a \[col, row\] hole nor a "component\.pin" reference/],
  ['net with a missing endpoint is rejected',
    { board: five, nets: [{ id: 'N1', from: [1, 1] }] }, /net N1\.to = undefined is neither/],
  ['label key off the board is rejected',
    { board: five, labels: { '9,9': 'G' } }, /label "G" at hole \(9,9\) is off the board/],
  ['label key that is not "col,row" is rejected',
    { board: five, labels: { 'abc': 'G' } }, /label key "abc" is not a "col,row" hole coordinate/],
  ['labels that is not an object is rejected',
    { board: five, labels: ['1,1'] }, /labels must be an object/],
  ['component span extending off the board is rejected',
    { board: five, components: [{ id: 'x', span: [[1, 1], [9, 2]] }] }, /span \[\[1,1\],\[9,2\]\] extends off the board/],
  ['malformed component span is rejected (renderer destructures it)',
    { board: five, components: [{ id: 'x', span: [1, 1, 3, 3] }] }, /span must be \[\[col, row\], \[col, row\]\]/],
  ['explicit rail run off the board is rejected',
    { board: { cols: 5, rows: 5, rails: [{ row: 1, c0: 1, c1: 30 }] } }, /board\.rails\[0\].*runs off the board/],
  ['explicit segment run of the wrong shape is rejected',
    { board: { cols: 5, rows: 5, segments: [{ c0: 1, c1: 3 }] } }, /board\.segments\[0\]: a run is either/],
  ['duplicate component ids are rejected',
    { components: [{ id: 'esp', pins: [] }, { id: 'esp', pins: [] }] }, /duplicate component id "esp"/],
  ['duplicate net ids are rejected (docs: net ids are unique)',
    { nets: [{ id: 'N1', from: [1, 1], to: [2, 2] }, { id: 'N1', from: [3, 3], to: [4, 4] }] }, /duplicate net id "N1"/],
  ['a component without an id is rejected',
    { components: [{ pins: [] }] }, /components\[0\]: missing id/],
  ['a net without an id is rejected (docs: id is required)',
    { nets: [{ from: [1, 1], to: [2, 2] }] }, /nets\[0\]: missing id/],
  ['components that is not an array is rejected',
    { components: { esp: {} } }, /components must be an array/],
  ['a net entry that is not an object is rejected',
    { nets: ['N1'] }, /nets\[0\] must be an object/],
  // ---- id grammar: non-empty string, /^[A-Za-z0-9][A-Za-z0-9_-]*$/ ----
  ['id "__proto__" is rejected by the grammar (and NOT falsely reported as a duplicate)',
    { components: [{ id: '__proto__', pins: [] }] }, /components\[0\]: id "__proto__" is not a valid id/],
  ['a numeric id (0) is rejected — ids are strings',
    { components: [{ id: 0, pins: [] }] }, /components\[0\]: id 0 is not a valid id/],
  ['a numeric net id is rejected — ids are strings',
    { nets: [{ id: 1, from: [1, 1], to: [2, 2] }] }, /nets\[0\]: id 1 is not a valid id/],
  ['an empty-string id is rejected',
    { components: [{ id: '', pins: [] }] }, /components\[0\]: id "" is not a valid id/],
  ['a whitespace-only id is rejected',
    { components: [{ id: '   ', pins: [] }] }, /components\[0\]: id "   " is not a valid id/],
  ['an id with inner whitespace is rejected',
    { components: [{ id: 'my part', pins: [] }] }, /id "my part" is not a valid id/],
  ['an id containing a dot is rejected (it would break "component.pin" parsing)',
    { components: [{ id: 'a.b', pins: [] }] }, /id "a\.b" is not a valid id/],
  ['an id starting with "-" or "_" is rejected',
    { components: [{ id: '-x', pins: [] }, { id: '_y', pins: [] }] }, /id "_y" is not a valid id/],
  ['an id with quotes is rejected (it would break the [data-id="…"] selector)',
    { nets: [{ id: 'a"b', from: [1, 1], to: [2, 2] }] }, /id "a\\"b" is not a valid id/],
  ['two components both named "constructor" ARE a duplicate (prototype-free lookup)',
    { components: [{ id: 'constructor', pins: [] }, { id: 'constructor', pins: [] }] }, /duplicate component id "constructor"/],
  // ---- point-to-point: unresolved endpoints + bad loc are fatal, not warnings ----
  ['p2p: net endpoint naming an unknown PIN (a.X → a.NOPE) is a hard error (was: warning + silently dropped wire)',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X' }] }], nets: [{ id: 'N1', from: 'a.X', to: 'a.NOPE' }] },
    /net N1\.to = "a\.NOPE": component "a" has no pin "NOPE" — its pins: X/],
  ['p2p: net endpoint naming an unknown COMPONENT is a hard error',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X' }] }], nets: [{ id: 'N1', from: 'zz.X', to: 'a.X' }] },
    /net N1\.from = "zz\.X": no component "zz" — components: a/],
  ['p2p: a [col,row] endpoint that is no pin\'s loc is a hard error',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X', loc: [1, 1] }] }], nets: [{ id: 'N1', from: [1, 1], to: [7, 7] }] },
    /net N1\.to = \[7,7\] is not the loc of any component pin/],
  ['p2p: a pin loc that is a string ("oops") is rejected (renderer used to throw p.loc.join)',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X', loc: 'oops' }] }], nets: [] },
    /component a pin "X": loc, when given, must be a \[col, row\] coordinate.*got "oops"/],
  ['p2p: a pin loc of the wrong shape ([1]) is rejected',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X', loc: [1] }] }], nets: [] },
    /loc, when given, must be a \[col, row\] coordinate/],
];
for (const [name, spec, want] of geomCases) {
  const msgs = WG.validate(spec).errors.map(strip);
  const hit = msgs.some(m => want.test(m));
  report(`fail-closed: ${name}`, hit, hit ? msgs.find(m => want.test(m)) : ('got: ' + (msgs.join(' | ') || 'NO ERRORS')));
}
// …and the boundaries / valid forms those checks must NOT reject.
const geomPositives = [
  ['pins/nets/labels/span on the board EDGES (1,1)…(cols,rows) are accepted',
    { board: five, components: [{ id: 'x', span: [[1, 1], [5, 5]], pins: [{ label: 'A', loc: [1, 1] }, { label: 'B', loc: [5, 5] }] }],
      labels: { '1,1': 'a', '5,5': 'b' }, nets: [{ id: 'N1', from: [1, 1], to: [5, 5] }] }],
  ['a "component.pin" endpoint in board mode that resolves is accepted',
    { board: five, components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }], nets: [{ id: 'N1', from: 'esp.GND', to: [2, 2] }] }],
  ['a {comp,pin} endpoint in board mode that resolves is accepted',
    { board: five, components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }], nets: [{ id: 'N1', from: { comp: 'esp', pin: 'GND' }, to: [2, 2] }] }],
  ['every built-in preset name is accepted',
    { board: { preset: 'jumperless-v5' } }],
  ['a preset with a cols override is accepted',
    { board: { preset: 'breadboard-half', cols: 10 } }],
  ['explicit rails/segments inside the grid are accepted',
    { board: { cols: 5, rows: 5, rails: [{ row: 1, c0: 1, c1: 5 }], segments: [{ col: 2, r0: 1, r1: 5 }] } }],
  ['point-to-point mode ignores the board and does not range-check loc (no board to be off of)',
    { mode: 'point-to-point', board: { preset: 'nonsense' }, components: [{ id: 'a', pins: [{ label: 'X', loc: [99, 99] }] }], nets: [{ id: 'N1', from: 'a.X', to: 'a.X' }] }],
  ['p2p: a [col,row] endpoint that IS a pin loc reverse-resolves clean (board spec flipped to p2p)',
    { mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X', loc: [1, 1] }, { label: 'Y', loc: [2, 2] }] }], nets: [{ id: 'N1', from: [1, 1], to: [2, 2] }] }],
  ['reversed span corners ([[5,5],[1,1]]) are accepted (renderer normalizes)',
    { board: five, components: [{ id: 'x', span: [[5, 5], [1, 1]], pins: [] }] }],
  ['reversed rail/segment runs (c1 < c0, r1 < r0) are accepted (renderer normalizes)',
    { board: { cols: 5, rows: 5, rails: [{ row: 1, c0: 5, c1: 1 }], segments: [{ col: 2, r0: 5, r1: 1 }] } }],
  ['electrocookie boards as a positive integer and as {x,y} are both accepted',
    { board: { preset: 'electrocookie-strip', boards: 2 }, nets: [{ id: 'A', from: [1, 1], to: [34, 19] }] }],
  ['electrocookie boards:{y:3} is accepted — missing x defaults to 1 (1x3 → 17x57)',
    { board: { preset: 'electrocookie-strip', boards: { y: 3 } }, nets: [{ id: 'A', from: [1, 1], to: [17, 57] }] }],
  ['electrocookie boards:{x:2} is accepted — missing y defaults to 1 (2x1 → 34x19)',
    { board: { preset: 'electrocookie-strip', boards: { x: 2 } }, nets: [{ id: 'A', from: [1, 1], to: [34, 19] }] }],
  ['electrocookie boards:{x:2,y:3} is accepted (2x3 → 34x57)',
    { board: { preset: 'electrocookie-strip', boards: { x: 2, y: 3 } }, nets: [{ id: 'A', from: [1, 1], to: [34, 57] }] }],
  ['a 200x100 board (exactly 20000 holes) is accepted',
    { board: { cols: 200, rows: 100 } }],
  ['ids using the full grammar (letters, digits, "_", "-") are accepted; "constructor" is a legal id',
    { board: five, components: [{ id: 'constructor', pins: [] }, { id: 'R1a', pins: [] }, { id: 'led_2-b', pins: [] }, { id: '3v3', pins: [] }],
      nets: [{ id: 'N-1_x', from: [1, 1], to: [2, 2] }] }],
];
for (const [name, spec] of geomPositives) {
  const msgs = WG.validate(spec).errors.map(strip);
  report(`fail-closed positive: ${name}`, msgs.length === 0, msgs.join(' | ') || 'clean');
}
// exact-count checks the regex table can't express
{
  // the accepted boards forms resolve to the grid the docs promise (the
  // [1,1]→[cols,rows] nets above prove the far corner is ON the board; this
  // proves one past it is not, i.e. the grid is exactly that size)
  const ec = (boards, to) => WG.validate({ board: { preset: 'electrocookie-strip', boards }, nets: [{ id: 'A', from: [1, 1], to }] }).errors.map(strip);
  report('boards: {x:2} resolves to exactly 34x19 (col 35 is off the board)',
    ec({ x: 2 }, [35, 19]).some(m => /off the board — the board is 34 cols × 19 rows/.test(m)), ec({ x: 2 }, [35, 19]).join(' | '));
  report('boards: {x:2,y:3} resolves to exactly 34x57 (row 58 is off the board)',
    ec({ x: 2, y: 3 }, [34, 58]).some(m => /off the board — the board is 34 cols × 57 rows/.test(m)), ec({ x: 2, y: 3 }, [34, 58]).join(' | '));

  const one = WG.validate({ components: [{ id: '__proto__', pins: [] }] }).errors.map(strip);
  report('ids: a single "__proto__" component yields exactly ONE error (grammar), no phantom duplicate',
    one.length === 1 && !one.some(m => /duplicate/.test(m)), one.join(' | '));
  const ctor = WG.validate({ components: [{ id: 'constructor', pins: [] }], nets: [{ id: 'N1', from: 'constructor.X', to: 'constructor.X' }] }).errors.map(strip);
  report('ids: net referencing constructor.X resolves the COMPONENT "constructor" (no prototype phantom) and reports the missing pin',
    ctor.length === 2 && ctor.every(m => /component "constructor" has no pin "X"/.test(m)), ctor.join(' | '));
}

// ---- 3. schema is object-array only ----
const oldPins = { components: [{ id: 'x', pins: { 'ANY 99 NAME': [1, 1] } }] };
report('old object pins schema is rejected', WG.validate(oldPins).errors.some(e => /must be an array/.test(strip(e))),
  WG.validate(oldPins).errors.map(strip).join(' | '));
const oldPairs = { components: [{ id: 'x', pins: [['GND', [1, 1]]] }] };
report('old [label, loc] pair pins schema is rejected', WG.validate(oldPairs).errors.some(e => /need an object with string label/.test(strip(e))),
  WG.validate(oldPairs).errors.map(strip).join(' | '));

// ---- 4. board footprint span warnings ----
// (explicit 24-col board: [22,5] must be ON the board for the span check to be
// the thing under test — off-board holes are a hard error now, see §2d)
const wide = { preset: 'perf', cols: 24, rows: 16 };
const outsideSpan = WG.validate({ board: wide, components: [{ id: 'esp', span: [[1, 5], [19, 13]], pins: [{ label: 'GND', loc: [22, 5] }] }] });
const outsideSpanMsgs = outsideSpan.warnings.map(strip);
report('warning: a board pin outside its component span is surfaced',
  outsideSpan.errors.length === 0 && outsideSpanMsgs.some(m => m === 'component esp pin "GND" at [22,5] is outside its span [[1,5],[19,13]]'),
  outsideSpanMsgs.join(' | '));

const withinSpan = WG.validate({ components: [{ id: 'esp', span: [[19, 13], [1, 5]], pins: [
  { label: 'EDGE', loc: [1, 5] }, { label: 'INSIDE', loc: [12, 9] },
] }] });
report('warning: pins on or inside normalized span bounds do not warn',
  withinSpan.errors.length === 0 && withinSpan.warnings.length === 0,
  withinSpan.warnings.map(strip).join(' | '));

const noSpan = WG.validate({ board: wide, components: [{ id: 'boardless', pins: [{ label: 'GND', loc: [22, 5] }] }] });
report('warning: a board component without a span does not warn',
  noSpan.errors.length === 0 && noSpan.warnings.length === 0,
  noSpan.warnings.map(strip).join(' | '));

// ---- 5. render regression: repeated labels stay separate and notes reach the table ----
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = {};
    this.childNodes = [];
    this.classList = { add() {}, toggle() {} };
    this.style = {};
    this.textContent = '';
    this._innerHTML = '';
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { this.childNodes.push(child); return child; }
  addEventListener() {}
  set innerHTML(value) { this._innerHTML = String(value); if (value === '') this.childNodes = []; }
  get innerHTML() { return this._innerHTML; }
}
const fakeDocument = {
  head: new FakeElement('head'),
  createElement: tag => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  getElementById(id) {
    const walk = node => node.attrs.id === id ? node : node.childNodes.map(walk).find(Boolean);
    return walk(this.head);
  },
};
const descendants = node => [node].concat(...node.childNodes.map(descendants));
try {
  global.document = fakeDocument;
  const mount = new FakeElement('div');
  WG.render({
    components: [{ id: 'esp', label: 'ESP32', pins: [
      { label: 'GND', loc: [2, 5], notes: 'The first ground pin' },
      { label: 'GND', loc: [3, 5] },
    ] }],
    nets: [],
  }, mount);
  const gndLabels = descendants(mount).filter(n => n.tagName === 'text' && n.attrs.class === 'hlabel' && n.textContent === 'GND');
  const distinctHoles = new Set(gndLabels.map(n => n.attrs.x + ',' + n.attrs.y));
  const noteInPinTable = descendants(mount).some(n => n.tagName === 'table' && /Notes/.test(n.innerHTML) && /The first ground pin/.test(n.innerHTML));
  report('render: two GND labels occupy distinct holes and notes appear in pin table', distinctHoles.size === 2 && noteInPinTable,
    `GND holes: ${Array.from(distinctHoles).join(' / ')}; note in table: ${noteInPinTable}`);

  const warningMount = new FakeElement('div');
  WG.render({ board: wide, components: [{ id: 'esp', span: [[1, 5], [19, 13]], pins: [{ label: 'GND', loc: [22, 5] }] }], nets: [] }, warningMount);
  const warningBanner = descendants(warningMount).some(n => n.tagName === 'div' &&
    /validation warning\(s\).*outside its span/.test(n.innerHTML));
  report('render: validation warnings appear in the guide', warningBanner);
} catch (err) {
  report('render: two GND labels occupy distinct holes and notes appear in pin table', false, err.stack || err.message);
} finally {
  delete global.document;
}

// ---- 6. render-path / SVG-geometry tests (extends coverage beyond validation) ----
// Kept in a separate module (test/render.js) but run here so the single command
// CI invokes — `node test/run-validation.js` — exercises both suites and shares
// this pass/fail accounting.
require('./render.js').run(report);

// ---- 7. standalone-export serialization safety (index.html "Download standalone
// HTML"): a spec field containing a script-closing string must not break the
// exported document. Same single-command-CI pattern as render.js above.
require('./export-safety.js').run(report);

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
