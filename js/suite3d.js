// Interactive 3D room models: a cut-away diorama of each room type that guests can orbit,
// zoom and switch between day and night.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const WALL_H = 2.9, WALL_T = 0.18;

// Floor plan per room type, in metres. The window is on the left wall, the bed against the back wall.
const PLANS = {
  deluxe:       { w: 6.0, d: 5.2, bedX: 0.5, accent: 0x31504f },
  premier:      { w: 6.8, d: 5.8, bedX: 0.7, accent: 0x6b4a3a, tub: true },
  executive:    { w: 8.6, d: 6.6, bedX: 1.75, accent: 0x2d3d52, living: true },
  presidential: { w: 8.6, d: 6.6, bedX: 1.75, accent: 0x23302f, living: true, terrace: 4.6 },
};

// Lighting for day (0) and night (1); the viewer blends between them.
const LIGHTING = {
  sun: [3.2, 0.25], fill: [0.7, 0.08], hemi: [0.9, 0.12], env: [0.55, 0.1], lamp: [0.4, 3.2], pool: [0, 0.9],
};

const ease = t => 1 - Math.pow(1 - t, 3);

function woodTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  const tones = ["#b98d61", "#ad7f55", "#c49a6c", "#a97a50", "#b48659"];
  const rows = 8, h = 512 / rows;
  for (let r = 0; r < rows; r++) {
    let x = -Math.random() * 300;
    while (x < 512) {
      const len = 200 + Math.random() * 220;
      g.fillStyle = tones[Math.floor(Math.random() * tones.length)];
      g.fillRect(x, r * h, len, h);
      g.strokeStyle = "rgba(70,45,25,.16)";
      for (let k = 0; k < 7; k++) {
        const y = r * h + 4 + Math.random() * (h - 8);
        g.beginPath();
        g.moveTo(x, y);
        for (let s = x; s <= x + len; s += 24) g.lineTo(s, y + Math.sin(s * 0.02 + k) * 1.5);
        g.stroke();
      }
      g.fillStyle = "rgba(50,32,20,.5)";
      g.fillRect(x, r * h, 2, h);
      x += len;
    }
    g.fillStyle = "rgba(50,32,20,.55)";
    g.fillRect(0, r * h, 512, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// What you see through the window: sea and sky, by day or by moonlight.
function viewTexture(night) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 150);
  sky.addColorStop(0, night ? "#0b1430" : "#8fc3e3");
  sky.addColorStop(1, night ? "#3b2d52" : "#f6dcc0");
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 150);
  const sea = g.createLinearGradient(0, 150, 0, 256);
  sea.addColorStop(0, night ? "#17283f" : "#3f93ad");
  sea.addColorStop(1, night ? "#060d18" : "#1d5d75");
  g.fillStyle = sea;
  g.fillRect(0, 150, 256, 106);
  if (night) {
    g.fillStyle = "rgba(255,255,255,.8)";
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 256, Math.random() * 120, 1.2, 1.2);
    g.fillStyle = "#fff4d6";
    g.beginPath(); g.arc(186, 52, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,240,200,.35)";
    g.fillRect(180, 152, 12, 90);
  } else {
    g.fillStyle = "rgba(255,255,255,.75)";
    [[60, 50, 38], [170, 34, 30], [120, 80, 24]].forEach(([x, y, r]) => {
      g.beginPath(); g.ellipse(x, y, r, r * 0.32, 0, 0, Math.PI * 2); g.fill();
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function createMaterials(maxAnisotropy) {
  const std = (color, roughness = 0.8, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
  const wood = woodTexture();
  wood.anisotropy = maxAnisotropy;
  const viewDay = viewTexture(false);
  return {
    floor: std(0xffffff, 0.55, { map: wood }),
    deck: std(0xd8c6ad, 0.75, { map: wood }),
    wall: std(0xf1ebe2, 0.92),
    slab: std(0x26221e, 0.85),
    walnut: std(0x5e4332, 0.55),
    linen: std(0xfdfbf7, 0.9),
    duvet: std(0xf3ede3, 0.9),
    upholstery: std(0xcdbfa8, 0.95),
    sofa: std(0xd8ccb9, 0.95),
    sofaLight: std(0xe7ddcd, 0.95),
    goldFabric: std(0xb08d57, 0.7),
    gold: std(0xc9a46a, 0.3, { metalness: 1 }),
    frame: std(0x2b2622, 0.45, { metalness: 0.5 }),
    rug: std(0xd9ccb6, 1),
    marble: std(0xefebe5, 0.25),
    stone: std(0xe3dccf, 0.8),
    porcelain: std(0xffffff, 0.15),
    screen: std(0x141516, 0.3),
    leaf: std(0x56804c, 0.8, { flatShading: true }),
    pot: std(0xd8d0c2, 0.6),
    canvas: std(0xf3ede2, 0.9, { side: THREE.DoubleSide }),
    shade: std(0xfff1d6, 0.6, { emissive: 0xffc77a, emissiveIntensity: 0.6, side: THREE.DoubleSide }),
    water: std(0x58bfd4, 0.05, { transparent: true, opacity: 0.88, emissive: 0x1aa3c4, emissiveIntensity: 0 }),
    glass: std(0xcfe8f2, 0.05, { transparent: true, opacity: 0.16, metalness: 0.1, depthWrite: false }),
    view: new THREE.MeshBasicMaterial({ map: viewDay, toneMapped: false }),
    viewDay,
    viewNight: viewTexture(true),
  };
}

// ---------- Geometry helpers ----------
function solid(geometry, material, shadows = true) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = m.receiveShadow = shadows;
  return m;
}
const rbox = (w, h, d, mat, r = 0.04) =>
  solid(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), mat);

// Adds a mesh with its bottom at `bottom`.
function add(parent, mesh, x, bottom, z) {
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  mesh.position.set(x, bottom - geo.boundingBox.min.y * mesh.scale.y, z);
  parent.add(mesh);
  return mesh;
}

// A plain box given its size, centre on x/z and bottom on y.
function block(w, h, d, mat, x, bottom, z, shadows = true) {
  const m = solid(new THREE.BoxGeometry(w, h, d), mat, shadows);
  m.position.set(x, bottom + h / 2, z);
  return m;
}

function place(parent, obj, x, z, rotY = 0) {
  obj.position.set(x, 0, z);
  obj.rotation.y = rotY;
  parent.add(obj);
  return obj;
}

// ---------- Furniture (each faces +z, with its back at z = 0) ----------
function bed(M, accent) {
  const g = new THREE.Group();
  add(g, rbox(2.3, 0.32, 2.35, M.walnut, 0.05), 0, 0, 1.25);
  add(g, rbox(2.1, 0.3, 2.2, M.linen, 0.09), 0, 0.28, 1.25);
  add(g, rbox(2.18, 0.1, 1.5, M.duvet, 0.05), 0, 0.53, 1.62);
  add(g, rbox(2.22, 0.11, 0.42, M.goldFabric, 0.04), 0, 0.535, 2.0);
  [-0.48, 0.48].forEach(x => add(g, rbox(0.82, 0.2, 0.48, M.linen, 0.09), x, 0.56, 0.42));
  [-0.28, 0.28].forEach((x, i) => {
    const c = add(g, rbox(0.48, 0.42, 0.14, accent, 0.06), x, 0.58, 0.7);
    c.rotation.set(-0.25, 0, i ? -0.06 : 0.06);
  });
  add(g, rbox(2.7, 1.35, 0.16, M.upholstery, 0.06), 0, 0, 0.08);
  return g;
}

function nightstand(M, lamps) {
  const g = new THREE.Group();
  add(g, rbox(0.55, 0.5, 0.45, M.walnut, 0.03), 0, 0, 0.25);
  add(g, rbox(0.3, 0.02, 0.02, M.gold, 0.008), 0, 0.33, 0.48);
  add(g, solid(new THREE.CylinderGeometry(0.05, 0.09, 0.32, 16), M.gold), 0.05, 0.5, 0.22);
  add(g, solid(new THREE.CylinderGeometry(0.15, 0.21, 0.26, 24, 1, true), M.shade, false), 0.05, 0.8, 0.22);
  const light = new THREE.PointLight(0xffc27a, 0, 4.5, 2);
  light.position.set(0.05, 0.95, 0.22);
  g.add(light);
  lamps.push(light);
  return g;
}

function plant(M, s = 1) {
  const g = new THREE.Group();
  add(g, solid(new THREE.CylinderGeometry(0.2, 0.16, 0.42, 20), M.pot), 0, 0, 0);
  [[0, 0.55, 0, 0.3], [0.14, 0.8, 0.06, 0.26], [-0.12, 0.95, -0.05, 0.27], [0.05, 1.18, 0.1, 0.22],
   [-0.08, 0.7, 0.14, 0.22], [0.12, 1.05, -0.12, 0.2], [-0.02, 1.35, -0.02, 0.17]].forEach(([x, y, z, r]) => {
    const leaf = solid(new THREE.IcosahedronGeometry(r, 0), M.leaf);
    leaf.position.set(x, y, z);
    leaf.rotation.set(x * 9, y * 5, z * 7);
    g.add(leaf);
  });
  g.scale.setScalar(s);
  return g;
}

function desk(M, accent) {
  const g = new THREE.Group();
  add(g, rbox(1.4, 0.05, 0.6, M.walnut, 0.02), 0, 0.72, 0.3);
  [-0.65, 0.65].forEach(x => add(g, rbox(0.05, 0.72, 0.55, M.walnut, 0.02), x, 0, 0.3));
  add(g, rbox(0.34, 0.015, 0.24, M.screen, 0.005), 0.15, 0.77, 0.32);
  add(g, rbox(0.5, 0.08, 0.5, accent, 0.03), 0, 0.45, 0.95);
  add(g, rbox(0.5, 0.45, 0.06, accent, 0.03), 0, 0.5, 1.2);
  [[-0.2, 0.75], [0.2, 0.75], [-0.2, 1.15], [0.2, 1.15]].forEach(([x, z]) =>
    add(g, solid(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 8), M.gold), x, 0, z));
  return g;
}

function armchair(M) {
  const g = new THREE.Group();
  add(g, rbox(0.85, 0.4, 0.8, M.sofa, 0.1), 0, 0, 0.4);
  add(g, rbox(0.85, 0.5, 0.18, M.sofa, 0.08), 0, 0.3, 0.09);
  [-0.345, 0.345].forEach(x => add(g, rbox(0.16, 0.55, 0.8, M.sofa, 0.07), x, 0, 0.4));
  add(g, rbox(0.55, 0.12, 0.6, M.sofaLight, 0.05), 0, 0.4, 0.47);
  return g;
}

function sofa(M, accent, len = 2.4) {
  const g = new THREE.Group();
  add(g, rbox(len, 0.42, 0.95, M.sofa, 0.08), 0, 0, 0.475);
  add(g, rbox(len, 0.5, 0.22, M.sofa, 0.08), 0, 0.3, 0.11);
  [-1, 1].forEach(s => add(g, rbox(0.2, 0.6, 0.95, M.sofa, 0.08), s * (len / 2 - 0.1), 0, 0.475));
  const seat = (len - 0.4) / 3;
  for (let i = 0; i < 3; i++) add(g, rbox(seat - 0.03, 0.14, 0.7, M.sofaLight, 0.06), -len / 2 + 0.2 + seat * (i + 0.5), 0.42, 0.58);
  [-0.6, 0.6].forEach((x, i) => {
    const c = add(g, rbox(0.42, 0.4, 0.13, accent, 0.06), x, 0.5, 0.3);
    c.rotation.set(-0.2, 0, i ? -0.1 : 0.1);
  });
  return g;
}

function coffeeTable(M, accent) {
  const g = new THREE.Group();
  add(g, solid(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 32), M.gold), 0, 0, 0);
  add(g, solid(new THREE.CylinderGeometry(0.07, 0.07, 0.37, 16), M.gold), 0, 0.03, 0);
  add(g, solid(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 48), M.marble), 0, 0.4, 0);
  add(g, rbox(0.32, 0.04, 0.24, accent, 0.01), -0.15, 0.45, 0.05);
  add(g, rbox(0.28, 0.04, 0.2, M.linen, 0.01), -0.15, 0.49, 0.05);
  add(g, solid(new THREE.CylinderGeometry(0.06, 0.08, 0.22, 20), M.porcelain), 0.2, 0.45, -0.1);
  return g;
}

