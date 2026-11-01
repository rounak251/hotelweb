// 3D hero: a sunset ocean with the resort on an island and lanterns rising off the water.
// Scrolling through the (pinned) hero flies the camera to the island as the sun sets; the camera follows the pointer.
import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { Sky } from "three/addons/objects/Sky.js";

const SUN_AZIMUTH = 166;          // degrees; a little right of centre, behind the island
const SUN_START = 2.4;            // sun elevation (degrees) at the top of the page
const SUN_END = 0.2;              // ...and once the hero has scrolled away

// Seeded random so the island and lanterns look the same on every visit.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable water normal map built from sine waves with whole-number frequencies,
// so the ocean needs no image download.
function waterNormalMap(size = 256) {
  const rand = rng(7);
  const waves = Array.from({ length: 28 }, () => {
    const kx = Math.round((rand() * 2 - 1) * 14), ky = Math.round((rand() * 2 - 1) * 14) || 1;
    const k = Math.hypot(kx, ky);
    return { kx, ky, amp: 1 / Math.pow(k, 1.25), phase: rand() * Math.PI * 2 };
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const w of waves) {
        const c = Math.cos(2 * Math.PI * (w.kx * x + w.ky * y) / size + w.phase) * w.amp * 2 * Math.PI;
        dx += c * w.kx; dy += c * w.ky;
      }
      const nx = -dx * 0.045, ny = -dy * 0.045, len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = (nx / len * 0.5 + 0.5) * 255;
      data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,220,170,.55)");
  grad.addColorStop(1, "rgba(255,180,90,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function palmFrondGeometry(length = 13, width = 2.8) {
  const geo = new THREE.PlaneGeometry(length, width, 8, 2);
  geo.translate(length / 2, 0, 0);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) / length;
    p.setZ(i, p.getZ(i) * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.05)));   // pointed tip
    p.setY(i, t * 2.2 - t * t * 7.5 + Math.abs(p.getZ(i)) * 0.35);             // arc, then droop
  }
  geo.computeVertexNormals();
  return geo;
}

function buildIsland() {
  const island = new THREE.Group();
  const rand = rng(21);
  const rock = new THREE.MeshStandardMaterial({ color: 0x2e241d, roughness: 1, flatShading: true });
  const scrub = new THREE.MeshStandardMaterial({ color: 0x1f3322, roughness: 1, flatShading: true });
  const trunk = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 1 });
  const frond = new THREE.MeshStandardMaterial({ color: 0x1d2e1c, roughness: 1, side: THREE.DoubleSide });
  const wall = new THREE.MeshStandardMaterial({ color: 0xe9dcc8, roughness: 0.75 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.6 });
  const windowGlow = new THREE.MeshBasicMaterial({ color: 0xffb562 });
  const poolGlow = new THREE.MeshBasicMaterial({ color: 0x46c3d6 });

  // Land: a squashed, gently lumpy icosphere. The bumps come from position so faces stay joined.
  const landGeo = new THREE.IcosahedronGeometry(60, 3);
  const p = landGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.1 * Math.sin(x * 0.11 + z * 0.07) * Math.cos(y * 0.19 + x * 0.05) + 0.05 * Math.sin(z * 0.23);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  landGeo.computeVertexNormals();
  const land = new THREE.Mesh(landGeo, rock);
  land.scale.set(1.7, 0.26, 0.9);
  land.position.y = -6;
  island.add(land);

  for (let i = 0; i < 9; i++) {
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(6 + rand() * 6, 0), scrub);
    bush.position.set((rand() - 0.5) * 150, 5 + rand() * 3, (rand() - 0.5) * 40);
    bush.scale.y = 0.55;
    island.add(bush);
  }

  // Villa: two stacked volumes with flat roofs, lit windows and a glowing pool.
  const villa = new THREE.Group();
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, z);
    villa.add(m);
    return m;
  };
  box(36, 7, 15, wall, 0, 8, 0);
  box(38.5, 0.9, 17, roof, 0, 15, 0.6);
  box(22, 6, 12, wall, 5, 15.9, -1);
  box(24.5, 0.9, 14, roof, 5, 21.9, -0.4);
  for (let i = 0; i < 5; i++) box(4.6, 3.6, 0.3, windowGlow, -14 + i * 7, 9.6, 7.6);
  for (let i = 0; i < 3; i++) box(4.6, 3.4, 0.3, windowGlow, -2 + i * 7, 17.2, 5.1);
  box(22, 0.5, 6, poolGlow, -3, 7.9, 14);
  villa.position.y = 4;             // sit on top of the land rather than in it
  island.add(villa);

  // Palms, leaning outwards from the villa.
  const frondGeo = palmFrondGeometry();
  [[-42, 27, -6], [-33, 23, 4], [36, 30, 8], [46, 24, -4], [-56, 20, 10]].forEach(([x, h, lean]) => {
    const palm = new THREE.Group();
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.25, h * 0.6, 0), new THREE.Vector3(lean, h, 0));
    palm.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.85, 6), trunk));
    const top = curve.getPoint(1);
    for (let i = 0; i < 9; i++) {
      const leaf = new THREE.Mesh(frondGeo, frond);
      leaf.position.copy(top);
      leaf.rotation.set(0, (i / 9) * Math.PI * 2 + rand() * 0.4, (rand() - 0.5) * 0.3);
      palm.add(leaf);
    }
    palm.position.set(x, 6, (rand() - 0.5) * 16);
    island.add(palm);
  });
  return island;
}

