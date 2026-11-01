// 3D resort explorer: a miniature of the island with clickable places, a time-of-day slider and fly-to camera moves.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const TAU = Math.PI * 2;
const SAND = 1.0, GRASS = 1.5, PLATEAU = 3.4;

// Seeded random so the island looks the same on every visit.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
// Shoreline radius at angle a (x = r cos a, z = r sin a). The western headland holds the Sunset Bar.
const shore = a => 36 + 4 * Math.sin(2 * a + 0.6) + 2.5 * Math.sin(3 * a + 1.9) + 1.2 * Math.sin(7 * a + 0.3)
  + 12 * Math.exp(-(angleDiff(a, Math.PI) ** 2) / 0.05);
const polar = (a, r, y = 0) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
const smooth = (e0, e1, x) => { const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const LODGE_AT = new THREE.Vector2(0, -15);
// Ground height at (x, z): sand at the edge, a grass terrace inside and a raised plateau under the lodge.
function groundAt(x, z) {
  const r = Math.hypot(x, z), s = shore(Math.atan2(z, x));
  let y = SAND + (GRASS - SAND) * smooth(s - 5.6, s - 7.2, r);
  const p = Math.hypot((x - LODGE_AT.x) / 17, (z - LODGE_AT.y) / 10);
  return y + (PLATEAU - GRASS) * smooth(1.08, 0.98, p);
}

function outline(radius, segments = 160) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * TAU, r = radius(a);
    // Shape y maps to -z once the extrusion is turned upright.
    shape[i ? "lineTo" : "moveTo"](Math.cos(a) * r, -Math.sin(a) * r);
  }
  return shape;
}

// Extrude a flat outline into a slab whose top sits at `top`.
function slab(shape, depth, top, bevel, materials) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel * 0.5, bevelSize: bevel, bevelSegments: 3, curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, materials);
  mesh.position.y = top - depth - bevel * 0.5;
  mesh.receiveShadow = true;
  return mesh;
}

// Shoreline radius packed into a texture (16 bits per sample) so the water shader can draw foam and shallows.
function shoreTexture(size = 1024) {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const v = Math.round(shore((i + 0.5) / size * TAU - Math.PI) * 256);
    data[i * 4] = v >> 8; data[i * 4 + 1] = v & 255; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1);
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Lighting keyframes through the day. Colours are sRGB hex; `night` drives lamps, windows and stars.
const KEYS = [
  { h: 0, top: 0x060b1c, horizon: 0x16213d, sun: 0x8fa6ff, sunI: 0.75, hemiSky: 0x5a6aa0, hemiGround: 0x1c1f2c, hemiI: 0.7, shallow: 0x0f3a4a, deep: 0x051424, exposure: 1.0, night: 1 },
  { h: 5, top: 0x0d1430, horizon: 0x3a3556, sun: 0x8fa6ff, sunI: 0.6, hemiSky: 0x5a6494, hemiGround: 0x1c1a24, hemiI: 0.65, shallow: 0x174a58, deep: 0x07192c, exposure: 1.0, night: 0.9 },
  { h: 6.5, top: 0x47629c, horizon: 0xf3a17a, sun: 0xffb37a, sunI: 1.6, hemiSky: 0xa9b8e0, hemiGround: 0x6b5446, hemiI: 0.7, shallow: 0x3aa3b0, deep: 0x1a4f7a, exposure: 1.0, night: 0.2 },
  { h: 9, top: 0x4f8fe0, horizon: 0xbfe0f5, sun: 0xfff1d6, sunI: 2.6, hemiSky: 0xcfe7ff, hemiGround: 0x8a7a5e, hemiI: 1.0, shallow: 0x3fd1d0, deep: 0x1f6fb0, exposure: 1.0, night: 0 },
  { h: 13, top: 0x3d84e6, horizon: 0xcdeafa, sun: 0xffffff, sunI: 3.0, hemiSky: 0xd8ecff, hemiGround: 0x8f805f, hemiI: 1.1, shallow: 0x48dcd4, deep: 0x1a6cb8, exposure: 1.0, night: 0 },
  { h: 16.5, top: 0x4a7fd0, horizon: 0xf2dcb4, sun: 0xffe0b0, sunI: 2.6, hemiSky: 0xd9e2f2, hemiGround: 0x8a7458, hemiI: 0.95, shallow: 0x40c8c8, deep: 0x1d62a6, exposure: 1.0, night: 0 },
  { h: 18, top: 0x3e4f8f, horizon: 0xff9e5e, sun: 0xff9a52, sunI: 2.0, hemiSky: 0xb7a8c8, hemiGround: 0x6e4f3c, hemiI: 0.75, shallow: 0x3b9fb0, deep: 0x1f456e, exposure: 1.05, night: 0.15 },
  { h: 19.2, top: 0x1f2552, horizon: 0xc0607a, sun: 0xff7a4a, sunI: 0.6, hemiSky: 0x6a6496, hemiGround: 0x2a2028, hemiI: 0.5, shallow: 0x22667a, deep: 0x0f2a48, exposure: 1.05, night: 0.65 },
  { h: 21, top: 0x080d22, horizon: 0x1c2748, sun: 0x8fa6ff, sunI: 0.75, hemiSky: 0x5a6aa0, hemiGround: 0x1c1f2c, hemiI: 0.7, shallow: 0x0f3a4a, deep: 0x051424, exposure: 1.0, night: 1 },
  { h: 24, top: 0x060b1c, horizon: 0x16213d, sun: 0x8fa6ff, sunI: 0.75, hemiSky: 0x5a6aa0, hemiGround: 0x1c1f2c, hemiI: 0.7, shallow: 0x0f3a4a, deep: 0x051424, exposure: 1.0, night: 1 },
];
const COLOR_KEYS = ["top", "horizon", "sun", "hemiSky", "hemiGround", "shallow", "deep"];
KEYS.forEach(k => COLOR_KEYS.forEach(c => { k[c] = new THREE.Color(k[c]); }));