function tub(M) {
  const g = new THREE.Group();
  const profile = [[0.001, 0], [0.62, 0], [0.72, 0.08], [0.78, 0.55], [0.75, 0.6], [0.7, 0.58], [0.64, 0.14], [0.001, 0.14]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const shell = solid(new THREE.LatheGeometry(profile, 48), M.porcelain);
  shell.scale.set(1, 1, 0.62);
  g.add(shell);
  const water = solid(new THREE.CircleGeometry(0.67, 40), M.water, false);
  water.rotation.x = -Math.PI / 2;
  water.scale.set(1, 0.6, 1);
  water.position.y = 0.46;
  g.add(water);
  add(g, solid(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 10), M.gold), 0.92, 0, 0);
  const spout = solid(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 10), M.gold);
  spout.rotation.z = Math.PI / 2;
  spout.position.set(0.82, 0.93, 0);
  g.add(spout);
  return g;
}

function lounger(M) {
  const g = new THREE.Group();
  add(g, rbox(0.66, 0.26, 1.75, M.walnut, 0.04), 0, 0, 0);
  add(g, rbox(0.6, 0.08, 1.15, M.linen, 0.04), 0, 0.26, 0.28);
  const back = add(g, rbox(0.6, 0.08, 0.62, M.linen, 0.04), 0, 0.42, -0.6);
  back.rotation.x = 0.75;
  return g;
}