export function initHero(canvas, { reducedMotion = false } = {}) {
  const hero = canvas.closest(".hero");
  const small = matchMedia("(max-width: 760px)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  const lookTarget = new THREE.Vector3();

  const water = new Water(new THREE.PlaneGeometry(10000, 10000), {
    textureWidth: small ? 256 : 512,
    textureHeight: small ? 256 : 512,
    waterNormals: waterNormalMap(),
    sunDirection: new THREE.Vector3(),
    sunColor: 0xffffff,
    waterColor: 0x001e0f,
    distortionScale: 3.4,
  });
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  const sky = new Sky();
  sky.scale.setScalar(10000);
  Object.entries({ turbidity: 8, rayleigh: 3, mieCoefficient: 0.005, mieDirectionalG: 0.8 })
    .forEach(([k, v]) => { sky.material.uniforms[k].value = v; });
  scene.add(sky);

  const island = buildIsland();
  island.position.z = -480;
  scene.add(island);

  // Lanterns: unlit warm cylinders plus additive glow sprites. Both show up in the water's reflection.
  const count = small ? 18 : 40;
  const rand = rng(99);
  const lanterns = Array.from({ length: count }, () => ({
    x: (rand() - 0.5) * 760, y: -6 + rand() * 230, z: -640 + rand() * 600,
    speed: 2.2 + rand() * 3, phase: rand() * Math.PI * 2, sway: 1 + rand() * 3,
  }));
  const lanternMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.9, 0.65, 1.8, 10),
    new THREE.MeshBasicMaterial({ color: 0xffa64d, toneMapped: false }), count);
  scene.add(lanternMesh);
  const glowPositions = new Float32Array(count * 3);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  const glowMat = new THREE.PointsMaterial({
    map: glowTexture(), color: 0xffa24a, size: 13, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  scene.add(new THREE.Points(glowGeo, glowMat));
  const dummy = new THREE.Object3D();

  function updateLanterns(time, dt) {
    lanterns.forEach((l, i) => {
      l.y += l.speed * dt;
      if (l.y > 260) { l.y = -6; l.x = (rand() - 0.5) * 760; }
      const x = l.x + Math.sin(time * 0.4 + l.phase) * l.sway;
      dummy.position.set(x, l.y, l.z);
      dummy.rotation.y = time * 0.3 + l.phase;
      dummy.updateMatrix();
      lanternMesh.setMatrixAt(i, dummy.matrix);
      glowPositions.set([x, l.y, l.z], i * 3);
    });
    lanternMesh.instanceMatrix.needsUpdate = true;
    glowGeo.attributes.position.needsUpdate = true;
  }

  // Sun and the environment light it casts on the island.
  const sun = new THREE.Vector3();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  let envTarget = null, envElevation = null;
  function setSun(elevation) {
    sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(SUN_AZIMUTH));
    sky.material.uniforms.sunPosition.value.copy(sun);
    water.material.uniforms.sunDirection.value.copy(sun).normalize();
    if (envElevation === null || Math.abs(elevation - envElevation) > 0.35) {
      envElevation = elevation;
      envTarget?.dispose();
      envScene.add(sky);
      envTarget = pmrem.fromScene(envScene);
      scene.add(sky);
      scene.environment = envTarget.texture;
    }
  }

  // Input: scroll progress through the hero and a smoothed pointer position.
  let progress = 0, shownProgress = -1;
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  // Progress through the pinned hero: 0 at the top, 1 when the pin lets go. Unpinned, it's progress through the hero.
  const track = hero.closest(".hero-pin") || hero;
  const readScroll = () => {
    const r = track.getBoundingClientRect();
    const span = r.height - innerHeight > 50 ? r.height - innerHeight : r.height;
    progress = THREE.MathUtils.clamp(-r.top / span, 0, 1);
  };
  addEventListener("scroll", () => { readScroll(); if (reducedMotion) requestRender(); }, { passive: true });
  if (!reducedMotion) {
    addEventListener("pointermove", e => {
      pointer.x = e.clientX / innerWidth * 2 - 1;
      pointer.y = e.clientY / innerHeight * 2 - 1;
    }, { passive: true });
  }

  function resize() {
    const w = hero.clientWidth, h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Keep the island roughly halfway between the centre and the right edge at any aspect ratio.
    const halfWidth = 580 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    island.position.x = Math.max(halfWidth * 0.5, 70);
    requestRender();
  }

  function update(time, dt) {
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 2.5);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 2.5);
    if (Math.abs(progress - shownProgress) > 0.001) {
      setSun(THREE.MathUtils.lerp(SUN_START, SUN_END, progress));
      shownProgress = progress;
    }
    // Fly across the water towards the island, ending just off its shore.
    const f = THREE.MathUtils.smootherstep(progress, 0, 1);
    const ix = island.position.x;
    camera.position.set(ix * 0.55 * f + pointer.sx * 14, 10 + f * 16 - pointer.sy * 3, 100 - f * 350);
    lookTarget.set(ix * f + pointer.sx * 4, 52 - f * 40 - pointer.sy * 6, -400 - f * 80);
    camera.lookAt(lookTarget);
    water.material.uniforms.time.value = time * 0.55;
    updateLanterns(time, dt);
    glowMat.size = 13 + progress * 5;
  }

  // Render only while the hero is on screen and the tab is visible.
  const clock = new THREE.Clock();
  let running = false, onScreen = true, frameQueued = false, elapsed = 0;
  function frame() {
    if (!running) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    update(elapsed, dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  function setRunning() {
    const should = !reducedMotion && onScreen && !document.hidden;
    if (should && !running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
    if (!should) running = false;
  }
  function requestRender() {
    if (running || frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      update(elapsed, 0);
      renderer.render(scene, camera);
    });
  }
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; setRunning(); }).observe(hero);
  document.addEventListener("visibilitychange", setRunning);
  new ResizeObserver(resize).observe(hero);

  readScroll();
  updateLanterns(0, 0);
  resize();
  update(0, 0);
  renderer.render(scene, camera);
  hero.classList.add("is-3d");
  setRunning();
}
