/*
 * orb-widget.js — hovering orb drone for any web page.
 *
 * Needs three.js through an import map (put this once in the page <head>):
 *   <script type="importmap">{"imports":{
 *     "three": "https://cdn.jsdelivr.net/npm/three@0.176.0/build/three.module.js",
 *     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.176.0/examples/jsm/"}}</script>
 *
 * Usage:
 *   import { mountOrb } from './orb-widget.js';
 *   const orb = await mountOrb(document.getElementById('orb'), { src: './orb.glb' });
 *   orb.scan();  // trigger the scan pulse from your own code
 *
 * Options (all optional):
 *   src       model URL or ArrayBuffer (meshopt GLB)         default './orb.glb'
 *   fallback  uncompressed GLB (URL, ArrayBuffer, or a function returning
 *             either), used if decompression fails           default null
 *   follow    turn toward the pointer                       default true
 *   shadow    soft floor shadow under the orb               default true
 *   clickToScan  click/tap the orb to trigger a scan        default true
 *   exposure  brightness                                    default 1.0
 *
 * Events: the container fires 'orb:scan' when a scan starts and 'orb:ready' once loaded.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function mountOrb(container, options = {}) {
  const o = { src: './orb.glb', fallback: null, follow: true, shadow: true,
              clickToScan: true, exposure: 1.0, ...options };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = o.exposure;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Hovering mechanical orb with a glowing amber eye');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
  const key = new THREE.DirectionalLight(0xffffff, 1.8);  key.position.set(-3, 4, 5);
  const rim = new THREE.DirectionalLight(0xc8d8ff, 1.4);  rim.position.set(3, 2.5, -4);
  const under = new THREE.DirectionalLight(0xffb070, 0.35); under.position.set(0, -4, 2);
  scene.add(key, rim, under);

  const rig = new THREE.Group();      // carries the hover bob
  scene.add(rig);

  // ---------------------------------------------------------------- model
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const load = (ld, src) => (src instanceof ArrayBuffer ? ld.parseAsync(src, '') : ld.loadAsync(src));
  let gltf, compressed = true;
  try {
    gltf = await load(loader, o.src);
  } catch (err) {
    if (!o.fallback) throw err;
    console.warn('orb-widget: compressed model failed, using fallback', err);
    compressed = false;
    const fb = typeof o.fallback === 'function' ? await o.fallback() : o.fallback;
    gltf = await load(new GLTFLoader(), fb);
  }
  rig.add(gltf.scene);
  const orb = gltf.scene.getObjectByName('Orb') || gltf.scene;

  let triangles = 0;
  const amberMats = [];
  gltf.scene.traverse((n) => {
    if (!n.isMesh) return;
    const g = n.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) if (m.name === 'Amber' && !amberMats.includes(m)) {
      m.userData.base = m.emissiveIntensity;
      amberMats.push(m);
    }
  });

  const fins = [];
  for (let i = 0; i < 12; i++) {
    const f = orb.getObjectByName('Fin_' + i);
    if (!f) continue;
    fins.push({
      obj: f,
      axis: f.position.clone().normalize(),
      base: f.quaternion.clone(),
      angle: Math.random() * Math.PI * 2,
      speed: (0.5 + Math.random() * 0.45) * (i % 2 ? -1 : 1),   // rad/s
    });
  }

  // eye glow and scan ring live on the orb so they turn with it
  const eyeZ = 1.06;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,160,60,0.55)'], [0.3, 'rgba(255,120,30,0.18)'], [1, 'rgba(255,110,20,0)']]),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.position.set(0, 0, eyeZ);
  glow.scale.setScalar(1.05);
  orb.add(glow);

  const ringTex = radialTexture([[0, 'rgba(255,150,40,0)'], [0.78, 'rgba(255,150,40,0)'],
                                 [0.88, 'rgba(255,170,60,0.9)'], [0.94, 'rgba(255,150,40,0)'], [1, 'rgba(255,150,40,0)']], 256);
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false,
                                  blending: THREE.AdditiveBlending, opacity: 0 }));
  ring.position.set(0, 0, eyeZ + 0.02);
  orb.add(ring);

  const floorY = -2.35;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(10,12,18,0.55)'], [0.5, 'rgba(10,12,18,0.18)'], [1, 'rgba(10,12,18,0)']]),
                                  transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = floorY;
  shadow.visible = o.shadow;
  scene.add(shadow);

  // ---------------------------------------------------------------- framing
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfH = 2.45, halfW = 2.3;                       // scene extent incl. fins and shadow
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(halfH / tanV, halfW / (tanV * camera.aspect)) + 0.6;
    camera.position.set(0, 0.35, dist);
    camera.lookAt(0, -0.12, 0);
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // ---------------------------------------------------------------- pointer
  const target = { yaw: 0, pitch: 0 };
  let lastMove = -1e9;
  function onMove(e) {
    if (!o.follow) return;
    const r = container.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const nx = THREE.MathUtils.clamp((e.clientX - cx) / (window.innerWidth * 0.5), -1, 1);
    const ny = THREE.MathUtils.clamp((e.clientY - cy) / (window.innerHeight * 0.5), -1, 1);
    target.yaw = nx * 0.85;
    target.pitch = ny * 0.5;
    lastMove = performance.now();
  }
  window.addEventListener('pointermove', onMove, { passive: true });

  let burst = 0;
  function scan() {
    burst = 1;
    container.dispatchEvent(new CustomEvent('orb:scan'));
  }
  const onClick = () => o.clickToScan && scan();
  canvas.addEventListener('click', onClick);
  if (o.clickToScan) canvas.style.cursor = 'pointer';

  // ---------------------------------------------------------------- loop
  let running = true, visible = true, raf = 0, last = performance.now(), t = 0;
  const qTarget = new THREE.Quaternion(), qSpin = new THREE.Quaternion(), e = new THREE.Euler();
  const camDir = new THREE.Vector3(), eyeDir = new THREE.Vector3();

  function frame(now) {
    raf = 0;
    if (!running || !visible || document.hidden) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;

    // idle wander when the pointer has been still for a while
    let yaw = target.yaw, pitch = target.pitch;
    if (!o.follow || now - lastMove > 2500) {
      yaw = Math.sin(t * 0.31) * 0.55;
      pitch = Math.sin(t * 0.23 + 1) * 0.18;
    }
    e.set(pitch, yaw, Math.sin(t * 0.5) * 0.06, 'YXZ');
    qTarget.setFromEuler(e);
    orb.quaternion.slerp(qTarget, 1 - Math.exp(-dt * 3.2));

    const bobAmp = reduced ? 0.02 : 0.09;
    const bob = Math.sin(t * 1.25) * bobAmp;
    rig.position.y = bob;
    rig.rotation.z = Math.sin(t * 0.7) * (reduced ? 0.01 : 0.035);

    burst *= Math.exp(-dt * 1.4);
    const spinBoost = 1 + (reduced ? 1.5 : 9) * burst;
    for (const f of fins) {
      f.angle += f.speed * spinBoost * dt;
      qSpin.setFromAxisAngle(f.axis, f.angle);
      f.obj.quaternion.copy(qSpin).multiply(f.base);
    }

    const pulse = 0.88 + 0.12 * Math.sin(t * 2.3);
    for (const m of amberMats) m.emissiveIntensity = m.userData.base * (pulse + burst * 1.2);

    // glow fades as the eye turns away from the camera
    eyeDir.set(0, 0, 1).applyQuaternion(orb.quaternion);
    camDir.copy(camera.position).normalize();
    const facing = THREE.MathUtils.clamp(eyeDir.dot(camDir), 0, 1);
    glow.material.opacity = Math.pow(facing, 2) * (0.5 + 0.2 * pulse + burst * 0.35);
    glow.scale.setScalar(1.05 + burst * 0.35);

    // scan ring expands out of the eye
    const p = 1 - burst;                         // 0 at start of scan, 1 when done
    ring.material.opacity = burst > 0.02 ? Math.sin(Math.min(p * 1.6, 1) * Math.PI) * facing : 0;
    ring.scale.setScalar(0.8 + p * 3.2);

    const lift = bob / bobAmp || 0;
    shadow.scale.set(3.0 - lift * 0.25, 1.1 - lift * 0.08, 1);
    shadow.material.opacity = 0.8 - lift * 0.15;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf && running && visible && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); });
  io.observe(container);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);
  kick();

  container.dispatchEvent(new CustomEvent('orb:ready'));

  return {
    scan,
    get compressed() { return compressed; },
    get triangles() { return Math.round(triangles); },
    get finRpm() { return fins.map((f) => Math.abs(f.speed) * (1 + 9 * burst) * 60 / (2 * Math.PI)); },
    set follow(v) { o.follow = !!v; },
    get follow() { return o.follow; },
    set shadow(v) { o.shadow = !!v; shadow.visible = o.shadow; },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('click', onClick);
      renderer.dispose();
      canvas.remove();
    },
  };
}