function umbrella(M) {
  const g = new THREE.Group();
  add(g, solid(new THREE.CylinderGeometry(0.25, 0.28, 0.06, 24), M.slab), 0, 0, 0);
  add(g, solid(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 10), M.walnut), 0, 0.06, 0);
  add(g, solid(new THREE.ConeGeometry(1.25, 0.45, 24, 1, true), M.canvas), 0, 1.95, 0);
  return g;
}

function glassRail(M, length, alongX) {
  const g = new THREE.Group();
  const pane = solid(new THREE.BoxGeometry(alongX ? length : 0.02, 1, alongX ? 0.02 : length), M.glass, false);
  pane.position.y = 0.52;
  g.add(pane);
  g.add(block(alongX ? length : 0.05, 0.04, alongX ? 0.05 : length, M.gold, 0, 1.02, 0));
  return g;
}

// ---------- Room ----------
function buildRoom(M, slug, lamps) {
  const plan = PLANS[slug] || PLANS.deluxe;
  const { w, d, bedX } = plan;
  const T = plan.terrace || 0, H = WALL_H, t = WALL_T;
  const room = new THREE.Group();
  const accent = new THREE.MeshStandardMaterial({ color: plan.accent, roughness: 0.85 });
  room.userData.materials = [accent];

  // Base slab, floors and a soft shadow underneath
  room.add(block(w + T + 0.36 + t, 0.32, d + 0.36 + t, M.slab, (T - t) / 2, -0.32, -t / 2));
  const floorGeo = new THREE.BoxGeometry(w, 0.04, d);
  floorGeo.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? d : w) / 2.4; });
  room.add(solid(floorGeo, M.floor));
  if (T) {
    const deckGeo = new THREE.BoxGeometry(T, 0.04, d);
    deckGeo.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? T : d) / 2.4; });
    const deck = solid(deckGeo, M.deck);
    deck.position.set(w / 2 + T / 2, 0, 0);
    room.add(deck);
  }
  const blob = new THREE.Mesh(new THREE.PlaneGeometry((w + T) * 1.5, d * 1.6),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(T / 2, -0.34, 0);
  room.add(blob);
  room.userData.materials.push(blob.material, blob.material.map);

  // Back wall, and the left wall with a window cut out of it
  const lx = -w / 2 - t / 2;
  const zc = d * 0.1, ww = Math.min(2.4, d * 0.42), y0 = 0.5, y1 = 2.45;
  room.add(block(w + t, H, t, M.wall, -t / 2, 0, -d / 2 - t / 2));
  room.add(block(t, H, zc - ww / 2 + d / 2, M.wall, lx, 0, (zc - ww / 2 - d / 2) / 2));
  room.add(block(t, H, d / 2 - zc - ww / 2, M.wall, lx, 0, (zc + ww / 2 + d / 2) / 2));
  room.add(block(t, y0, ww, M.wall, lx, 0, zc));
  room.add(block(t, H - y1, ww, M.wall, lx, y1, zc));
  room.add(block(w + t + 0.01, 0.03, t + 0.01, M.slab, -t / 2, H, -d / 2 - t / 2, false));
  room.add(block(t + 0.01, 0.03, d + t, M.slab, lx, H, -t / 2, false));
  const view = new THREE.Mesh(new THREE.PlaneGeometry(ww, y1 - y0), M.view);
  view.rotation.y = Math.PI / 2;
  view.position.set(-w / 2 - t * 0.7, (y0 + y1) / 2, zc);
  room.add(view);
  room.add(block(0.04, y1 - y0, 0.05, M.frame, -w / 2 - t * 0.6, y0, zc));
  room.add(block(t + 0.1, 0.04, ww + 0.12, M.marble, lx + 0.05, y0 - 0.04, zc));

  // Slatted feature wall behind the bed
  for (let i = 0; i < 14; i++) room.add(block(0.15, 2.55, 0.05, accent, bedX - 1.65 + i * 0.254, 0, -d / 2 + 0.025));

  // Bedroom
  place(room, bed(M, accent), bedX, -d / 2 + 0.05);
  place(room, nightstand(M, lamps), bedX - 1.7, -d / 2 + 0.03);
  place(room, nightstand(M, lamps), bedX + 1.7, -d / 2 + 0.03);
  room.add(block(1.7, 0.42, 0.45, M.upholstery, bedX, 0, -d / 2 + 2.75));
  room.add(block(3.4, 0.015, 2.4, M.rug, bedX, 0.02, -d / 2 + 2.0));
  place(room, plant(M), -w / 2 + 0.45, -d / 2 + 0.45);

  if (plan.living) {
    // Living area along the window wall
    place(room, sofa(M, accent), -w / 2 + 0.02, zc, Math.PI / 2);
    place(room, coffeeTable(M, accent), -w / 2 + 1.75, zc);
    place(room, armchair(M), -w / 2 + 3.35, zc - 0.65, -Math.PI / 2);
    place(room, armchair(M), -w / 2 + 3.35, zc + 0.75, -Math.PI / 2);
    room.add(block(3.2, 0.015, 2.9, M.rug, -w / 2 + 1.9, 0.02, zc));
    room.add(block(1.8, 0.75, 0.45, M.walnut, -w / 2 + 2.05, 0, -d / 2 + 0.23));
    room.add(block(1.1, 0.75, 0.03, M.gold, -w / 2 + 2.05, 1.35, -d / 2 + 0.02));
    room.add(block(0.98, 0.63, 0.03, accent, -w / 2 + 2.05, 1.41, -d / 2 + 0.04));
    add(room, solid(new THREE.CylinderGeometry(0.09, 0.12, 0.42, 20), M.porcelain), -w / 2 + 1.55, 0.75, -d / 2 + 0.25);
    place(room, plant(M, 0.8), w / 2 - 0.5, d / 2 - 0.5);
  } else {
    place(room, armchair(M), w / 2 - 0.85, d / 2 - 0.9, -2.36);
  }
  if (plan.tub) place(room, tub(M), -w / 2 + 1.25, zc + 0.55, Math.PI / 2);
  else if (!plan.living) place(room, desk(M, accent), -w / 2 + 0.02, d / 2 - 1.05, Math.PI / 2);

  if (T) {
    // Floor-to-ceiling glass onto a private terrace with a plunge pool
    const gx = w / 2;
    room.add(block(0.03, H - 0.02, d, M.glass, gx, 0.01, 0, false));
    for (let i = 0; i <= 4; i++) room.add(block(0.06, H, 0.06, M.frame, gx, 0, -d / 2 + 0.03 + i * (d - 0.06) / 4));
    room.add(block(0.14, 0.12, d, M.frame, gx, H - 0.12, 0));
    const px = gx + T - 1.35;
    room.add(block(2.4, 0.3, 3.8, M.stone, px, 0, -0.55));
    room.add(block(2.1, 0.02, 3.5, M.water, px, 0.3, -0.55, false));
    place(room, lounger(M), gx + 1.15, -1.75, Math.PI / 2);
    place(room, lounger(M), gx + 1.15, -0.35, Math.PI / 2);
    place(room, umbrella(M), gx + 1.3, 1.05);
    place(room, plant(M, 0.9), gx + T - 0.45, d / 2 - 0.45);
    place(room, glassRail(M, d, false), gx + T - 0.03, 0);
    place(room, glassRail(M, T, true), gx + T / 2, -d / 2 + 0.03);
    place(room, glassRail(M, T, true), gx + T / 2, d / 2 - 0.03);
  }
  return room;
}

