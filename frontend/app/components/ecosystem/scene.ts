/**
 * EcosystemScene — the three.js half of the Holder Ecosystem.
 *
 * Ported from the design's standalone `ecosystem.js`. Everything that runs
 * per frame lives here, outside React: the component hands over a node list
 * whenever chain state changes (`sync`) and gets hover / select callbacks
 * back, so React never re-renders on animation frames.
 *
 * The geometry is a direct map of the protocol:
 *   • the core is Total Mass (S);
 *   • the wireframe shell at r = 6 is the Event Horizon (balance == L);
 *   • accounts orbit inside it in proportion to balance / L, and anything
 *     above L is flung outside the shell (vaulted);
 *   • registered pools ride the outer ring at r = 13.5.
 *
 * Each body's inclination / phase is seeded from its address, so a holder
 * keeps the same orbit across reloads and polls.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_TWEAKS, type EcoNode, type EcoStatus, type EcoTweaks } from "./types";

const STATUS_HEX: Record<EcoStatus, number> = {
  safe: 0x30d158,
  near: 0xff9f0a,
  vaulted: 0xbf5af2,
  pool: 0x0a84ff,
};
const CORE_HEX = 0xbf5af2;
const BG_HEX = 0x07070a;

const HORIZON_R = 6;
const POOL_R = 13.5;
const CAMERA_HOME = new THREE.Vector3(0, 9, 24);

// Glow must not vanish on tiny bodies: absolute floor + size-proportional term.
const BLOOM_FLOOR = 0.9;
const CORONA_FLOOR = 2.2;

export interface EcosystemHandlers {
  /** Hovered body id (null when none, or when hovering the selected body) + canvas-relative pointer. */
  onHover: (id: string | null, x: number, y: number) => void;
  onSelect: (id: string | null) => void;
}

interface Body {
  node: EcoNode;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  bloom: THREE.Sprite;
  corona: THREE.Sprite;
  size: number;
  r: number;
  targetR: number;
  incl: number;
  ascending: number;
  phase: number;
  speed: number;
  /** Twinkle rate / phase. */
  tw: number;
  tp: number;
}

interface Ping {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  body: Body;
  t: number;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function orbitR(n: EcoNode, L: number): number {
  if (n.kind === "pool") return POOL_R;
  const r = L > 0 ? n.balance / L : 0;
  if (r <= 1) return 2.4 + 3.6 * Math.pow(r, 0.42);
  return HORIZON_R + Math.min(4.2, 2.3 * Math.log2(r));
}

function sizeOf(n: EcoNode, L: number, mult: number): number {
  // Pools scale gently with their share of S, so the dominant pool reads
  // as the heavier body without dwarfing the ring.
  if (n.kind === "pool") return (0.2 + 0.25 * Math.sqrt(n.share ?? 0.25)) * mult;
  const r = L > 0 ? n.balance / L : 0;
  return (0.048 + 0.12 * Math.cbrt(Math.min(3, r))) * mult;
}

/** Sprites are mesh children, so world size = child.scale × body size — divide it back out. */
function glowScale(size: number, mult: number, floor: number): number {
  return (floor + size * mult) / size;
}

/** Deterministic per-address RNG (FNV-1a seed → LCG). */
function seeded(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Stars are self-luminous: brighten the hue toward white-hot at the centre. */
function hot(hex: number, amt: number): THREE.Color {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), amt);
}