export function createResortExplorer(canvas, { stage, pins, panel = null, reducedMotion = false }) {
  const small = Math.min(innerWidth, innerHeight) < 700;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const rand = rng(7);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.75 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcdeafa, 230, 520);
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 1400);

  // ---------- materials ----------
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });
  const M = {
    sand: mat(0xf0dcb0), sandSide: mat(0xd9bf8c), grass: mat(0x86b85a, { flatShading: true }), grassSide: mat(0x6f9a48),
    rock: mat(0xa89a86, { flatShading: true }), stone: mat(0xefe7da), wood: mat(0x9a6b43), darkWood: mat(0x6d4a2f),
    thatch: mat(0xb08451, { flatShading: true }), white: mat(0xfbf8f2), cloth: mat(0xfffaf0, { side: THREE.DoubleSide }),
    leaf: mat(0x5aa846, { flatShading: true, side: THREE.DoubleSide }), bush: mat(0x5f9f45, { flatShading: true }),
    trunk: mat(0x9b7b58, { flatShading: true }), blossom: mat(0xf7a8c4, { flatShading: true }), path: mat(0xe9d9b8),
    hull: mat(0xffffff, { roughness: 0.4 }), navy: mat(0x1f3b5a, { roughness: 0.5 }), red: mat(0xc2563f),
    window: new THREE.MeshStandardMaterial({ color: 0x24323b, roughness: 0.25, metalness: 0.2, emissive: 0xffb35c, emissiveIntensity: 0 }),
    poolWater: new THREE.MeshStandardMaterial({ color: 0x4fd0e0, roughness: 0.12, emissive: 0x18a6c8, emissiveIntensity: 0.15 }),
    cloud: mat(0xffffff, { flatShading: true, transparent: true, opacity: 0.94, emissive: 0xffffff, emissiveIntensity: 0.45 }),
    lampOff: new THREE.MeshBasicMaterial({ color: 0xffc070 }),
  };
  const STRIPES = [0xd9573e, 0x2c7fb8, 0xf0b53c, 0x3aa37a].map(c => mat(c, { side: THREE.DoubleSide }));

  const box = (w, h, d, m, x = 0, y = 0, z = 0, round = 0) => {
    const mesh = new THREE.Mesh(round ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  const cyl = (rt, rb, h, m, x = 0, y = 0, z = 0, seg = 12) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  // Four-sided hip roof.
  const hipRoof = (w, d, h, m) => {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1), m);
    mesh.rotation.y = Math.PI / 4;
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    return mesh;
  };
  const lampSpots = [];   // world positions of path lamps and lanterns, lit at night

  // ---------- island ----------
  const island = new THREE.Group();
  island.add(slab(outline(shore), 6, SAND, 1.6, [M.sand, M.sandSide]));
  island.add(slab(outline(a => shore(a) - 7), 1, GRASS, 1.0, [M.grass, M.grassSide]));
  const plateauShape = new THREE.Shape();
  for (let i = 0; i <= 64; i++) {
    const a = i / 64 * TAU, w = 1 + 0.06 * Math.sin(3 * a + 1) + 0.04 * Math.sin(5 * a);
    plateauShape[i ? "lineTo" : "moveTo"](LODGE_AT.x + Math.cos(a) * 16 * w, -(LODGE_AT.y + Math.sin(a) * 9.2 * w));
  }
  island.add(slab(plateauShape, PLATEAU - GRASS + 0.5, PLATEAU, 1.2, [M.grass, M.rock]));
  // Rocks around the headland and along the back of the island.
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 26; i++) {
    const a = i < 12 ? Math.PI + (rand() - 0.5) * 0.7 : rand() * TAU;
    const r = shore(a) + (rand() - 0.3) * 2.5;
    const rock = new THREE.Mesh(rockGeo, M.rock);
    const s = 0.8 + rand() * 1.5;
    rock.position.copy(polar(a, r, 0.2 + rand()));
    rock.scale.set(s, s * (0.5 + rand() * 0.5), s);
    rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    rock.castShadow = rock.receiveShadow = true;
    island.add(rock);
  }
  scene.add(island);
  const occluders = [...island.children];

  // ---------- places ----------
  const places = {};
  const poolLightAt = new THREE.Vector3(1, GRASS + 2, 6);
  const beamPivot = new THREE.Object3D();   // the lighthouse lamp, placed with the Sunset Bar
  scene.add(beamPivot);
  function place(id, group, anchor, view) {
    group.traverse(o => { if (o.isMesh) o.userData.place = id; });
    scene.add(group);
    places[id] = { id, group, anchor, view };
  }

  // The Lodge: lobby and restaurant under a big thatched roof on the plateau.
  {
    const g = new THREE.Group();
    g.position.set(LODGE_AT.x, PLATEAU, LODGE_AT.y);
    g.add(box(18, 0.6, 10, M.stone, 0, 0.3, 0));
    g.add(box(15, 4.2, 7, M.white, 0, 2.7, -0.6));
    g.add(box(12.6, 2.8, 0.2, M.window, 0, 2.5, 2.95));
    for (const x of [-7, -3.5, 0, 3.5, 7]) g.add(cyl(0.28, 0.28, 4.4, M.darkWood, x, 2.8, 4.3, 8));
    const roof = hipRoof(21, 13, 6.5, M.thatch);
    roof.position.set(0, 4.8 + 3.25, 0);
    g.add(roof);
    for (const side of [-1, 1]) {
      const wing = box(6, 3.4, 6, M.white, side * 11.5, 2.3, -1.5);
      g.add(wing, box(4.6, 1.4, 0.2, M.window, side * 11.5, 2.6, 1.55));
      const wr = hipRoof(8, 8, 3.6, M.thatch);
      wr.position.set(side * 11.5, 4 + 1.8, -1.5);
      g.add(wr);
    }
    // Restaurant terrace with tables.
    g.add(box(16, 0.3, 4, M.wood, 0, 0.75, 6.6));
    for (const x of [-6, -2, 2, 6]) g.add(cyl(0.7, 0.7, 0.15, M.white, x, 1.75, 6.6, 14), cyl(0.12, 0.12, 0.9, M.darkWood, x, 1.3, 6.6, 6));
    lampSpots.push(...[-8, 8].map(x => new THREE.Vector3(LODGE_AT.x + x, PLATEAU + 2.5, LODGE_AT.y + 8.4)));
    place("lodge", g, new THREE.Vector3(LODGE_AT.x, PLATEAU + 13.5, LODGE_AT.y),
      { target: new THREE.Vector3(0, 6, -14), dist: 66, polar: 1.0, az: 0.35 });
  }

  // Infinity pool on the terrace below the lodge, with a deck, loungers and parasols.
  {
    const g = new THREE.Group();
    g.position.set(1, GRASS, 6);
    g.add(box(24, 0.5, 11, M.wood, 0, 0.05, 0, 0.2));
    g.add(box(19, 0.7, 6.4, M.stone, 0, 0.35, -0.4, 0.3));
    const water = box(18, 0.2, 5.4, M.poolWater, 0, 0.66, -0.4);
    water.castShadow = false;
    g.add(water);
    for (let i = 0; i < 6; i++) {
      const x = -8.5 + i * 3.4;
      const lounger = box(1.1, 0.35, 2.6, M.white, x, 0.5, 4.2, 0.12);
      lounger.rotation.x = -0.12;
      g.add(lounger);
      if (i % 2 === 0) {
        g.add(cyl(0.08, 0.08, 3, M.darkWood, x + 1.6, 1.8, 4.3, 6));
        const top = new THREE.Mesh(new THREE.ConeGeometry(2, 0.8, 8, 1, true), STRIPES[(i / 2) % STRIPES.length]);
        top.position.set(x + 1.6, 3.4, 4.3);
        top.castShadow = true;
        g.add(top);
      }
    }
    lampSpots.push(new THREE.Vector3(-11, GRASS + 1.2, 11), new THREE.Vector3(13, GRASS + 1.2, 11));
    place("pool", g, new THREE.Vector3(1, GRASS + 6, 5),
      { target: new THREE.Vector3(1, 2, 6), dist: 58, polar: 0.92, az: 0.15 });
  }

  // Lotus Spa: a round pavilion by a lily pond among blossom trees.
  const SPA_AT = new THREE.Vector3(-21, GRASS, -4);
  {
    const g = new THREE.Group();
    g.position.copy(SPA_AT);
    g.add(cyl(5.6, 5.9, 0.5, M.stone, 0, 0.25, 0, 24));
    g.add(cyl(4.2, 4.2, 3.2, M.white, 0, 2.1, 0, 20));
    const band = cyl(4.25, 4.25, 1.3, M.window, 0, 2.3, 0, 20);
    band.castShadow = false;
    g.add(band);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 4.2, 20), M.thatch);
    roof.position.y = 5.8;
    roof.castShadow = true;
    g.add(roof);
    const pond = cyl(3.2, 3.2, 0.12, M.poolWater, 7.4, 0.08, 4, 20);
    pond.castShadow = false;
    g.add(pond);
    for (let i = 0; i < 5; i++) {
      const a = 2.2 + i * 0.9, t = new THREE.Group();
      t.position.set(Math.cos(a) * 8, 0, Math.sin(a) * 8);
      t.add(cyl(0.18, 0.3, 2.4, M.trunk, 0, 1.2, 0, 6));
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 0), M.blossom);
      crown.position.y = 3.2;
      crown.castShadow = true;
      t.add(crown);
      g.add(t);
    }
    lampSpots.push(new THREE.Vector3(SPA_AT.x + 5.5, GRASS + 1, SPA_AT.z - 3), new THREE.Vector3(SPA_AT.x - 5, GRASS + 1, SPA_AT.z + 4));
    place("spa", g, new THREE.Vector3(SPA_AT.x, GRASS + 10.5, SPA_AT.z),
      { target: new THREE.Vector3(SPA_AT.x + 2, 3, SPA_AT.z + 1), dist: 54, polar: 0.98, az: -0.75 });
  }

  // Beach Club: cabanas, loungers, striped parasols and kayaks on the front-left sand.
  const BEACH_A = 2.2, beachAt = polar(BEACH_A, shore(BEACH_A) - 3.4, SAND);
  {
    const g = new THREE.Group();
    g.position.copy(beachAt);
    g.rotation.y = Math.PI / 2 - BEACH_A;   // local +z faces the sea
    for (let i = 0; i < 3; i++) {
      const x = -6 + i * 6, c = new THREE.Group();
      c.position.set(x, 0, -1.2);
      for (const [px, pz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) c.add(cyl(0.08, 0.08, 2.6, M.wood, px, 1.3, pz, 6));
      c.add(box(2.8, 0.12, 2.8, M.cloth, 0, 2.65, 0));
      c.add(box(2.2, 0.4, 2.2, M.white, 0, 0.25, 0, 0.15));
      g.add(c);
    }
    for (let i = 0; i < 4; i++) {
      const x = -7 + i * 4.6;
      g.add(box(0.9, 0.3, 2.2, M.white, x, 0.2, 3.2, 0.1));
      g.add(cyl(0.07, 0.07, 2.6, M.darkWood, x + 1.4, 1.3, 3.2, 6));
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.7, 8, 1, true), STRIPES[i % STRIPES.length]);
      top.position.set(x + 1.4, 2.7, 3.2);
      top.castShadow = true;
      g.add(top);
    }
    [0xe85d3a, 0xf2c037, 0x2f8fd8].forEach((c, i) => {
      const kayak = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 3, 4, 8), mat(c, { roughness: 0.5 }));
      kayak.rotation.set(Math.PI / 2, 0, 0.25 + i * 0.1);
      kayak.scale.set(1, 1, 0.5);
      kayak.position.set(8 + i * 1.2, 0.2, 2.4);
      kayak.castShadow = true;
      g.add(kayak);
    });
    place("beach", g, beachAt.clone().setY(SAND + 7),
      { target: beachAt.clone().setY(2), dist: 56, polar: 1.0, az: Math.atan2(beachAt.x, beachAt.z) });
  }

  // Overwater villas: a boardwalk out over the lagoon with suites on stilts.
  const VILLA_A = 0.95, walkStart = polar(VILLA_A, shore(VILLA_A) - 3, 0);
  const walkDir = new THREE.Vector3(Math.cos(VILLA_A), 0, Math.sin(VILLA_A));
  const walkSide = new THREE.Vector3(-walkDir.z, 0, walkDir.x);
  const villaMid = walkStart.clone().addScaledVector(walkDir, 18);
  {
    const g = new THREE.Group();
    const len = 34;
    const deckMat = M.wood;
    const walk = box(2.2, 0.3, len, deckMat);
    walk.position.copy(walkStart).addScaledVector(walkDir, len / 2).setY(1.7);
    walk.rotation.y = Math.atan2(walkDir.x, walkDir.z);
    g.add(walk);
    for (let s = 2; s < len; s += 4) {
      for (const side of [-1, 1]) {
        const p = walkStart.clone().addScaledVector(walkDir, s).addScaledVector(walkSide, side * 0.9);
        g.add(cyl(0.12, 0.12, 3, M.darkWood, p.x, 0.2, p.z, 6));
      }
    }
    for (let i = 0; i < 6; i++) {
      const along = 9 + Math.floor(i / 2) * 9, side = i % 2 ? 1 : -1;
      const c = walkStart.clone().addScaledVector(walkDir, along).addScaledVector(walkSide, side * 5.2);
      const v = new THREE.Group();
      v.position.set(c.x, 0, c.z);
      v.rotation.y = Math.atan2(walkSide.x * side, walkSide.z * side);
      for (const [px, pz] of [[-2, -1.8], [2, -1.8], [-2, 1.8], [2, 1.8], [0, 3.6]]) v.add(cyl(0.15, 0.15, 3.4, M.darkWood, px, 0.1, pz, 6));
      v.add(box(5.4, 0.3, 4.8, deckMat, 0, 1.75, 0.6));
      v.add(box(4.4, 2.4, 3.4, M.white, 0, 3.1, -0.3));
      v.add(box(3.2, 1.6, 0.15, M.window, 0, 3.1, 1.45));
      const roof = hipRoof(6.2, 5.2, 2.8, M.thatch);
      roof.position.set(0, 4.3 + 1.4, -0.3);
      v.add(roof);
      v.add(box(2.6, 0.12, 1.6, M.poolWater, 0, 1.94, 2.3));
      // Short bridge back to the boardwalk.
      v.add(box(1.2, 0.2, 2.6, deckMat, 0, 1.75, -3.2));
      g.add(v);
      if (i % 2 === 0) lampSpots.push(walkStart.clone().addScaledVector(walkDir, along).setY(2.6));
    }
    place("villas", g, villaMid.clone().setY(10),
      { target: villaMid.clone().setY(1.5), dist: 62, polar: 0.98, az: Math.atan2(walkDir.x, walkDir.z) + 0.5 });
  }

  // Arrival jetty with a moored speedboat, on the east side.
  const JETTY_A = -0.55, jettyStart = polar(JETTY_A, shore(JETTY_A) - 2.5, 0);
  const jettyDir = new THREE.Vector3(Math.cos(JETTY_A), 0, Math.sin(JETTY_A));
  const jettyEnd = jettyStart.clone().addScaledVector(jettyDir, 18);
  function makeBoat() {
    const b = new THREE.Group();
    const hull = box(1.9, 0.9, 5.4, M.hull, 0, 0.35, 0, 0.35);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2, 4, 1), M.hull);
    bow.rotation.set(Math.PI / 2, Math.PI / 4, 0);
    bow.scale.set(1.4, 1, 0.65);
    bow.position.set(0, 0.35, 3.6);
    b.add(hull, bow, box(1.95, 0.25, 5.4, M.navy, 0, 0.05, 0), box(1.3, 0.8, 1.6, M.window, 0, 1.15, 0.2, 0.2));
    b.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return b;
  }
  {
    const g = new THREE.Group();
    const walk = box(3, 0.35, 18, M.wood);
    walk.position.copy(jettyStart).addScaledVector(jettyDir, 9).setY(1.6);
    walk.rotation.y = Math.atan2(jettyDir.x, jettyDir.z);
    g.add(walk);
    const side = new THREE.Vector3(-jettyDir.z, 0, jettyDir.x);
    for (let s = 1; s <= 18; s += 3.4) {
      for (const k of [-1.3, 1.3]) {
        const p = jettyStart.clone().addScaledVector(jettyDir, s).addScaledVector(side, k);
        g.add(cyl(0.16, 0.16, 3, M.darkWood, p.x, 0.3, p.z, 6));
      }
    }
    const moored = makeBoat();
    moored.position.copy(jettyEnd).addScaledVector(side, 2.8).addScaledVector(jettyDir, -3);
    moored.rotation.y = Math.atan2(jettyDir.x, jettyDir.z);
    g.add(moored);
    // Welcome arch at the start of the jetty.
    const arch = jettyStart.clone().addScaledVector(jettyDir, 1.5);
    for (const k of [-1.6, 1.6]) {
      const p = arch.clone().addScaledVector(side, k);
      g.add(cyl(0.18, 0.18, 4, M.darkWood, p.x, 3.3, p.z, 6));
    }
    const beam = box(4.2, 0.4, 0.4, M.darkWood, arch.x, 5.3, arch.z);
    beam.rotation.y = Math.atan2(jettyDir.x, jettyDir.z);
    g.add(beam);
    lampSpots.push(jettyEnd.clone().setY(2.8), arch.clone().setY(5.9));
    place("jetty", g, jettyEnd.clone().setY(8),
      { target: jettyStart.clone().addScaledVector(jettyDir, 9).setY(1.5), dist: 58, polar: 0.98, az: Math.atan2(jettyDir.x, jettyDir.z) - 0.6 });
  }

  // Sunset Bar on the western headland, with a lighthouse.
  const barAt = polar(Math.PI, shore(Math.PI) - 8.5), lightAt = polar(Math.PI, shore(Math.PI) - 2.8);
  barAt.y = groundAt(barAt.x, barAt.z);
  lightAt.y = groundAt(lightAt.x, lightAt.z);
  {
    const g = new THREE.Group();
    g.position.copy(barAt);
    g.add(box(10, 0.4, 9, M.wood, 0, 0.2, 0, 0.15));
    g.add(box(4.6, 1.3, 1.6, M.darkWood, 0, 1.05, -1.6, 0.15));
    for (const [x, z] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]]) g.add(cyl(0.16, 0.16, 3.6, M.darkWood, x, 2.1, z, 6));
    const roof = hipRoof(9, 9, 2.4, M.thatch);
    roof.position.set(0, 3.9 + 1.2, 0);
    g.add(roof);
    for (const [x, z] of [[-2.5, 2], [0.5, 2.6], [3, 1.4]]) g.add(cyl(0.18, 0.18, 1.1, M.darkWood, x, 0.85, z, 8));
    const lh = new THREE.Group();
    lh.position.copy(lightAt).sub(barAt);
    lh.add(cyl(1.3, 1.9, 11, M.white, 0, 5.5, 0, 16));
    for (const y of [3, 7]) lh.add(cyl(1.62 - y * 0.03, 1.72 - y * 0.03, 1.2, M.red, 0, y, 0, 16));
    lh.add(cyl(1.5, 1.5, 0.3, M.darkWood, 0, 11.1, 0, 16));
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.4, 12), M.red);
    cap.position.y = 13.4;
    lh.add(cyl(0.9, 0.9, 1.4, M.window, 0, 12, 0, 12), cap);
    g.add(lh);
    lampSpots.push(lightAt.clone().setY(lightAt.y + 12), barAt.clone().setY(barAt.y + 3.4));
    place("bar", g, lightAt.clone().setY(lightAt.y + 17),
      { target: barAt.clone().setY(3), dist: 58, polar: 1.0, az: -Math.PI / 2 - 0.45 });
    beamPivot.position.copy(lightAt).setY(lightAt.y + 12);
  }

  // Keep palms and bushes off buildings, paths and the pool deck.
  const keepOut = [
    [LODGE_AT.x, LODGE_AT.y, 17], [1, 6, 13], [SPA_AT.x, SPA_AT.z, 11], [beachAt.x, beachAt.z, 10],
    [barAt.x, barAt.z, 8], [lightAt.x, lightAt.z, 3.5], [walkStart.x, walkStart.z, 4], [jettyStart.x, jettyStart.z, 5],
  ];
  const freeAt = (x, z, pad = 0) => keepOut.every(([kx, kz, r]) => Math.hypot(x - kx, z - kz) > r + pad);

  // ---------- paths with lamps ----------
  function pathRibbon(points, width = 1.6) {
    const curve = new THREE.CatmullRomCurve3(points);
    const n = Math.ceil(curve.getLength() / 1.2);
    const pos = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n), t = curve.getTangentAt(i / n);
      const side = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(width / 2);
      for (const s of [-1, 1]) {
        const x = p.x + side.x * s, z = p.z + side.z * s;
        pos.push(x, groundAt(x, z) + 0.06, z);
      }
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
      if (i % 6 === 3) lampSpots.push(new THREE.Vector3(p.x + side.x * 1.6, groundAt(p.x, p.z) + 1.1, p.z + side.z * 1.6));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, M.path);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return curve;
  }
  const xz = (x, z) => new THREE.Vector3(x, 0, z);
  pathRibbon([xz(0, -4.5), xz(-2, 0), xz(-12, 1), xz(-16, 2.5)]);
  pathRibbon([xz(-12, 1), xz(-16, 12), xz(beachAt.x * 0.8, beachAt.z * 0.8)]);
  pathRibbon([xz(-27, -2), xz(-31, -1.5), barAt.clone().setY(0).add(xz(5, 0))]);
  pathRibbon([xz(13, 9), xz(walkStart.x * 0.75, walkStart.z * 0.75), walkStart.clone()]);
  pathRibbon([xz(12, -4), xz(22, -9), jettyStart.clone()]);

  // Lamp posts: unlit bulbs by day, glowing sprites at night.
  const postGeo = new THREE.CylinderGeometry(0.06, 0.08, 1, 5);
  const posts = new THREE.InstancedMesh(postGeo, M.darkWood, lampSpots.length);
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), M.lampOff, lampSpots.length);
  const dummy = new THREE.Object3D();
  lampSpots.forEach((p, i) => {
    dummy.position.set(p.x, p.y - 0.55, p.z); dummy.scale.set(1, 1.1, 1); dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, p.y, p.z); dummy.scale.setScalar(1); dummy.updateMatrix();
    bulbs.setMatrixAt(i, dummy.matrix);
  });
  scene.add(posts, bulbs);
  const glowGeo = new THREE.BufferGeometry().setFromPoints(lampSpots);
  const glowMat = new THREE.PointsMaterial({ map: glowTexture(), color: 0xffb562, size: 7, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  scene.add(new THREE.Points(glowGeo, glowMat));

  // ---------- palms and bushes ----------
  // Palms are built at unit height and scaled uniformly: a slim trunk that bends out to x = 0.22 at the top.
  const trunkGeo = new THREE.CylinderGeometry(0.03, 0.05, 1, 6, 6, true);
  trunkGeo.translate(0, 0.5, 0);
  { const p = trunkGeo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) + 0.22 * y * y); } }
  trunkGeo.computeVertexNormals();
  // Crown: drooping fronds around the top of the trunk.
  const crownGeo = (() => {
    const pos = [], idx = [];
    for (let f = 0; f < 8; f++) {
      const a = f / 8 * TAU + 0.3, base = pos.length / 3;
      for (let s = 0; s <= 5; s++) {
        const t = s / 5, len = t * (0.38 + (f % 2) * 0.06), w = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.07;
        const cx = Math.cos(a) * len, cz = Math.sin(a) * len, y = 0.02 + 0.13 * t - 0.3 * t * t;
        pos.push(cx - Math.sin(a) * w, y, cz + Math.cos(a) * w, cx + Math.sin(a) * w, y - 0.02, cz - Math.cos(a) * w);
        if (s) idx.push(base + 2 * s - 2, base + 2 * s - 1, base + 2 * s, base + 2 * s - 1, base + 2 * s + 1, base + 2 * s);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.translate(0.22, 1, 0);
    return g;
  })();
  const palmSpots = [];
  for (let tries = 0; palmSpots.length < 46 && tries < 3000; tries++) {
    const a = rand() * TAU, s = shore(a);
    const r = rand() < 0.65 ? s - 1.5 - rand() * 6 : rand() * (s - 9);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!freeAt(x, z, 1) || palmSpots.some(p => Math.hypot(p.x - x, p.z - z) < 3.4)) continue;
    palmSpots.push(new THREE.Vector3(x, groundAt(x, z), z));
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, palmSpots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, M.leaf, palmSpots.length);
  trunks.castShadow = crowns.castShadow = true;
  palmSpots.forEach((p, i) => {
    const h = 6.5 + rand() * 4;
    dummy.position.copy(p);
    // Palms lean out towards the sea.
    const out = Math.atan2(p.z, p.x);
    dummy.rotation.set(0, -out + (rand() - 0.5) * 1.2, 0);
    dummy.scale.setScalar(h);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    crowns.setMatrixAt(i, dummy.matrix);
  });
  scene.add(trunks, crowns);
  {
    const spots = [];
    for (let tries = 0; spots.length < 40 && tries < 3000; tries++) {
      const a = rand() * TAU, r = rand() * (shore(a) - 6);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (freeAt(x, z, 0.5)) spots.push([x, z]);
    }
    const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), M.bush, spots.length);
    bushes.castShadow = bushes.receiveShadow = true;
    spots.forEach(([x, z], i) => {
      const s = 0.8 + rand() * 1.3;
      dummy.position.set(x, groundAt(x, z) + s * 0.4, z);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s, s * 0.75, s);
      dummy.updateMatrix();
      bushes.setMatrixAt(i, dummy.matrix);
    });
    scene.add(bushes);
  }

  // ---------- water, sky, stars, clouds ----------
  const waterUniforms = {
    uTime: { value: 0 }, uShore: { value: shoreTexture() },
    uShallow: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunUp: { value: 1 }, uNight: { value: 0 },
  };
  const water = new THREE.Mesh(new THREE.CircleGeometry(700, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uSunUp, uNight;
      uniform sampler2D uShore;
      uniform vec3 uShallow, uDeep, uHorizon, uSunColor, uSunDir;
      varying vec3 vWorld;
      float shoreR(float a) {
        vec4 t = texture2D(uShore, vec2(a / 6.2831853 + 0.5, 0.5));
        return (t.r * 65280.0 + t.g * 255.0) / 256.0;
      }
      void main() {
        vec2 p = vWorld.xz;
        float r = length(p), a = atan(p.y, p.x);
        float d = r - shoreR(a) - 1.4;   // distance out from the waterline
        float t = uTime;
        vec2 g = vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.32 + t * 1.1) * 0.35
               + vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 0.55 + t * 1.5) * 0.22
               + vec2(0.29, -0.96) * cos(dot(p, vec2(0.29, -0.96)) * 0.95 + t * 2.1) * 0.12;
        float calm = 1.0 - smoothstep(45.0, 170.0, r);
        vec3 n = normalize(vec3(-g.x * 0.3 * calm, 1.0, -g.y * 0.3 * calm));
        vec3 V = normalize(cameraPosition - vWorld);
        float deep = smoothstep(0.0, 28.0, d);
        vec3 col = mix(uShallow, uDeep, deep);
        float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        col = mix(col, uHorizon, fres * 0.55);
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(n, H), 0.0), 260.0) * 2.2 * uSunUp;
        float c = sin(p.x * 0.8 + t * 1.2 + sin(p.y * 0.4)) * sin(p.y * 0.8 - t * 1.0 + sin(p.x * 0.35));
        col += (1.0 - deep) * smoothstep(0.7, 1.0, c) * 0.07 * (1.0 - uNight * 0.8);
        float band = 1.1 + 0.55 * sin(t * 1.3 + a * 17.0) + 0.35 * sin(t * 0.8 - a * 6.0);
        float foam = (1.0 - smoothstep(band - 0.5, band + 0.6, d)) * step(-3.0, d);
        float swell = fract(t * 0.12);
        foam += (1.0 - smoothstep(0.0, 0.45, abs(d - 2.5 - swell * 7.0))) * (1.0 - swell) * 0.55;
        col = mix(col, vec3(1.0) * (0.95 - uNight * 0.55), clamp(foam, 0.0, 1.0) * 0.85);
        col = mix(col, uHorizon, smoothstep(170.0, 520.0, r));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  scene.add(water);

  const skyUniforms = { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() }, uSunUp: { value: 1 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: skyUniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uSunColor, uSunDir; uniform float uSunUp;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.35) * uSunUp;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -1;
  scene.add(sky);

  const starPos = [];
  for (let i = 0; i < 900; i++) {
    const u = rand(), a = rand() * TAU, y = 0.08 + u * 0.92, rr = Math.sqrt(1 - y * y);
    starPos.push(Math.cos(a) * rr * 850, y * 850, Math.sin(a) * rr * 850);
  }
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3)), starMat);
  scene.add(stars);

  const clouds = [];
  for (let i = 0; i < 6; i++) {
    const c = new THREE.Group();
    const puffs = 4 + Math.floor(rand() * 3);
    for (let k = 0; k < puffs; k++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(2 + rand() * 2.2, 1), M.cloud);
      puff.position.set((k - puffs / 2) * 2.6 + rand(), rand() * 1.5, (rand() - 0.5) * 3);
      puff.scale.y = 0.7;
      puff.castShadow = true;
      c.add(puff);
    }
    c.position.set(-140 + i * 50 + rand() * 20, 44 + rand() * 12, -90 + rand() * 150);
    c.userData.speed = 1.2 + rand() * 1.5;
    clouds.push(c);
    scene.add(c);
  }

  // A shuttle boat loops around the island past the jetty, leaving a fading wake.
  const boat = makeBoat();
  scene.add(boat);
  const loop = new THREE.CatmullRomCurve3(Array.from({ length: 10 }, (_, i) => {
    const a = JETTY_A + 0.4 + i / 10 * TAU;
    return polar(a, shore(a) + 22 + 8 * Math.sin(i * 1.7), 0.15);
  }), true);
  const WAKE = 48;
  const wakeHist = Array.from({ length: WAKE }, () => ({ p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0) }));
  const wakePos = new Float32Array(WAKE * 2 * 3), wakeCol = new Float32Array(WAKE * 2 * 4);
  const wakeIdx = [];
  for (let i = 1; i < WAKE; i++) wakeIdx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  const wakeGeo = new THREE.BufferGeometry();
  wakeGeo.setAttribute("position", new THREE.BufferAttribute(wakePos, 3));
  wakeGeo.setAttribute("color", new THREE.BufferAttribute(wakeCol, 4));
  wakeGeo.setIndex(wakeIdx);
  const wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  wake.frustumCulled = false;
  scene.add(wake);
  let boatU = 0, wakeTimer = 0;
  function updateBoat(dt) {
    boatU = (boatU + dt * 0.012) % 1;
    const p = loop.getPointAt(boatU), t = loop.getTangentAt(boatU);
    boat.position.copy(p);
    boat.position.y = 0.1 + Math.sin(performance.now() * 0.004) * 0.08;
    boat.rotation.y = Math.atan2(t.x, t.z);
    wakeTimer += dt;
    if (wakeTimer > 0.09) {
      wakeTimer = 0;
      const last = wakeHist.pop();
      last.p.copy(p).addScaledVector(t, -2.6);
      last.t.copy(t);
      wakeHist.unshift(last);
    }
    wakeHist.forEach((h, i) => {
      const w = 0.4 + i * 0.06, sx = -h.t.z * w, sz = h.t.x * w, a = (1 - i / (WAKE - 1)) ** 1.6 * 0.5;
      wakePos.set([h.p.x + sx, 0.08, h.p.z + sz, h.p.x - sx, 0.08, h.p.z - sz], i * 6);
      wakeCol.set([1, 1, 1, a, 1, 1, 1, a], i * 8);
    });
    wakeGeo.attributes.position.needsUpdate = wakeGeo.attributes.color.needsUpdate = true;
  }
  // Prime the wake so it isn't drawn from the origin.
  for (let i = 0; i < WAKE; i++) updateBoat(0.1);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x886644, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 400 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);
  const warm = [new THREE.Vector3(LODGE_AT.x, PLATEAU + 3, LODGE_AT.y + 6), barAt.clone().setY(barAt.y + 3)].map(p => {
    const l = new THREE.PointLight(0xffa956, 0, 34, 1.6);
    l.position.copy(p);
    scene.add(l);
    return l;
  });
  const poolLight = new THREE.PointLight(0x4fe0ff, 0, 22, 1.6);
  poolLight.position.copy(poolLightAt);
  scene.add(poolLight);
  // The lighthouse beam: an additive cone that sweeps at night.
  const beam = new THREE.Mesh(new THREE.ConeGeometry(4, 46, 24, 1, true).translate(0, -23, 0).rotateZ(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  beamPivot.add(beam);

  // ---------- time of day ----------
  let hour = 17.5, nightNow = 0;
  const tmpA = new THREE.Color(), sunDir = new THREE.Vector3();
  function lerpKey(h) {
    let i = KEYS.findIndex(k => k.h > h);
    if (i <= 0) i = KEYS.length - 1;
    const a = KEYS[i - 1], b = KEYS[i], t = smooth(0, 1, (h - a.h) / (b.h - a.h));
    const out = {};
    for (const k of ["sunI", "hemiI", "exposure", "night"]) out[k] = THREE.MathUtils.lerp(a[k], b[k], t);
    for (const k of COLOR_KEYS) out[k] = new THREE.Color().copy(a[k]).lerp(b[k], t);
    return out;
  }
  function setHour(h) {
    hour = ((h % 24) + 24) % 24;
    const k = lerpKey(hour);
    // The sun rises in the east (+x) at 6:00, passes in front of the island and sets in the west at 18:00.
    const dayT = (hour - 6) / 12, el = Math.sin(Math.PI * dayT) * 1.15, az = Math.PI * dayT;
    const up = el > -0.02;
    if (up) sunDir.set(Math.cos(az) * Math.cos(el), Math.max(Math.sin(el), 0.04), 0.55 * Math.sin(az) * Math.cos(el) + 0.25).normalize();
    else sunDir.set(-0.35, 0.8, 0.45).normalize();   // moonlight
    sun.position.copy(sunDir).multiplyScalar(160);
    sun.color.copy(k.sun);
    sun.intensity = k.sunI;
    hemi.color.copy(k.hemiSky);
    hemi.groundColor.copy(k.hemiGround);
    hemi.intensity = k.hemiI;
    renderer.toneMappingExposure = k.exposure;
    scene.fog.color.copy(k.horizon);
    skyUniforms.uTop.value.copy(k.top);
    skyUniforms.uHorizon.value.copy(k.horizon);
    skyUniforms.uSunColor.value.copy(k.sun);
    skyUniforms.uSunDir.value.copy(sunDir);
    const sunUp = smooth(-0.02, 0.12, Math.sin(Math.PI * dayT) * 1.15);
    skyUniforms.uSunUp.value = sunUp;
    waterUniforms.uShallow.value.copy(k.shallow);
    waterUniforms.uDeep.value.copy(k.deep);
    waterUniforms.uHorizon.value.copy(k.horizon);
    waterUniforms.uSunColor.value.copy(k.sun);
    waterUniforms.uSunDir.value.copy(sunDir);
    waterUniforms.uSunUp.value = up ? 1 : 0.35;
    waterUniforms.uNight.value = k.night;
    nightNow = k.night;
    M.window.emissiveIntensity = k.night * 2.4;
    M.poolWater.emissiveIntensity = 0.15 + k.night * 1.4;
    M.cloud.color.copy(tmpA.set(0xffffff).lerp(k.horizon, 0.2 + k.night * 0.5));
    M.cloud.emissiveIntensity = 0.45 * (1 - k.night * 0.85);
    M.lampOff.color.set(0x5a5048).lerp(tmpA.set(0xffd08a), smooth(0.1, 0.5, k.night));
    glowMat.opacity = smooth(0.1, 0.6, k.night);
    starMat.opacity = smooth(0.5, 0.95, k.night);
    warm.forEach(l => { l.intensity = k.night * 120; });
    poolLight.intensity = k.night * 70;
    beam.material.opacity = smooth(0.6, 1, k.night) * 0.16;
    requestRender();
    return hour;
  }

  // ---------- camera, controls and fly-to ----------
  const HOME = { target: new THREE.Vector3(-2, 0, 6), dist: small ? 185 : 172, polar: 0.96, az: 0.32 };
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.08, enableZoom: false, enablePan: false,
    minPolarAngle: 0.35, maxPolarAngle: 1.3, rotateSpeed: 0.7, autoRotateSpeed: 0.35,
  });
  // On touch screens one finger scrolls the page; the arrow buttons and places move the camera instead.
  if (coarse) {
    controls.enableRotate = false;
    canvas.style.touchAction = "pan-y";
    const hint = stage.querySelector(".resort-hint");
    if (hint) hint.textContent = "Tap a number to fly there";
  }
  const sph = new THREE.Spherical();
  const offset = new THREE.Vector3();
  function applyView(view) {
    controls.target.copy(view.target);
    offset.setFromSphericalCoords(view.dist, view.polar, view.az);
    camera.position.copy(view.target).add(offset);
    camera.lookAt(view.target);
  }
  function currentView() {
    sph.setFromVector3(offset.copy(camera.position).sub(controls.target));
    return { target: controls.target.clone(), dist: sph.radius, polar: sph.phi, az: sph.theta };
  }
  let flight = null, lastInteraction = performance.now(), interacting = false;
  function flyTo(view, duration = 1.7) {
    const from = currentView();
    if (reducedMotion || duration === 0) { applyView(view); controls.update(); flight = null; requestRender(); return; }
    flight = { from, to: view, t: 0, duration, dAz: angleDiff(view.az, from.az) };
    controls.enabled = false;
    setRunning();
  }
  function stepFlight(dt) {
    flight.t = Math.min(1, flight.t + dt / flight.duration);
    const e = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    const { from, to } = flight;
    // Rise a little mid-flight so the move reads as a swoop.
    const lift = Math.sin(Math.PI * e) * Math.min(20, from.target.distanceTo(to.target) * 0.35);
    applyView({
      target: from.target.clone().lerp(to.target, e),
      dist: THREE.MathUtils.lerp(from.dist, to.dist, e) + lift,
      polar: THREE.MathUtils.lerp(from.polar, to.polar, e) - lift * 0.004,
      az: from.az + flight.dAz * e,
    });
    if (flight.t >= 1) { flight = null; controls.enabled = true; lastInteraction = performance.now(); }
  }
  controls.addEventListener("start", () => { interacting = true; stage.classList.add("is-dragging"); });
  controls.addEventListener("end", () => { interacting = false; lastInteraction = performance.now(); stage.classList.remove("is-dragging"); });

  // ---------- picking, hover rings and pins ----------
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd48a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
  const makeRing = () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 96).rotateX(-Math.PI / 2), ringMat.clone()); m.visible = false; m.renderOrder = 5; scene.add(m); return m; };
  const selRing = makeRing(), hoverRing = makeRing();
  const ringSize = { lodge: 19, pool: 15, spa: 11, beach: 13, villas: 22, jetty: 14, bar: 12 };
  const placeCenter = id => {
    const v = places[id].view.target;
    return new THREE.Vector3(v.x, groundAt(v.x, v.z) + 0.15, v.z);
  };
  const showRing = (ring, id) => {
    ring.visible = !!id;
    if (!id) return;
    const c = placeCenter(id);
    ring.position.set(c.x, Math.max(c.y, 0.2), c.z);
    ring.userData.size = ringSize[id] || 12;
  };
  let selected = null, hovered = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickRoots = Object.values(places).map(p => p.group);
  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickRoots, true)[0];
    return hit?.object.userData.place || null;
  }
  let pointerAt = null, downAt = null;
  canvas.addEventListener("pointermove", e => { pointerAt = [e.clientX, e.clientY]; requestRender(); });
  canvas.addEventListener("pointerleave", () => { pointerAt = null; setHover(null); });
  canvas.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; lastInteraction = performance.now(); });
  canvas.addEventListener("pointerup", e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const id = pick(e.clientX, e.clientY);
    if (id) stage.dispatchEvent(new CustomEvent("placepick", { detail: id }));
  });
  function setHover(id) {
    if (id === hovered) return;
    hovered = id;
    canvas.style.cursor = id ? "pointer" : "";
    pinEls.forEach(el => el.classList.toggle("is-hover", el.dataset.place === id));
    showRing(hoverRing, id && id !== selected ? id : null);
    requestRender();
  }

  const pinEls = [...pins.querySelectorAll("[data-place]")];
  pinEls.forEach(el => {
    el.addEventListener("pointerenter", () => setHover(el.dataset.place));
    el.addEventListener("pointerleave", () => setHover(null));
  });
  const projected = new THREE.Vector3(), toAnchor = new THREE.Vector3();
  let pinFrame = 0;
  function updatePins() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const checkOcclusion = pinFrame++ % 8 === 0;
    pinEls.forEach(el => {
      const p = places[el.dataset.place];
      if (!p) return;
      projected.copy(p.anchor).project(camera);
      const behind = projected.z > 1;
      el.style.transform = `translate(${((projected.x + 1) / 2 * w).toFixed(1)}px, ${((1 - projected.y) / 2 * h).toFixed(1)}px)`;
      if (checkOcclusion) {
        toAnchor.copy(p.anchor).sub(camera.position);
        const dist = toAnchor.length();
        raycaster.set(camera.position, toAnchor.normalize());
        raycaster.far = dist - 1;
        el.classList.toggle("is-hidden", behind || raycaster.intersectObjects(occluders, false).length > 0);
        raycaster.far = Infinity;
      }
    });
  }

  // ---------- render loop ----------
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Pull back on tall, narrow screens so the whole island fits.
    camera.fov = camera.aspect < 0.9 ? 46 : 34;
    // Where the places panel floats over the right of the stage, centre the island in the space left of it.
    const overlay = panel && getComputedStyle(panel).position === "absolute" ? panel.offsetWidth + 20 : 0;
    camera.filmOffset = overlay / 2 / w * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * camera.getFilmWidth();
    camera.updateProjectionMatrix();
    requestRender();
  }

  const clock = new THREE.Clock();
  let elapsed = 0, running = false, onScreen = false, frameQueued = false;
  function update(rawDt) {
    const dt = Math.min(rawDt, 0.05);
    elapsed += dt;
    if (flight) stepFlight(Math.min(rawDt, 0.25));
    else {
      controls.autoRotate = !reducedMotion && !interacting && performance.now() - lastInteraction > 7000;
      controls.update(dt);
    }
    waterUniforms.uTime.value = elapsed;
    clouds.forEach(c => {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 170) c.position.x = -170;
    });
    updateBoat(dt);
    beamPivot.rotation.y = elapsed * 0.8;
    const pulse = 1 + Math.sin(elapsed * 3) * 0.04;
    for (const ring of [selRing, hoverRing]) {
      if (!ring.visible) continue;
      ring.scale.setScalar(ring.userData.size * (ring === selRing ? pulse : 1));
      ring.material.opacity = ring === selRing ? 0.55 + Math.sin(elapsed * 3) * 0.15 : 0.35;
    }
    if (pointerAt && !interacting && !flight) setHover(pick(...pointerAt));
  }
  function render() {
    renderer.render(scene, camera);
    updatePins();
  }
  function frame() {
    if (!running) return;
    update(clock.getDelta());
    render();
    requestAnimationFrame(frame);
  }
  function setRunning() {
    const should = onScreen && !document.hidden && (!reducedMotion || !!flight);
    if (should && !running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
    if (!should) running = false;
  }
  function requestRender() {
    if (running || frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => { frameQueued = false; update(0); render(); });
  }
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; setRunning(); }).observe(stage);
  document.addEventListener("visibilitychange", setRunning);
  new ResizeObserver(resize).observe(canvas);
  controls.addEventListener("change", requestRender);

  applyView(HOME);
  setHour(hour);
  resize();
  render();

  return {
    setHour,
    focus(id) {
      if (!places[id]) return this.overview();
      selected = id;
      showRing(selRing, id);
      showRing(hoverRing, null);
      pinEls.forEach(el => el.classList.toggle("is-active", el.dataset.place === id));
      flyTo(places[id].view);
    },
    overview() {
      selected = null;
      showRing(selRing, null);
      pinEls.forEach(el => el.classList.remove("is-active"));
      flyTo(HOME);
    },
    rotate(dir) {
      const v = currentView();
      flyTo({ ...v, az: v.az + dir * 0.7 }, 0.8);
    },
    zoom(dir) {
      const v = currentView();
      flyTo({ ...v, dist: THREE.MathUtils.clamp(v.dist * (dir > 0 ? 0.78 : 1.28), 26, 230) }, 0.6);
    },
  };
}
