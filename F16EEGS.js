
(function () {
  'use strict';

  const CFG = {
    toggleKey: 'u',          // shift+U = reload gun
    startEnabled: true,
    onlyF16: true,
    cockpitOnly: true,
    orientationSource: 'aircraft',
    muzzleVelocity: 1050,
    drag: 0.4,
    gravity: 9.81,
    wingspan: 10.7,     
    minRange: 150,
    maxRange: 2400,
    tickRanges: [500, 1000, 1500, 2000],
    step: 0.03,
    maxTime: 4,
    hudFov: { w: 18, h: 20 },   
    hudOffset: { x: 0, y: 0 },  
    showHudFrame: false,        
    maskBottom: 0.62,           
    ammo: 510,
    fireRate: 100,
    fireCode: 'Backslash',
    tracers: true,
    tracerEvery: 5,
    tracerMinDist: 25,      
    tracerColor: '#eb9800',
    impactColor: '#707070',  
    color: '#94ffaf',
    
    lineDeg: 0.12,           
    counterTextDeg: 1.1,     
    tickTextDeg: 0.8,        
    crossDeg: 0.7,           

    sound: true,             
    gunVolume: 0.7,          
  };


  const deg = Math.PI / 180;
  const R_EARTH = 6378137;
  const RADAR_RANGE_NM = 70;
  let enabled = CFG.startEnabled;
  let toast = { text: '', until: 0 };
  let canvas, ctx, dpr = 1;
  let ammo = CFG.ammo, firing = false, fireAcc = 0, tracerAcc = 0, lastFrame = 0, lastInst = null;
  let missileAmmo = 2, weaponIndex = 0;
  const WEAPONS = ['GUN', 'AIM-9X'];
  let targetMode = false, selectedTargetId = null, lockedTargetId = null, currentTargets = [];
  let tracers = [], missiles = [], impacts = [];
  let countermeasures = [];
  let lastPos = null, lastT = 0, prevAxes = null;
  const vel = [0, 0, 0];
  const omega = [0, 0, 0];


  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];


  function ready() {
    return window.geofs && geofs.aircraft && geofs.aircraft.instance &&
      geofs.api && geofs.api.viewer && window.Cesium &&
      geofs.animation && geofs.animation.values;
  }

  function isF16() {
    if (!CFG.onlyF16) return true;
    const inst = geofs.aircraft.instance;
    const names = [inst.aircraftRecord && inst.aircraftRecord.name,
      inst.definition && inst.definition.name].filter(Boolean).join(' ');
    return /f[-\s]?16/i.test(names);
  }

  function inCockpit() {
    if (!CFG.cockpitOnly) return true;
    const c = geofs.camera;
    if (!c) return true;
    const name = String(c.currentModeName || '').toLowerCase();
    return name ? name.includes('cockpit') : c.currentMode === 0;
  }

  function typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable);
  }

  function getRadarTargets() {
    const own = geofs.aircraft.instance.llaLocation;
    if (!own || !window.multiplayer || !window.multiplayer.visibleUsers) return [];
    const ownHeading = Number(geofs.animation.values.heading360 || geofs.animation.values.heading) || 0;
    const rangeLimit = RADAR_RANGE_NM * 1852;
    const targets = [];

    for (const user of Object.values(window.multiplayer.visibleUsers)) {
      const co = user && user.lastUpdate && user.lastUpdate.co;
      if (!Array.isArray(co) || co.length < 3) continue;
      const lat = Number(co[0]), lon = Number(co[1]), alt = Number(co[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) continue;

      const dLat = (lat - own[0]) * deg;
      const dLon = (lon - own[1]) * deg;
      const lat1 = own[0] * deg, lat2 = lat * deg;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      const groundDistance = 2 * R_EARTH * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = Math.hypot(groundDistance, alt - own[2]);
      if (!Number.isFinite(distance) || distance < 50 || distance > rangeLimit) continue;

      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      const bearing = (Math.atan2(y, x) / deg + 360) % 360;
      const id = String(user.id ?? user.uid ?? user.callsign ?? user.cs ?? '');
      if (!id) continue;
      targets.push({
        id,
        callsign: String(user.callsign ?? user.cs ?? user.aircraftName ?? 'CONTACT'),
        lat, lon, alt, bearing,
        rangeNm: distance / 1852,
        relativeBearing: ((bearing - ownHeading + 540) % 360) - 180,
      });
    }

    targets.sort((a, b) => a.rangeNm - b.rangeNm);
    return targets;
  }

  function selectTarget(step) {
    if (!currentTargets.length) {
      selectedTargetId = null;
      lockedTargetId = null;
      toast = { text: 'RADAR: NO CONTACTS', until: performance.now() + 1500 };
      return;
    }
    const index = currentTargets.findIndex(target => target.id === selectedTargetId);
    const next = index < 0
      ? (step > 0 ? 0 : currentTargets.length - 1)
      : (index + step + currentTargets.length) % currentTargets.length;
    selectedTargetId = currentTargets[next].id;
    lockedTargetId = null;
    const target = currentTargets[next];
    toast = { text: 'TARGET: ' + target.callsign, until: performance.now() + 1500 };
  }

  function drawHudTarget(scene, target, bounds) {
    if (!target) return;
    const world = Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.alt);
    const project = Cesium.SceneTransforms.worldToWindowCoordinates ||
      Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const point = project.call(Cesium.SceneTransforms, scene, world);
    if (!point) return;

    const rect = scene.canvas.getBoundingClientRect();
    const scale = rect.width / scene.canvas.clientWidth || 1;
    const x = rect.left + point.x * scale + CFG.hudOffset.x;
    const y = rect.top + point.y * scale + CFG.hudOffset.y;
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;

    const size = 22;
    const half = size / 2;
    const color = target.id === lockedTargetId ? '#ff5959' : CFG.color;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.strokeRect(x - half, y - half, size, size);
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(target.callsign.slice(0, 14), x + half + 4, y - 2);
    ctx.textBaseline = 'top';
    ctx.fillText(target.rangeNm.toFixed(1) + ' NM', x + half + 4, y + 2);
    ctx.restore();
  }

  function releaseCountermeasures() {
    if (!ready()) return;
    const now = performance.now();
    const lla = geofs.aircraft.instance.llaLocation;
    if (!lla) return;
    const origin = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(lla[1], lla[0], lla[2]));
    const axes = bodyAxes();
    const invOrigin = Cesium.Matrix4.inverseTransformation(origin, new Cesium.Matrix4());
    for (let i = 0; i < 18; i++) {
      const lateral = (Math.random() - 0.5) * 8;
      countermeasures.push({
        type: 'chaff', t0: now, life: 2.2,
        origin, invOrigin,
        offset: add(mul(axes[0], -7), mul(axes[1], lateral)),
        velocity: add(mul(axes[0], -12 - Math.random() * 8),
          mul(axes[1], (Math.random() - 0.5) * 12)),
        size: 1 + Math.random() * 1.5,
      });
    }
    for (let i = 0; i < 3; i++) {
      countermeasures.push({
        type: 'flare', t0: now, life: 1.8,
        origin, invOrigin,
        offset: add(mul(axes[0], -7), mul(axes[1], (Math.random() - 0.5) * 5)),
        velocity: add(mul(axes[0], -18 - Math.random() * 8),
          [0, 0, -3 - Math.random() * 4]),
        size: 3 + Math.random() * 2,
      });
    }
    countermeasureSound();
    toast = { text: 'CHAFF / FLARE RELEASED', until: now + 1500 };
  }

  function drawCountermeasures(scene) {
    const now = performance.now();
    countermeasures = countermeasures.filter(p => now - p.t0 < p.life);
    if (!countermeasures.length) return;
    const lla = geofs.aircraft.instance.llaLocation;
    if (!lla) return;
    const fn = Cesium.SceneTransforms.worldToWindowCoordinates ||
      Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const rect = scene.canvas.getBoundingClientRect();
    const aircraftWorld = Cesium.Cartesian3.fromDegrees(lla[1], lla[0], lla[2]);
    ctx.save();
    for (const p of countermeasures) {
      const age = (now - p.t0) / 1000;
      const alpha = 1 - age / p.life;
      const aircraftPosition = Cesium.Matrix4.multiplyByPoint(
        p.invOrigin, aircraftWorld, new Cesium.Cartesian3());
      const offset = add(aircraftPosition,
        add(p.offset, add(mul(p.velocity, age), [0, 0, -4.905 * age * age])));
      const world = Cesium.Matrix4.multiplyByPoint(
        p.origin, new Cesium.Cartesian3(offset[0], offset[1], offset[2]), new Cesium.Cartesian3());
      const screen = fn.call(Cesium.SceneTransforms, scene, world);
      if (!screen) continue;
      const x = rect.left + screen.x, y = rect.top + screen.y;
      ctx.globalAlpha = alpha;
      if (p.type === 'flare') {
        ctx.fillStyle = '#ffd26a';
        ctx.shadowColor = '#ff5a18';
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (1 - age / p.life * 0.35) + 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#e7edf2';
        ctx.shadowColor = '#d8e4ef';
        ctx.shadowBlur = 8;
        ctx.fillRect(x, y, p.size + 2, p.size + 1);
      }
    }
    ctx.restore();
  }


  function cameraAxes() {
    const cam = geofs.api.viewer.scene.camera;
    const inv = Cesium.Matrix4.inverseTransformation(
      Cesium.Transforms.eastNorthUpToFixedFrame(cam.positionWC), new Cesium.Matrix4());
    const enu = (c) => {
      const o = Cesium.Matrix4.multiplyByPointAsVector(inv, c, new Cesium.Cartesian3());
      return [o.x, o.y, o.z];
    };
    return [enu(cam.directionWC), enu(cam.rightWC), mul(enu(cam.upWC), -1)];
  }

  function aircraftAxes(hs, ps, rs) {
    const v = geofs.animation.values;
    const h = (v.heading360 || 0) * deg * hs;
    const p = (v.atilt || 0) * deg * ps;
    const r = (v.aroll || 0) * deg * rs;
    const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
    const right0 = [Math.cos(h), -Math.sin(h), 0];
    const up0 = cross(right0, fwd);
    const c = Math.cos(r), s = Math.sin(r);
    const right = add(mul(right0, c), mul(up0, -s));
    const up = add(mul(right0, s), mul(up0, c));
    return [fwd, right, mul(up, -1)];
  }

  const COMBOS = [];
  for (const hs of [1, -1]) for (const ps of [1, -1]) for (const rs of [1, -1]) COMBOS.push([hs, ps, rs]);
  const scores = COMBOS.map(() => 0);
  let best = 0;

  function bodyAxes() {
    const cam = cameraAxes();
    if (CFG.orientationSource === 'camera') return cam;
    const all = COMBOS.map(c => aircraftAxes(c[0], c[1], c[2]));
    if (inCockpit()) {
      for (let i = 0; i < all.length; i++) {
        const m = dot(all[i][0], cam[0]) + dot(all[i][1], cam[1]) + dot(all[i][2], cam[2]);
        scores[i] = scores[i] * 0.99 + m;
      }
      for (let i = 0; i < scores.length; i++) if (scores[i] > scores[best] + 3) best = i;
    }
    return all[best];
  }


  function updateMotion(axes) {
    const lla = geofs.aircraft.instance.llaLocation;
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    if (lla && lastPos && dt > 0.001 && dt < 0.5) {
      const a = Math.min(1, dt * 8);
      const n = (lla[0] - lastPos[0]) * deg * R_EARTH / dt;
      const e = (lla[1] - lastPos[1]) * deg * R_EARTH * Math.cos(lla[0] * deg) / dt;
      const u = (lla[2] - lastPos[2]) / dt;
      if (Math.hypot(e, n, u) < 1500) {
        vel[0] += (e - vel[0]) * a;
        vel[1] += (n - vel[1]) * a;
        vel[2] += (u - vel[2]) * a;
      }
      if (prevAxes) {
        const d = (i, j) => dot(prevAxes[i], axes[j]);
        const w = [(d(2, 1) - d(1, 2)) / (2 * dt),
                   (d(0, 2) - d(2, 0)) / (2 * dt),
                   (d(1, 0) - d(0, 1)) / (2 * dt)];
        if (Math.hypot(w[0], w[1], w[2]) < 4) {
          const b = Math.min(1, dt * 6);
          for (let i = 0; i < 3; i++) omega[i] += (w[i] - omega[i]) * b;
        }
      }
    }
    lastPos = lla ? lla.slice() : null;
    lastT = now;
    prevAxes = axes;
  }

  function inRotatedFrame(v, t) {
    const m = Math.hypot(omega[0], omega[1], omega[2]);
    const th = m * t;
    if (th < 1e-6) return v;
    const k = [omega[0] / m, omega[1] / m, omega[2] / m];
    const c = Math.cos(th), s = Math.sin(th);
    const kxv = cross(k, v), kdv = dot(k, v);
    return [v[0] * c - kxv[0] * s + k[0] * kdv * (1 - c),
            v[1] * c - kxv[1] * s + k[1] * kdv * (1 - c),
            v[2] * c - kxv[2] * s + k[2] * kdv * (1 - c)];
  }


  function toScreen(enuMat, scene, p, raw) {
    const w = Cesium.Matrix4.multiplyByPoint(enuMat, new Cesium.Cartesian3(p[0], p[1], p[2]), new Cesium.Cartesian3());
    const fn = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const s = fn.call(Cesium.SceneTransforms, scene, w);
    if (!s) return null;
    const rect = scene.canvas.getBoundingClientRect();
    const k = rect.width / scene.canvas.clientWidth || 1;
    const ox = raw ? 0 : CFG.hudOffset.x, oy = raw ? 0 : CFG.hudOffset.y;
    return { x: rect.left + s.x * k + ox, y: rect.top + s.y * k + oy };
  }

  function worldPosition(enuMat, p) {
    return Cesium.Matrix4.multiplyByPoint(
      enuMat, new Cesium.Cartesian3(p[0], p[1], p[2]), new Cesium.Cartesian3());
  }

  function turnVelocity(velocity, desired, maxAngle) {
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    const desiredSpeed = Math.hypot(desired[0], desired[1], desired[2]);
    if (speed < 1e-6 || desiredSpeed < 1e-6) return velocity;

    const current = mul(velocity, 1 / speed);
    const target = mul(desired, 1 / desiredSpeed);
    const cosine = Math.max(-1, Math.min(1, dot(current, target)));
    const angle = Math.acos(cosine);
    if (angle < 1e-6) return mul(target, speed);

    const axisVector = cross(current, target);
    const axisLength = Math.hypot(axisVector[0], axisVector[1], axisVector[2]);
    let axis;
    if (axisLength < 1e-6) {
      axis = cross(current, Math.abs(current[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
      const length = Math.hypot(axis[0], axis[1], axis[2]);
      axis = mul(axis, 1 / length);
    } else {
      axis = mul(axisVector, 1 / axisLength);
    }

    const turn = Math.min(angle, maxAngle);
    const c = Math.cos(turn), s = Math.sin(turn);
    const rotated = add(add(mul(current, c), mul(cross(axis, current), s)),
      mul(axis, dot(axis, current) * (1 - c)));
    return mul(rotated, speed);
  }




  let actx = null, gunBuf = null, gunFilter = null, gunGain = null, gunSrc = null, soundOn = false;

  function initAudio() {
    if (actx || !CFG.sound) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    const sr = actx.sampleRate;
    const period = Math.round(sr / CFG.fireRate);          
    const rounds = 60;
    const len = period * rounds;
    gunBuf = actx.createBuffer(1, len, sr);
    const d = gunBuf.getChannelData(0);
    for (let r = 0; r < rounds; r++) {
      const amp = 0.8 + 0.2 * Math.random();
      const start = r * period;
      for (let n = 0; n < period * 2; n++) {
        const t = n / sr;
        const crack = (Math.random() * 2 - 1) * Math.exp(-t / 0.0012);      
        const thump = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t / 0.0055); 
        d[(start + n) % len] += amp * (0.55 * crack + 0.9 * thump);
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] /= (peak || 1);

    gunFilter = actx.createBiquadFilter();                  
    gunFilter.type = 'lowpass';
    gunFilter.frequency.value = 3200;
    gunGain = actx.createGain();
    gunGain.gain.value = 0.0001;
    const comp = actx.createDynamicsCompressor();
    gunFilter.connect(gunGain);
    gunGain.connect(comp);
    comp.connect(actx.destination);
  }

  function gunSound(on) {
    if (!actx || !gunBuf) return;
    const t = actx.currentTime;
    if (on && !soundOn) {
      soundOn = true;
      if (actx.state === 'suspended') actx.resume();
      gunSrc = actx.createBufferSource();
      gunSrc.buffer = gunBuf;
      gunSrc.loop = true;
      gunSrc.playbackRate.setValueAtTime(0.55, t);                   
      gunSrc.playbackRate.linearRampToValueAtTime(1, t + 0.25);
      gunSrc.connect(gunFilter);
      gunGain.gain.cancelScheduledValues(t);
      gunGain.gain.setValueAtTime(0.0001, t);
      gunGain.gain.linearRampToValueAtTime(CFG.gunVolume, t + 0.04);
      gunSrc.start(t);
    } else if (!on && soundOn) {
      soundOn = false;
      const src = gunSrc;
      gunGain.gain.cancelScheduledValues(t);
      gunGain.gain.setValueAtTime(Math.max(0.0001, gunGain.gain.value), t);
      gunGain.gain.linearRampToValueAtTime(0.0001, t + 0.2);         
      src.playbackRate.cancelScheduledValues(t);
      src.playbackRate.setValueAtTime(src.playbackRate.value, t);
      src.playbackRate.linearRampToValueAtTime(0.45, t + 0.2);
      src.stop(t + 0.22);
    }
  }

  function dryClick() {
    if (!actx || !CFG.sound) return;
    const sr = actx.sampleRate, n = Math.round(sr * 0.03);
    const b = actx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.004));
    const src = actx.createBufferSource(), g = actx.createGain(), f = actx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800;
    g.gain.value = CFG.gunVolume * 0.6;
    src.buffer = b;
    src.connect(f); f.connect(g); g.connect(actx.destination);
    src.start();
  }

  function countermeasureSound() {
    if (!CFG.sound) return;
    initAudio();
    if (!actx) return;
    if (actx.state === 'suspended') actx.resume();

    const now = actx.currentTime;
    const length = Math.round(actx.sampleRate * 0.18);
    const buffer = actx.createBuffer(1, length, actx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      samples[i] = (Math.random() * 2 - 1) * Math.exp(-i / (actx.sampleRate * 0.055));
    }
    const noise = actx.createBufferSource();
    const filter = actx.createBiquadFilter();
    const noiseGain = actx.createGain();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.7;
    noiseGain.gain.setValueAtTime(CFG.gunVolume * 0.45, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    noise.buffer = buffer;
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(actx.destination);
    noise.start(now);

    const pop = actx.createOscillator();
    const popGain = actx.createGain();
    pop.type = 'sine';
    pop.frequency.setValueAtTime(125, now);
    pop.frequency.exponentialRampToValueAtTime(55, now + 0.11);
    popGain.gain.setValueAtTime(CFG.gunVolume * 0.3, now);
    popGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    pop.connect(popGain);
    popGain.connect(actx.destination);
    pop.start(now);
    pop.stop(now + 0.13);
  }

  function missileSound() {
    if (!CFG.sound) return;
    initAudio();
    if (!actx) return;
    if (actx.state === 'suspended') actx.resume();

    const now = actx.currentTime;
    const oscillator = actx.createOscillator();
    const gain = actx.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(95, now);
    oscillator.frequency.exponentialRampToValueAtTime(520, now + 0.35);
    gain.gain.setValueAtTime(CFG.gunVolume * 0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    oscillator.connect(gain);
    gain.connect(actx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.42);
  }

  function launchMissile() {
    initAudio();
    if (missileAmmo <= 0) {
      dryClick();
      toast = { text: 'AIM-9X: NO AMMO', until: performance.now() + 1500 };
      return;
    }
    if (!ready() || !enabled || !isF16() || !inCockpit()) return;

    const selectedTarget = targetMode &&
      currentTargets.find(target => target.id === selectedTargetId);
    if (targetMode && !selectedTarget) {
      toast = { text: 'RADAR: SELECT A TARGET FIRST', until: performance.now() + 1500 };
      return;
    }
    const lla = geofs.aircraft.instance.llaLocation;
    if (!lla) return;
    const axes = bodyAxes();
    const now = performance.now();
    const origin = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(lla[1], lla[0], lla[2]));
    const start = mul(axes[0], 7);
    const velocity = add(vel, mul(axes[0], 850));
    missiles.push({
      enuMat: origin,
      invEnuMat: Cesium.Matrix4.inverseTransformation(origin, new Cesium.Matrix4()),
      t0: now,
      updatedAt: now,
      maxFlightTime: selectedTarget ? Math.max(8, selectedTarget.rangeNm * 1852 / 700 + 10) : 8,
      v0: velocity,
      start,
      position: start.slice(),
      velocity: velocity.slice(),
      trail: [],
      targetId: selectedTarget ? selectedTarget.id : null,
    });
    missileAmmo--;
    missileSound();
    toast = {
      text: selectedTarget ? 'AIM-9X LAUNCHED: ' + selectedTarget.callsign : 'AIM-9X LAUNCHED',
      until: now + 1500,
    };
  }

  function switchWeapon(step) {
    weaponIndex = (weaponIndex + step + WEAPONS.length) % WEAPONS.length;
    firing = false;
    gunSound(false);
    toast = { text: 'WEAPON: ' + WEAPONS[weaponIndex], until: performance.now() + 1500 };
  }

  function createCanvas() {
    canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: '9',
    });
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    };
    resize();
    addEventListener('resize', resize);
  }

  function polyline(pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!ready()) return;

    const axes = bodyAxes();
    updateMotion(axes);

    if (performance.now() < toast.until) {
      ctx.fillStyle = CFG.color;
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(toast.text, innerWidth / 2, 80);
    }
    const scene = geofs.api.viewer.scene;
    drawCountermeasures(scene);
    if (!enabled || !isF16() || !inCockpit()) {
      tracers = []; missiles = []; impacts = []; gunSound(false); return;
    }

    const camPos = scene.camera.positionWC;
    const enuMat = Cesium.Transforms.eastNorthUpToFixedFrame(camPos);
    const fovy = (scene.camera.frustum && scene.camera.frustum.fovy) || 1;
    const pxPerRad = (scene.canvas.clientHeight / 2) / Math.tan(fovy / 2);
    const maskY = innerHeight * CFG.maskBottom;
    const ang = (d) => pxPerRad * Math.tan(d * deg);   
    const lw = Math.max(1, ang(CFG.lineDeg));

  
    const nowMs = performance.now();
    const fdt = Math.min(0.1, Math.max(0, (nowMs - lastFrame) / 1000));
    lastFrame = nowMs;
    if (geofs.aircraft.instance !== lastInst) {
      lastInst = geofs.aircraft.instance;
      ammo = CFG.ammo;
      missileAmmo = 2;
      missiles = [];
      selectedTargetId = null;
      lockedTargetId = null;
    }
    currentTargets = targetMode || missiles.some(missile => missile.targetId) ? getRadarTargets() : [];
    if (selectedTargetId && !currentTargets.some(target => target.id === selectedTargetId)) {
      selectedTargetId = null;
    }
    if (lockedTargetId && !currentTargets.some(target => target.id === lockedTargetId)) {
      lockedTargetId = null;
      toast = { text: 'RADAR: TARGET LOST', until: nowMs + 1500 };
    }
    if (targetMode && !selectedTargetId && currentTargets.length) {
      selectedTargetId = currentTargets[0].id;
    }
    if (weaponIndex === 0 && firing && ammo > 0) {
      fireAcc += CFG.fireRate * fdt;
      const n = Math.min(Math.floor(fireAcc), ammo);
      fireAcc -= Math.floor(fireAcc);
      ammo -= n;
      tracerAcc += n;
      while (CFG.tracers && tracerAcc >= CFG.tracerEvery) {
        tracerAcc -= CFG.tracerEvery;
        tracers.push({ enuMat: Cesium.Matrix4.clone(enuMat), t0: nowMs,
          v0: add(vel, mul(axes[0], CFG.muzzleVelocity)) });
      }
    }

    gunSound(weaponIndex === 0 && firing && ammo > 0);

    ctx.strokeStyle = CFG.color;
    ctx.fillStyle = CFG.color;
    ctx.lineWidth = lw;
    ctx.shadowColor = CFG.color;
    ctx.shadowBlur = 3;

    const missileOffsets = (missile, t) => {
      const f = (1 - Math.exp(-0.03 * t)) / 0.03;
      return add(missile.start, add(mul(missile.v0, f), [0, 0, -0.75 * t * t]));
    };
    const liveMissiles = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, innerWidth, maskY);
    ctx.clip();
    for (const missile of missiles) {
      const t = (nowMs - missile.t0) / 1000;
      if (t > missile.maxFlightTime) continue;
      const target = missile.targetId &&
        currentTargets.find(contact => contact.id === missile.targetId);
      let position;
      if (target) {
        const targetWorld = Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.alt);
        const targetLocal = Cesium.Matrix4.multiplyByPoint(
          missile.invEnuMat, targetWorld, new Cesium.Cartesian3());
        const delta = [targetLocal.x - missile.position[0],
          targetLocal.y - missile.position[1], targetLocal.z - missile.position[2]];
        const distance = Math.hypot(delta[0], delta[1], delta[2]);
        const dt = Math.min(0.1, Math.max(0, (nowMs - missile.updatedAt) / 1000));
        const speed = 900;
        if (distance <= speed * dt + 15) {
          impacts.push({ pos: worldPosition(missile.enuMat,
            [targetLocal.x, targetLocal.y, targetLocal.z]), t0: nowMs });
          continue;
        }
        if (distance > 0) {
          missile.velocity = turnVelocity(missile.velocity, delta, 1.2 * dt);
          const velocityLength = Math.hypot(...missile.velocity) || 1;
          missile.velocity = mul(missile.velocity, speed / velocityLength);
          missile.position = add(missile.position, mul(missile.velocity, dt));
          missile.updatedAt = nowMs;
        }
        position = missile.position;
      } else {
        position = missileOffsets(missile, t);
      }
      const world = worldPosition(missile.enuMat, position);
      let hit = false;
      if (scene.globe && scene.globe.getHeight) {
        const cartographic = Cesium.Cartographic.fromCartesian(world);
        if (cartographic) {
          const height = scene.globe.getHeight(cartographic);
          if (height !== undefined && cartographic.height <= height) hit = true;
        }
      }
      if (hit) {
        impacts.push({ pos: world, t0: nowMs });
        continue;
      }
      liveMissiles.push(missile);

      const lastTrailPoint = missile.trail[missile.trail.length - 1];
      if (!lastTrailPoint || Math.hypot(
        position[0] - lastTrailPoint.position[0],
        position[1] - lastTrailPoint.position[1],
        position[2] - lastTrailPoint.position[2]) >= 5 ||
        nowMs - lastTrailPoint.t0 >= 75) {
        missile.trail.push({ position: position.slice(), t0: nowMs });
      }
      missile.trail = missile.trail.filter(point => nowMs - point.t0 < 1400);

      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      for (let i = 1; i < missile.trail.length; i++) {
        const previousPoint = missile.trail[i - 1];
        const currentPoint = missile.trail[i];
        const age = nowMs - currentPoint.t0;
        const fade = Math.max(0, 1 - age / 1400);
        const previousScreen = toScreen(missile.enuMat, scene, previousPoint.position, true);
        const currentScreen = toScreen(missile.enuMat, scene, currentPoint.position, true);
        if (!previousScreen || !currentScreen) continue;
        ctx.globalAlpha = 0.25 * fade;
        ctx.lineWidth = 1 + 2 * fade;
        ctx.shadowBlur = 4 * fade;
        ctx.beginPath();
        ctx.moveTo(previousScreen.x, previousScreen.y);
        ctx.lineTo(currentScreen.x, currentScreen.y);
        ctx.stroke();
      }

      const current = toScreen(missile.enuMat, scene, position, true);
      const previous = missile.trail.length > 1
        ? toScreen(missile.enuMat, scene, missile.trail[missile.trail.length - 2].position, true)
        : null;
      if (current) {
        if (previous) {
          const dx = current.x - previous.x, dy = current.y - previous.y;
          const angle = Math.atan2(dy, dx);
          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = '#ffb06a';
          ctx.shadowColor = '#ff7a24';
          ctx.shadowBlur = 9;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(current.x - Math.cos(angle) * 2, current.y - Math.sin(angle) * 2);
          ctx.lineTo(current.x - Math.cos(angle) * 10, current.y - Math.sin(angle) * 10);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.arc(current.x, current.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    missiles = liveMissiles;
    ctx.restore();

  
    if (CFG.tracers) {
      const offs = (tr, t) => {
        const f = (1 - Math.exp(-CFG.drag * t)) / CFG.drag;
        return [tr.v0[0] * f, tr.v0[1] * f, tr.v0[2] * f - 0.5 * CFG.gravity * t * t];
      };
      const alive = [];
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, innerWidth, maskY);
      ctx.clip();
      ctx.strokeStyle = CFG.tracerColor;
      ctx.shadowColor = CFG.tracerColor;
      ctx.shadowBlur = 6;
      ctx.lineWidth = Math.max(1.5, ang(0.15));
      for (const tr of tracers) {
        const t = (nowMs - tr.t0) / 1000;
        if (t > 3) continue;
        const pa = offs(tr, t);
        const wa = Cesium.Matrix4.multiplyByPoint(tr.enuMat, new Cesium.Cartesian3(pa[0], pa[1], pa[2]), new Cesium.Cartesian3());
        let hit = false;
        if (scene.globe && scene.globe.getHeight) {
          const c = Cesium.Cartographic.fromCartesian(wa);
          if (c) {
            const h = scene.globe.getHeight(c);
            if (h !== undefined && c.height <= h) hit = true;
          }
        }
        if (hit) { impacts.push({ pos: wa, t0: nowMs }); continue; }
        alive.push(tr);
        if (Math.hypot(pa[0], pa[1], pa[2]) < CFG.tracerMinDist) continue;
        const a = toScreen(tr.enuMat, scene, pa, true);
        const b = toScreen(tr.enuMat, scene, offs(tr, Math.max(0, t - 0.05)), true);
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
      }
      tracers = alive;

    
      impacts = impacts.filter(i => nowMs - i.t0 < 500);
      const fn = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
      const rect = scene.canvas.getBoundingClientRect();
      for (const i of impacts) {
        const s = fn.call(Cesium.SceneTransforms, scene, i.pos);
        if (!s) continue;
        const k = 1 - (nowMs - i.t0) / 500;
        ctx.globalAlpha = k;
        ctx.fillStyle = CFG.impactColor;
        ctx.shadowBlur = 0;      
        ctx.beginPath();
        ctx.arc(rect.left + s.x, rect.top + s.y, 2 + 6 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = CFG.color;
      ctx.fillStyle = CFG.color;
      ctx.lineWidth = lw;
      ctx.shadowColor = CFG.color;
      ctx.shadowBlur = 3;
    }

    const bs = toScreen(enuMat, scene, mul(axes[0], 1000));
    if (!bs) return;
    const halfW = pxPerRad * Math.tan(CFG.hudFov.w / 2 * deg);
    const halfH = pxPerRad * Math.tan(CFG.hudFov.h / 2 * deg);
    const top = bs.y - halfH;
    const bottom = Math.min(bs.y + halfH, maskY);
    if (CFG.showHudFrame) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.strokeRect(bs.x - halfW, top, halfW * 2, bs.y + halfH - top);
      ctx.strokeStyle = '#ff5050';
      ctx.beginPath(); ctx.moveTo(0, maskY); ctx.lineTo(innerWidth, maskY); ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(bs.x - halfW, top, halfW * 2, Math.max(0, bottom - top));
    ctx.clip();

    if (targetMode) {
      drawHudTarget(scene, currentTargets.find(target => target.id === selectedTargetId), {
        left: bs.x - halfW,
        right: bs.x + halfW,
        top,
        bottom,
      });
    }

  
    ctx.beginPath();
    const arm = ang(CFG.crossDeg);
    ctx.moveTo(bs.x - arm, bs.y); ctx.lineTo(bs.x + arm, bs.y);
    ctx.moveTo(bs.x, bs.y - arm); ctx.lineTo(bs.x, bs.y + arm);
    ctx.stroke();

    if (weaponIndex === 0) {
      const v0 = add(vel, mul(axes[0], CFG.muzzleVelocity));
      const pts = [];
      for (let t = CFG.step; t <= CFG.maxTime; t += CFG.step) {
        const f = (1 - Math.exp(-CFG.drag * t)) / CFG.drag;
        const bullet = add(mul(v0, f), [0, 0, -0.5 * CFG.gravity * t * t]);
        const rel = [bullet[0] - vel[0] * t, bullet[1] - vel[1] * t, bullet[2] - vel[2] * t];
        const b0 = [dot(axes[0], rel), dot(axes[1], rel), dot(axes[2], rel)];
        const b = inRotatedFrame(b0, t);
        const range = Math.hypot(b[0], b[1], b[2]);
        if (range < CFG.minRange) continue;
        if (range > CFG.maxRange) break;
        const dir = add(add(mul(axes[0], b[0] / range), mul(axes[1], b[1] / range)),
          mul(axes[2], b[2] / range));
        const screen = toScreen(enuMat, scene, mul(dir, 1000));
        if (screen) pts.push({ x: screen.x, y: screen.y, r: range });
      }

      if (pts.length >= 3) {
        const left = [], right = [];
        for (let i = 0; i < pts.length; i++) {
          const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
          let tx = next.x - prev.x, ty = next.y - prev.y;
          const len = Math.hypot(tx, ty) || 1;
          tx /= len;
          ty /= len;
          const half = (CFG.wingspan / 2) / pts[i].r * pxPerRad;
          left.push({ x: pts[i].x - ty * half, y: pts[i].y + tx * half, r: pts[i].r });
          right.push({ x: pts[i].x + ty * half, y: pts[i].y - tx * half, r: pts[i].r });
        }
        polyline(left);
        polyline(right);
        ctx.font = Math.max(6, ang(CFG.tickTextDeg)) + 'px monospace';
        ctx.textAlign = 'left';
        for (const range of CFG.tickRanges) {
          const i = left.findIndex(p => p.r >= range);
          if (i < 0) continue;
          ctx.beginPath();
          ctx.moveTo(left[i].x, left[i].y);
          ctx.lineTo(right[i].x, right[i].y);
          ctx.stroke();
          ctx.fillText((range / 1000).toFixed(1), right[i].x + ang(0.4), right[i].y + ang(0.3));
        }
      }
    } else {
      ctx.beginPath();
      ctx.arc(bs.x, bs.y, ang(5), Math.PI, Math.PI * 2);
      ctx.stroke();
    }

    ctx.font = 'bold ' + Math.max(8, ang(CFG.counterTextDeg)) + 'px monospace';
    ctx.textAlign = 'left';
    const weaponAmmo = weaponIndex === 0 ? ammo : missileAmmo;
    const weaponLabel = weaponIndex === 0 ? 'GUN' : 'AIM-9X';
    ctx.fillStyle = weaponAmmo > 0 ? CFG.color : '#ff0000';
    ctx.fillText(weaponAmmo > 0 ? weaponLabel + ' ' + String(weaponAmmo).padStart(3, '0') :
      weaponLabel + ' NO AMMO', bs.x - halfW + ang(0.5), bottom - ang(0.6));
    ctx.fillStyle = CFG.color;
    ctx.restore();

    ctx.shadowBlur = 0;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(WEAPONS[weaponIndex] + ' [- / =]  T TARGET MODE  , PREV / NEXT  ENTER LOCK  RELOAD [Shift+' +
      CFG.toggleKey.toUpperCase() + ']', 16, innerHeight - 16);
  }


  addEventListener('keydown', function (e) {
    if (typing(e)) return;
    if (e.code === 'KeyT' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (e.repeat) return;
      if (!ready()) return;
      targetMode = !targetMode;
      if (targetMode) {
        currentTargets = getRadarTargets();
        selectedTargetId = currentTargets.length ? currentTargets[0].id : null;
      } else {
        lockedTargetId = null;
      }
      toast = {
        text: targetMode ? 'TARGET MODE ON' : 'TARGET MODE OFF',
        until: performance.now() + 1500,
      };
      return;
    }
    if (targetMode && (e.code === 'Comma' || e.code === 'Slash')) {
      e.preventDefault();
      if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
        selectTarget(e.code === 'Slash' ? 1 : -1);
      }
      return;
    }
    if (targetMode && e.code === 'Enter') {
      e.preventDefault();
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!currentTargets.some(target => target.id === selectedTargetId)) {
        toast = { text: 'RADAR: SELECT A TARGET FIRST', until: performance.now() + 1500 };
      } else if (lockedTargetId === selectedTargetId) {
        lockedTargetId = null;
        toast = { text: 'TARGET UNLOCKED', until: performance.now() + 1500 };
      } else {
        lockedTargetId = selectedTargetId;
        const target = currentTargets.find(contact => contact.id === lockedTargetId);
        toast = { text: 'TARGET LOCKED: ' + target.callsign, until: performance.now() + 1500 };
      }
      return;
    }
    if (e.code === 'Equal' || e.code === 'Minus') {
      e.preventDefault();
      if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
        switchWeapon(e.code === 'Equal' ? 1 : -1);
      }
      return;
    }
    if (e.code === 'Backspace') {
      e.preventDefault();
      if (!e.repeat) releaseCountermeasures();
      return;
    }
    if (e.code === CFG.fireCode) {
      if (weaponIndex === 0) {
        initAudio();
        if (!e.repeat && ammo <= 0) dryClick();
        firing = true;
      } else if (!e.repeat) {
        launchMissile();
      }
      return;
    }


    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const step = e.shiftKey ? 10 : 2;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.code]) {
        CFG.hudOffset.x += moves[e.code][0];
        CFG.hudOffset.y += moves[e.code][1];
      } else if (e.code === 'Digit0') {
        CFG.hudOffset.x = 0; CFG.hudOffset.y = 0;
      } else if (e.code === 'KeyH') {
        CFG.showHudFrame = !CFG.showHudFrame;
      } else return;
      e.preventDefault();
      try { localStorage.setItem('geofs-eegs-offset', JSON.stringify(CFG.hudOffset)); } catch (err) {}
      toast = { text: 'HUD offset: x ' + CFG.hudOffset.x + '  y ' + CFG.hudOffset.y, until: performance.now() + 1500 };
      return;
    }

    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.toLowerCase() === CFG.toggleKey) {
      if (e.shiftKey) {
        if (weaponIndex === 0) {
          ammo = CFG.ammo;
          toast = { text: 'GUN reloaded: ' + ammo, until: performance.now() + 2000 };
        } else {
          missileAmmo = 2;
          toast = { text: 'AIM-9X reloaded: ' + missileAmmo, until: performance.now() + 2000 };
        }
      } else {
        enabled = !enabled;
        toast = { text: 'EEGS display: ' + (enabled ? 'ON' : 'OFF'), until: performance.now() + 2000 };
      }
    }
  }, true);
  addEventListener('keyup', function (e) { if (e.code === CFG.fireCode) firing = false; }, true);
  addEventListener('blur', function () { firing = false; });

  try {
    const saved = JSON.parse(localStorage.getItem('geofs-eegs-offset'));
    if (saved && isFinite(saved.x) && isFinite(saved.y)) CFG.hudOffset = { x: saved.x, y: saved.y };
  } catch (err) {}

  const boot = setInterval(function () {
    if (document.body && ready()) {
      clearInterval(boot);
      createCanvas();
      requestAnimationFrame(frame);
      toast = { text: 'EEGS loaded (' + CFG.toggleKey.toUpperCase() + ' to toggle, have fun I guess)', until: performance.now() + 3000 };
    }
  }, 500);
})();