/** Radial glow texture — `power` steepens falloff (higher = tighter hot centre). */
function glowTex(power: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    g.addColorStop(t, `rgba(255,255,255,${Math.pow(1 - t, power).toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function spriteMat(tex: THREE.Texture, hex: number, opacity: number): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map: tex,
    color: hex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
}

// ─── Scene ───────────────────────────────────────────────────────────────────

export class EcosystemScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly timer = new THREE.Timer();

  private readonly texBloom = glowTex(1.7); // tight, bright — the star's own light
  private readonly texCorona = glowTex(3.2); // wide, faint — atmospheric scatter
  private readonly sphereGeo = new THREE.SphereGeometry(1, 24, 16);

  private readonly core = new THREE.Group();
  private readonly coreMesh: THREE.Mesh;
  private readonly coreBloom: THREE.Sprite;
  private readonly coreGlow: THREE.Sprite;
  private readonly shell: THREE.Mesh;
  private readonly selRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly nodeLayer = new THREE.Group();

  private readonly bodies = new Map<string, Body>();
  private readonly pings: Ping[] = [];
  private readonly hidden = new Set<EcoStatus>();
  private tweaks: EcoTweaks;
  private L = 0;
  private synced = false;

  private hovered: Body | null = null;
  private selected: Body | null = null;

  private readonly ray = new THREE.Raycaster();
  private readonly ptr = new THREE.Vector2();
  private readonly tmpScale = new THREE.Vector3();
  private downAt: { x: number; y: number } | null = null;

  private raf = 0;
  private onScreen = true;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resizeObs: ResizeObserver;
  private readonly visObs: IntersectionObserver;
  private disposed = false;

  constructor(
    private readonly mount: HTMLElement,
    private readonly handlers: EcosystemHandlers,
    tweaks: EcoTweaks = DEFAULT_TWEAKS
  ) {
    this.tweaks = { ...tweaks };

    this.scene.fog = new THREE.FogExp2(BG_HEX, 0.022);
    this.camera.position.copy(CAMERA_HOME);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG_HEX, 1);
    mount.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 60;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = this.tweaks.spin;
    this.controls.addEventListener("start", this.onControlStart);
    this.controls.addEventListener("end", this.onControlEnd);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // Core: the HITZ star (Total Mass).
    this.coreMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshBasicMaterial({ color: hot(CORE_HEX, 0.55) })
    );
    this.coreMesh.scale.setScalar(1.05);
    this.core.add(this.coreMesh);
    this.coreBloom = new THREE.Sprite(spriteMat(this.texBloom, CORE_HEX, 0.85));
    this.coreBloom.scale.setScalar(4.2);
    this.core.add(this.coreBloom);
    this.coreGlow = new THREE.Sprite(spriteMat(this.texCorona, CORE_HEX, 0.5));
    this.coreGlow.scale.setScalar(13);
    this.core.add(this.coreGlow);
    this.scene.add(this.core);

    // Event Horizon shell (balance == L).
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(HORIZON_R, 40, 24),
      new THREE.MeshBasicMaterial({
        color: STATUS_HEX.pool,
        wireframe: true,
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
      })
    );
    this.shell.renderOrder = -2;
    this.scene.add(this.shell);
    this.scene.add(this.ring(HORIZON_R, 0.018, 160, 0.5));

    // Pool orbit ring.
    this.scene.add(this.ring(POOL_R, 0.012, 200, 0.18));

    // Starfield backdrop.
    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(1400 * 3);
    for (let i = 0; i < 1400; i++) {
      const r = 70 + Math.random() * 120;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sp[i * 3 + 1] = r * Math.cos(ph);
      sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    this.scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({
          color: 0x8e8e93,
          size: 0.35,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.55,
        })
      )
    );

    this.scene.add(this.nodeLayer);

    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(1.35, 1.5, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      })
    );
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("click", this.onClick);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(mount);
    this.resize();

    // Don't burn GPU while the card is scrolled away or the tab is hidden.
    this.visObs = new IntersectionObserver(([entry]) => {
      this.onScreen = entry.isIntersecting;
      this.updateLoop();
    });
    this.visObs.observe(mount);

    this.updateLoop();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Reconcile the scene with the latest chain state. New holders fade in
   * with a ping, departed ones (balance → 0, pool deregistered) are
   * removed, and any balance or status change re-targets the orbit and
   * pings — every flash on screen is a real ledger write.
   */
  sync(nodes: EcoNode[], L: number): void {
    const first = !this.synced;
    this.synced = true;
    const lChanged = L !== this.L;
    this.L = L;

    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.id);
      const b = this.bodies.get(n.id);
      if (!b) {
        const nb = this.addBody(n);
        if (!first) this.flash(nb);
        continue;
      }
      const prev = b.node;
      b.node = n;
      const statusChanged = prev.status !== n.status;
      const moved = prev.balance !== n.balance || prev.share !== n.share;
      if (statusChanged) this.recolor(b);
      if (statusChanged || moved || lChanged) {
        b.targetR = orbitR(n, L);
        b.size = sizeOf(n, L, this.tweaks.size);
      }
      if (statusChanged || moved) this.flash(b);
    }

    for (const [id, b] of this.bodies) {
      if (!seen.has(id)) this.removeBody(b);
    }
  }

  setHidden(status: EcoStatus, hidden: boolean): void {
    if (hidden) this.hidden.add(status);
    else this.hidden.delete(status);
    for (const b of this.bodies.values()) this.applyVisibility(b);
  }

  setTweaks(tweaks: EcoTweaks): void {
    this.tweaks = { ...tweaks };
    for (const b of this.bodies.values()) {
      b.size = sizeOf(b.node, this.L, this.tweaks.size);
      b.mesh.scale.setScalar(b.size);
      b.bloom.material.opacity = 0.7 * this.tweaks.glow;
      b.corona.material.opacity = 0.28 * this.tweaks.glow;
    }
    this.core.scale.setScalar(this.tweaks.core);
    this.controls.autoRotateSpeed = this.tweaks.spin;
  }

  select(id: string | null): void {
    const b = id ? this.bodies.get(id) ?? null : null;
    this.selected = b;
    if (!b) this.selRing.visible = false;
  }

  resetView(): void {
    this.controls.reset();
    this.camera.position.copy(CAMERA_HOME);
    this.setSelected(null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.resizeObs.disconnect();
    this.visObs.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("click", this.onClick);
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.removeEventListener("end", this.onControlEnd);
    this.controls.dispose();

    this.scene.traverse((obj) => {
      const o = obj as THREE.Mesh;
      // Sprites share one module-level geometry across every instance.
      if (!(obj instanceof THREE.Sprite)) o.geometry?.dispose();
      const mat = o.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.texBloom.dispose();
    this.texCorona.dispose();
    this.renderer.dispose();
    // The Monitor panel remounts on every tab switch; release the GL
    // context eagerly instead of waiting for GC, or browsers start
    // evicting "too many active WebGL contexts".
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  // ─── Bodies ────────────────────────────────────────────────────────────

  private ring(radius: number, tube: number, segments: number, opacity: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(radius, tube, 8, segments),
      new THREE.MeshBasicMaterial({
        color: STATUS_HEX.pool,
        transparent: true,
        opacity,
        depthWrite: false,
      })
    );
    m.rotation.x = Math.PI / 2;
    m.renderOrder = -2;
    return m;
  }

  private addBody(n: EcoNode): Body {
    const rand = seeded(n.id);
    const col = STATUS_HEX[n.status];
    const mat = new THREE.MeshBasicMaterial({ color: hot(col, 0.72), fog: false });
    const mesh = new THREE.Mesh(this.sphereGeo, mat);
    const size = sizeOf(n, this.L, this.tweaks.size);
    mesh.scale.setScalar(size);

    // Sprites are children of the body, so their scale is RELATIVE to it —
    // glowScale() keeps the halo readable even on the smallest stars.
    const bloom = new THREE.Sprite(spriteMat(this.texBloom, col, 0.7 * this.tweaks.glow));
    bloom.renderOrder = 2;
    mesh.add(bloom);
    const corona = new THREE.Sprite(spriteMat(this.texCorona, col, 0.28 * this.tweaks.glow));
    corona.renderOrder = 1;
    mesh.add(corona);

    const r = orbitR(n, this.L);
    const b: Body = {
      node: n,
      mesh,
      bloom,
      corona,
      size,
      r,
      targetR: r,
      incl: n.kind === "pool" ? 0.06 : (rand() - 0.5) * 0.95,
      ascending: rand() * Math.PI * 2,
      phase: rand() * Math.PI * 2,
      speed: (n.kind === "pool" ? 0.035 : 0.14) / Math.sqrt(r),
      tw: 0.6 + rand() * 1.9,
      tp: rand() * Math.PI * 2,
    };
    mesh.userData.id = n.id;
    this.bodies.set(n.id, b);
    this.nodeLayer.add(mesh);
    this.applyVisibility(b);
    this.place(b, this.timer.getElapsed());
    return b;
  }

  private removeBody(b: Body): void {
    this.bodies.delete(b.node.id);
    this.nodeLayer.remove(b.mesh);
    b.mesh.material.dispose();
    b.bloom.material.dispose();
    b.corona.material.dispose();
    for (let i = this.pings.length - 1; i >= 0; i--) {
      if (this.pings[i].body === b) this.removePing(i);
    }
    if (this.hovered === b) this.hovered = null;
    if (this.selected === b) this.setSelected(null);
  }

  private recolor(b: Body): void {
    const col = STATUS_HEX[b.node.status];
    b.mesh.material.color.copy(hot(col, 0.72));
    b.bloom.material.color.setHex(col);
    b.corona.material.color.setHex(col);
    this.applyVisibility(b);
  }

  private applyVisibility(b: Body): void {
    b.mesh.visible = !this.hidden.has(b.node.status);
  }

  private place(b: Body, t: number): void {
    b.r += (b.targetR - b.r) * 0.04;
    const a = b.phase + t * b.speed;
    const x = Math.cos(a) * b.r;
    const z = Math.sin(a) * b.r;
    const y = Math.sin(a) * Math.sin(b.incl) * b.r;
    const cs = Math.cos(b.ascending);
    const sn = Math.sin(b.ascending);
    b.mesh.position.set(x * cs - z * sn, y, x * sn + z * cs);
  }

  private flash(b: Body): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.13, 40),
      new THREE.MeshBasicMaterial({
        color: STATUS_HEX[b.node.status],
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this.scene.add(mesh);
    this.pings.push({ mesh, body: b, t: 0 });
  }

  private removePing(i: number): void {
    const p = this.pings[i];
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    this.pings.splice(i, 1);
  }

  private setSelected(b: Body | null): void {
    this.select(b ? b.node.id : null);
    this.handlers.onSelect(b ? b.node.id : null);
  }

  // ─── Input ─────────────────────────────────────────────────────────────

  private pick(e: PointerEvent | MouseEvent): Body | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ptr, this.camera);
    const hit = this.ray
      .intersectObjects(this.nodeLayer.children, false)
      .find((h) => h.object.visible);
    return hit ? this.bodies.get(hit.object.userData.id as string) ?? null : null;
  }

  private onPointerMove = (e: PointerEvent) => {
    const b = this.pick(e);
    if (b !== this.hovered) {
      this.hovered = b;
      this.renderer.domElement.style.cursor = b ? "pointer" : "";
    }
    this.handlers.onHover(b && b !== this.selected ? b.node.id : null, e.offsetX, e.offsetY);
  };

  private onPointerLeave = () => {
    this.hovered = null;
    this.handlers.onHover(null, 0, 0);
  };

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY };
  };

  private onClick = (e: MouseEvent) => {
    // An orbit drag also ends in a click — don't let it clear the selection.
    if (this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 5) {
      return;
    }
    this.setSelected(this.pick(e));
  };

  private onControlStart = () => {
    this.controls.autoRotate = false;
    clearTimeout(this.idleTimer);
  };

  private onControlEnd = () => {
    this.idleTimer = setTimeout(() => (this.controls.autoRotate = true), 6000);
  };

  private onVisibility = () => this.updateLoop();

  // ─── Loop ──────────────────────────────────────────────────────────────

  private updateLoop(): void {
    const shouldRun = !this.disposed && this.onScreen && !document.hidden;
    if (shouldRun && !this.raf) {
      // Resume from where we paused instead of fast-forwarding every orbit.
      this.timer.reset();
      this.raf = requestAnimationFrame(this.frame);
    } else if (!shouldRun && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private resize(): void {
    const w = this.mount.clientWidth;
    const h = this.mount.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    this.timer.update(now);
    const t = this.timer.getElapsed();
    const { bloom, corona } = this.tweaks;

    for (const b of this.bodies.values()) {
      this.place(b, t);
      const target = this.hovered === b || this.selected === b ? b.size * 1.6 : b.size;
      b.mesh.scale.lerp(this.tmpScale.setScalar(target), 0.15);
      // Twinkle: subtle independent breathing on each star's bloom.
      const tw = 1 + Math.sin(t * b.tw + b.tp) * 0.16;
      b.bloom.scale.setScalar(glowScale(b.size, bloom, BLOOM_FLOOR) * tw);
      b.corona.scale.setScalar(glowScale(b.size, corona, CORONA_FLOOR) * (1 + (tw - 1) * 0.45));
    }
    this.coreMesh.rotation.y = t * 0.06;
    this.coreBloom.scale.setScalar(4.2 + Math.sin(t * 1.4) * 0.25);
    this.coreGlow.scale.setScalar(13 + Math.sin(t * 0.9) * 0.7);
    this.shell.rotation.y = t * 0.012;

    if (this.selected) {
      this.selRing.visible = this.selected.mesh.visible;
      this.selRing.position.copy(this.selected.mesh.position);
      this.selRing.scale.setScalar(this.selected.size * 1.9);
      this.selRing.lookAt(this.camera.position);
      this.selRing.material.opacity = 0.55 + Math.sin(t * 3.2) * 0.3;
    }

    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.t += 0.022;
      p.mesh.position.copy(p.body.mesh.position);
      p.mesh.lookAt(this.camera.position);
      p.mesh.scale.setScalar(1 + p.t * 22);
      p.mesh.material.opacity = Math.max(0, 0.9 - p.t * 1.1);
      if (p.t > 0.85) this.removePing(i);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