function disposeRoom(room) {
  room.traverse(o => o.geometry?.dispose());
  room.userData.materials.forEach(m => m.dispose());
}

export function createSuiteViewer(canvas, { reducedMotion = false } = {}) {
  const stage = canvas.parentElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const M = createMaterials(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const hemi = new THREE.HemisphereLight(0xfff4e2, 0x4a3b2e, 1);
  const sun = new THREE.DirectionalLight(0xffe2b8, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(hemi, sun, sun.target, fill);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.08, enableZoom: false, enablePan: false,
    minPolarAngle: 0.45, maxPolarAngle: 1.32, minAzimuthAngle: -0.1, maxAzimuthAngle: 1.65,
  });

  const HOME = { theta: 0.62, phi: 1.02 };
  const spherical = new THREE.Spherical();
  const offset = new THREE.Vector3();
  const goalTarget = new THREE.Vector3();
  let room = null, lamps = [], slug = null, size = 8;
  let anim = null, zoom = 1, radius = 0, night = 0, nightGoal = 0;
  let idleDir = 1, lastInteraction = -Infinity, interacting = false;

  controls.addEventListener("start", () => { interacting = true; stage.classList.add("is-dragging"); });
  controls.addEventListener("end", () => { interacting = false; lastInteraction = performance.now(); stage.classList.remove("is-dragging"); });

  const fitRadius = () => size * 0.55 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect / 1.25);

  function frameRoom(plan) {
    const T = plan.terrace || 0;
    size = Math.hypot(plan.w + T, plan.d);
    goalTarget.set(T / 2, 0.8, 0);
    const reach = size / 2 + 1.5;
    Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: 50 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(goalTarget);
    sun.position.copy(goalTarget).add(new THREE.Vector3(-9, 8.5, 2.5));
    fill.position.copy(goalTarget).add(new THREE.Vector3(7, 5, 10));
  }

  function show(next) {
    if (!PLANS[next] || next === slug) return;
    slug = next;
    const newLamps = [];
    const built = buildRoom(M, next, newLamps);
    frameRoom(PLANS[next]);
    if (reducedMotion || !room) {
      if (room) { scene.remove(room); disposeRoom(room); }
      room = built; lamps = newLamps;
      scene.add(room);
      if (!reducedMotion) anim = { t: 0.28, old: null, next: built };
    } else {
      anim = { t: 0, old: room, next: built, nextLamps: newLamps };
    }
    if (!radius) {
      radius = fitRadius();
      controls.target.copy(goalTarget);
      offset.setFromSphericalCoords(radius, HOME.phi, HOME.theta);
      camera.position.copy(goalTarget).add(offset);
    }
    applyLighting();
    loopOnce();
  }

  function applyLighting() {
    const k = night, lerp = ([a, b]) => a + (b - a) * k;
    sun.intensity = lerp(LIGHTING.sun);
    sun.color.setHex(k > 0.5 ? 0x9fb4ff : 0xffe2b8);
    fill.intensity = lerp(LIGHTING.fill);
    hemi.intensity = lerp(LIGHTING.hemi);
    scene.environmentIntensity = lerp(LIGHTING.env);
    lamps.forEach(l => { l.intensity = lerp(LIGHTING.lamp); });
    M.shade.emissiveIntensity = 0.4 + k * 1.6;
    M.water.emissiveIntensity = lerp(LIGHTING.pool);
    const view = k > 0.5 ? M.viewNight : M.viewDay;
    if (M.view.map !== view) { M.view.map = view; M.view.needsUpdate = true; }
  }

  function step(dt, now) {
    // Room change: the old model sinks away, then the new one rises in.
    if (anim) {
      anim.t += dt;
      if (anim.old) {
        const p = ease(Math.min(anim.t / 0.28, 1));
        anim.old.scale.setScalar(1 - 0.15 * p);
        anim.old.position.y = -1.2 * p;
        if (anim.t >= 0.28) {
          scene.remove(anim.old);
          disposeRoom(anim.old);
          anim.old = null;
          room = anim.next; lamps = anim.nextLamps;
          scene.add(room);
          applyLighting();
        }
      }
      if (!anim.old) {
        const p = ease(Math.min((anim.t - 0.28) / 0.6, 1));
        anim.next.scale.setScalar(0.85 + 0.15 * p);
        anim.next.position.y = -1.2 * (1 - p);
        if (p >= 1) anim = null;
      }
    }

    if (Math.abs(nightGoal - night) > 0.001) {
      night += (nightGoal - night) * Math.min(1, dt * 4);
      if (Math.abs(nightGoal - night) < 0.01) night = nightGoal;
      applyLighting();
    }

    // Ease the camera towards the room's framing and zoom; drift gently when nobody is dragging.
    const k = Math.min(1, dt * 5);
    radius += (fitRadius() * zoom - radius) * k;
    offset.copy(camera.position).sub(controls.target);
    controls.target.lerp(goalTarget, k);
    spherical.setFromVector3(offset);
    if (!reducedMotion && !interacting && now - lastInteraction > 4000) {
      spherical.theta += idleDir * dt * 0.1;
      if (spherical.theta > 1.25) idleDir = -1;
      if (spherical.theta < 0.15) idleDir = 1;
    }
    spherical.radius = radius;
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  // Render loop, active only while the viewer is on screen.
  const clock = new THREE.Clock();
  let running = false, onScreen = false;
  function frame() {
    if (!running) return;
    step(Math.min(clock.getDelta(), 0.05), performance.now());
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  function setRunning() {
    const should = onScreen && !document.hidden;
    if (should && !running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
    if (!should) running = false;
  }
  function loopOnce() {
    if (running) return;
    requestAnimationFrame(() => { step(1, performance.now()); renderer.render(scene, camera); });
  }
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; setRunning(); }).observe(stage);
  document.addEventListener("visibilitychange", setRunning);
  new ResizeObserver(() => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    loopOnce();
  }).observe(stage);

  return {
    show,
    zoom(direction) {
      zoom = THREE.MathUtils.clamp(zoom * (direction > 0 ? 0.85 : 1 / 0.85), 0.55, 1.5);
      lastInteraction = performance.now();
      loopOnce();
    },
    reset() {
      zoom = 1;
      offset.setFromSphericalCoords(camera.position.distanceTo(controls.target), HOME.phi, HOME.theta);
      camera.position.copy(controls.target).add(offset);
      lastInteraction = -Infinity;
      loopOnce();
    },
    setNight(on) {
      nightGoal = on ? 1 : 0;
      if (reducedMotion) { night = nightGoal; applyLighting(); }
      loopOnce();
    },
  };
}
