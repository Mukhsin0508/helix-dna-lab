import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Base = "A" | "C" | "G" | "T";
type View = "cell" | "dna" | "rna";

export interface MolecularSceneProps {
  view: View;
  compare: boolean;
  progress: number;
  playing: boolean;
  selectedIndex: number;
  alternate: Base;
  sequence: string;
  onSelectBase: (index: number) => void;
  resetKey: number;
  onReady?: () => void;
  rnaHasEvidence?: boolean;
}

interface Atom {
  point: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  index: number;
}

interface Bond {
  from: THREE.Vector3;
  to: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  index: number;
}

interface Helix {
  group: THREE.Group;
  marker: THREE.Group;
  editAtom: THREE.Mesh;
  bead: THREE.Mesh;
  spine: THREE.CatmullRomCurve3;
  height: number;
  pitch: number;
  count: number;
  label: THREE.Sprite;
  baseLabel: THREE.Sprite;
}

const CYAN = new THREE.Color("#6ee7f0");
const ICE = new THREE.Color("#c5f3f7");
const AMBER = new THREE.Color("#ffbd68");
const UP = new THREE.Vector3(0, 1, 0);
const COMPLEMENT: Record<Base, Base> = { A: "T", T: "A", C: "G", G: "C" };
const TAU = Math.PI * 2;

function material(
  color: THREE.ColorRepresentation,
  emissive = 0.14,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.3,
    metalness: 0.28,
    emissive: color,
    emissiveIntensity: emissive,
  });
}

function lineTube(
  points: THREE.Vector3[],
  radius: number,
  mat: THREE.Material,
  smooth = true,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  return new THREE.Mesh(
    new THREE.TubeGeometry(
      curve,
      Math.max(24, points.length * (smooth ? 6 : 2)),
      radius,
      7,
      false,
    ),
    mat,
  );
}

/** Individual atoms and bonds retain their sequence index for pointer inspection. */
function addMolecules(group: THREE.Group, atoms: Atom[], bonds: Bond[]): void {
  // InstancedMesh supplies instance colors; enabling absent vertex colors would multiply them by black.
  const atomMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.32,
    metalness: 0.12,
    emissive: "#173f45",
    emissiveIntensity: 0.25,
  });
  const atomMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 12, 9),
    atomMaterial,
    atoms.length,
  );
  const transform = new THREE.Object3D();
  atoms.forEach((atom, index) => {
    transform.position.copy(atom.point);
    transform.quaternion.identity();
    transform.scale.setScalar(atom.radius);
    transform.updateMatrix();
    atomMesh.setMatrixAt(index, transform.matrix);
    atomMesh.setColorAt(index, atom.color);
  });
  atomMesh.userData.pickIndices = atoms.map((atom) => atom.index);
  atomMesh.instanceMatrix.needsUpdate = true;
  if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true;
  atomMesh.computeBoundingSphere();
  group.add(atomMesh);

  const bondMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(1, 1, 1, 7),
    atomMaterial.clone(),
    bonds.length,
  );
  const direction = new THREE.Vector3();
  bonds.forEach((bond, index) => {
    direction.subVectors(bond.to, bond.from);
    transform.position.copy(bond.from).add(bond.to).multiplyScalar(0.5);
    transform.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
    transform.scale.set(bond.radius, direction.length(), bond.radius);
    transform.updateMatrix();
    bondMesh.setMatrixAt(index, transform.matrix);
    bondMesh.setColorAt(index, bond.color);
  });
  bondMesh.userData.pickIndices = bonds.map((bond) => bond.index);
  bondMesh.instanceMatrix.needsUpdate = true;
  if (bondMesh.instanceColor) bondMesh.instanceColor.needsUpdate = true;
  bondMesh.computeBoundingSphere();
  group.add(bondMesh);
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.font = "500 35px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 256, 56);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      opacity: 0.86,
    }),
  );
  sprite.scale.set(3.1, 0.68, 1);
  sprite.renderOrder = 5;
  return sprite;
}

function setLabel(sprite: THREE.Sprite, text: string, color: string): void {
  const replacement = makeLabel(text, color);
  const originalMaterial = sprite.material;
  originalMaterial.map?.dispose();
  originalMaterial.dispose();
  sprite.material = replacement.material;
}

/** Molecular illustration: base-pair geometry is explanatory, not an atomic structure file. */
function buildHelix(sequence: string, edited: boolean): Helix {
  const group = new THREE.Group();
  const count = Math.max(2, sequence.length);
  const pitch = Math.min(0.285, 13 / count);
  const height = (count - 1) * pitch;
  const radius = 1.16;
  const atoms: Atom[] = [];
  const bonds: Bond[] = [];
  const rails: THREE.Vector3[][] = [[], []];
  const theme = edited ? AMBER : CYAN;
  const pale = edited ? new THREE.Color("#ffe5c1") : ICE;
  for (let index = 0; index < count; index += 1) {
    const angle = (index * TAU) / 10.5;
    const y = index * pitch - height / 2;
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const ends = [
      radial.clone().multiplyScalar(radius),
      radial.clone().multiplyScalar(-radius),
    ];
    ends.forEach((end, side) => {
      end.y = y;
      rails[side].push(end);
      atoms.push({ point: end.clone(), radius: 0.135, color: theme, index });
      const sugar = end.clone().multiplyScalar(0.89);
      sugar.y = y + 0.025;
      atoms.push({ point: sugar, radius: 0.092, color: pale, index });
      bonds.push({ from: end, to: sugar, radius: 0.048, color: pale, index });
      const ringCenter = radial.clone().multiplyScalar(side ? -0.43 : 0.43);
      ringCenter.y = y;
      const ring: THREE.Vector3[] = [];
      for (let vertex = 0; vertex < 6; vertex += 1) {
        const theta = (TAU * vertex) / 6;
        const point = ringCenter
          .clone()
          .addScaledVector(radial, Math.cos(theta) * 0.22)
          .addScaledVector(tangent, Math.sin(theta) * 0.2);
        ring.push(point);
        atoms.push({
          point,
          radius: vertex % 3 === 0 ? 0.066 : 0.048,
          color: vertex % 3 === 0 ? pale : theme,
          index,
        });
      }
      ring.forEach((point, vertex) =>
        bonds.push({
          from: point,
          to: ring[(vertex + 1) % ring.length],
          radius: 0.029,
          color: theme,
          index,
        }),
      );
      bonds.push({
        from: sugar,
        to: ringCenter.clone().addScaledVector(radial, side ? -0.22 : 0.22),
        radius: 0.033,
        color: pale,
        index,
      });
    });
    const base = (sequence[index] || "A") as Base;
    const hydrogenCount = base === "G" || base === "C" ? 3 : 2;
    for (let bridge = 0; bridge < hydrogenCount; bridge += 1) {
      const offset = (bridge - (hydrogenCount - 1) / 2) * 0.085;
      const center = tangent.clone().multiplyScalar(offset);
      center.y = y;
      bonds.push({
        from: center.clone().addScaledVector(radial, -0.19),
        to: center.clone().addScaledVector(radial, 0.19),
        radius: 0.022,
        color: pale,
        index,
      });
    }
  }
  addMolecules(group, atoms, bonds);
  rails.forEach((rail, side) => {
    group.add(
      lineTube(rail, side ? 0.052 : 0.065, material(side ? pale : theme, 0.22)),
    );
    group.add(
      lineTube(
        rail,
        0.105,
        new THREE.MeshBasicMaterial({
          color: theme,
          transparent: true,
          opacity: 0.055,
          depthWrite: false,
        }),
      ),
    );
  });
  const marker = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.47, 0.025, 8, 100),
    new THREE.MeshBasicMaterial({
      color: edited ? "#ffd18a" : "#b3ffff",
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  marker.add(ring);
  const inner = new THREE.Mesh(
    new THREE.TorusGeometry(1.57, 0.008, 5, 100),
    new THREE.MeshBasicMaterial({
      color: theme,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
  );
  inner.rotation.x = Math.PI / 2;
  marker.add(inner);
  const editAtom = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 18, 12),
    material(edited ? "#ffe1aa" : "#dbffff", 0.8),
  );
  marker.add(editAtom);
  const baseLabel = makeLabel("A · T", edited ? "#ffce8b" : "#c5f5ff");
  baseLabel.position.set(1.95, 0.02, 0);
  baseLabel.scale.set(2.8, 0.61, 1);
  marker.add(baseLabel);
  group.add(marker);
  const bead = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    new THREE.MeshBasicMaterial({ color: edited ? "#fff0d2" : "#edffff" }),
  );
  group.add(bead);
  const label = makeLabel(
    edited ? "EDITED COPY" : "REFERENCE",
    edited ? "#e8b974" : "#85b9c6",
  );
  label.position.set(0, -height / 2 - 0.72, 0);
  label.visible = false;
  group.add(label);
  return {
    group,
    marker,
    editAtom,
    bead,
    spine: new THREE.CatmullRomCurve3(rails[0]),
    height,
    pitch,
    count,
    label,
    baseLabel,
  };
}

function makeCell(sequence: string): THREE.Group {
  const group = new THREE.Group();
  const membrane = new THREE.Mesh(
    new THREE.SphereGeometry(4.85, 64, 40),
    new THREE.MeshPhysicalMaterial({
      color: "#429898",
      transparent: true,
      opacity: 0.055,
      roughness: 0.22,
      metalness: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  membrane.scale.set(1.08, 0.94, 0.88);
  group.add(membrane);
  const nucleus = new THREE.Mesh(
    new THREE.SphereGeometry(2.7, 56, 36),
    new THREE.MeshPhysicalMaterial({
      color: "#609ead",
      transparent: true,
      opacity: 0.1,
      roughness: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(nucleus);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: "#65a1aa",
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  });
  for (let ringIndex = 0; ringIndex < 3; ringIndex += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.7, 0.012, 5, 160),
      ringMaterial,
    );
    ring.rotation.set(0.35 + ringIndex * 0.8, ringIndex * 0.55, 0);
    ring.scale.set(1.08, 0.94, 1);
    group.add(ring);
  }
  const dna = buildHelix(sequence.slice(0, 36), false);
  dna.group.scale.setScalar(0.44);
  dna.group.rotation.z = -0.42;
  dna.marker.visible = false;
  dna.label.visible = false;
  group.add(dna.group);
  const mitochondria = material("#b4825b", 0.07);
  for (let index = 0; index < 13; index += 1) {
    const angle = index * 2.39996;
    const y = (index / 12 - 0.5) * 5.7;
    const rad = Math.sqrt(Math.max(0.1, 4.0 ** 2 - y ** 2));
    const organelle = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.13, 0.48, 4, 10),
      mitochondria,
    );
    organelle.position.set(Math.cos(angle) * rad, y, Math.sin(angle) * rad);
    organelle.rotation.set(angle, angle * 0.5, angle * 0.8);
    group.add(organelle);
  }
  const label = makeLabel("CELL  /  NUCLEUS  /  DNA", "#7fb3bd");
  label.scale.set(4.6, 1, 1);
  label.position.y = -5.5;
  group.add(label);
  return group;
}

interface RnaScene {
  group: THREE.Group;
  edited: THREE.Group;
  extension: THREE.Group;
  extraLabel: THREE.Sprite;
  bridge: THREE.Mesh;
  label: THREE.Sprite;
  signal: THREE.Mesh;
  path: THREE.CatmullRomCurve3;
}

function makeRna(): RnaScene {
  const group = new THREE.Group();
  const edited = new THREE.Group();
  const extension = new THREE.Group();
  let editedLabel: THREE.Sprite | undefined;
  const paths: THREE.Vector3[][] = [];
  [false, true].forEach((isEdited) => {
    const chain = new THREE.Group();
    const points: THREE.Vector3[] = [];
    const atoms: Atom[] = [];
    const bonds: Bond[] = [];
    const theme = isEdited ? AMBER : CYAN;
    for (let index = 0; index < 54; index += 1) {
      const x = (index - 26.5) * 0.205;
      const amplitude = THREE.MathUtils.clamp((Math.abs(x) - 1.8) / 1.5, 0, 1);
      const point = new THREE.Vector3(
        x,
        Math.sin(index * 0.37) * 0.2 * amplitude,
        Math.cos(index * 0.37) * 0.33 * amplitude,
      );
      points.push(point);
      atoms.push({ point, radius: 0.09, color: theme, index: -1 });
      const base = point
        .clone()
        .add(new THREE.Vector3(0, 0.31 + Math.sin(index) * 0.025, 0));
      atoms.push({
        point: base,
        radius: 0.065,
        color: isEdited ? new THREE.Color("#ffe1b7") : ICE,
        index: -1,
      });
      bonds.push({
        from: point,
        to: base,
        radius: 0.026,
        color: theme,
        index: -1,
      });
    }
    addMolecules(chain, atoms, bonds);
    if (isEdited) {
      chain.add(lineTube(points.slice(0, 27), 0.036, material(theme, 0.2)));
      chain.add(lineTube(points.slice(27), 0.036, material(theme, 0.2)));
    } else chain.add(lineTube(points, 0.036, material(theme, 0.2)));
    const label = makeLabel(
      isEdited ? "EDITED TRANSCRIPT" : "REFERENCE TRANSCRIPT",
      isEdited ? "#e8b974" : "#85b9c6",
    );
    label.position.set(-3.65, -0.85, 0);
    chain.add(label);
    paths.push(points);
    if (isEdited) {
      editedLabel = label;
      edited.add(chain);
      edited.position.y = -2.2;
      group.add(edited);
    } else {
      chain.position.y = 2.0;
      group.add(chain);
    }
  });
  const retained: THREE.Vector3[] = [];
  const retainedAtoms: Atom[] = [];
  const retainedBonds: Bond[] = [];
  for (let index = 0; index < 39; index += 1) {
    const t = index / 38;
    const point = new THREE.Vector3(
      -0.1025 + t * 0.205 + Math.sin(t * TAU) * 1.75,
      Math.sin(t * Math.PI) * 2.35,
      Math.sin(t * TAU) * 0.24,
    );
    retained.push(point);
    retainedAtoms.push({ point, radius: 0.075, color: AMBER, index: -1 });
    const base = point.clone().add(new THREE.Vector3(0.045, 0.22, 0));
    retainedAtoms.push({
      point: base,
      radius: 0.042,
      color: new THREE.Color("#ffe3ac"),
      index: -1,
    });
    retainedBonds.push({
      from: point,
      to: base,
      radius: 0.02,
      color: AMBER,
      index: -1,
    });
  }
  addMolecules(extension, retainedAtoms, retainedBonds);
  extension.add(lineTube(retained, 0.035, material("#edaa56", 0.22)));
  const extraLabel = makeLabel("+39 nt  ·  ILLUSTRATIVE", "#dfb572");
  extraLabel.position.set(0, 3.05, 0);
  edited.add(extraLabel);
  edited.add(extension);
  const bridge = lineTube(
    [new THREE.Vector3(-0.1025, 0, 0), new THREE.Vector3(0.1025, 0, 0)],
    0.036,
    material(AMBER, 0.2),
  );
  edited.add(bridge);
  const signal = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 14, 10),
    material("#fff4d9", 0.75),
  );
  edited.add(signal);
  group.rotation.set(-0.12, 0, -0.1);
  return {
    group,
    edited,
    extension,
    extraLabel,
    bridge,
    label: editedLabel!,
    signal,
    path: new THREE.CatmullRomCurve3([
      ...paths[1].slice(0, 27),
      ...retained,
      ...paths[1].slice(27),
    ]),
  };
}

function disposeScene(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Points ||
      object instanceof THREE.Sprite
    ) {
      if ("geometry" in object) geometries.add(object.geometry);
      const list = Array.isArray(object.material)
        ? object.material
        : [object.material];
      list.forEach((mat) => {
        materials.add(mat);
        const mapped = mat as THREE.Material & { map?: THREE.Texture | null };
        if (mapped.map) textures.add(mapped.map);
      });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((mat) => mat.dispose());
  textures.forEach((texture) => texture.dispose());
}

export default function MolecularScene(props: MolecularSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      container.textContent =
        "This 3D view requires WebGL. Try a browser with hardware acceleration enabled.";
      return;
    }
    renderer.setClearColor("#050a0e");
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;
    renderer.domElement.style.cssText =
      "display:block;width:100%;height:100%;touch-action:none;outline:none";
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive molecular illustration. Drag to rotate, scroll or pinch to zoom, and select a DNA base.",
    );
    renderer.domElement.setAttribute("role", "img");
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#050a0e", 0.012);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 140);
    camera.position.set(0, 0.8, 23);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.minDistance = 3.0;
    controls.maxDistance = 44;
    controls.enablePan = true;
    controls.autoRotateSpeed = 0.35;
    scene.add(new THREE.HemisphereLight("#c6eaf1", "#101723", 2.2));
    const key = new THREE.DirectionalLight("#dcf9ff", 3.6);
    key.position.set(4, 7, 9);
    scene.add(key);
    const rim = new THREE.DirectionalLight("#408caa", 3.2);
    rim.position.set(-5, 1, -6);
    scene.add(rim);
    const warm = new THREE.DirectionalLight("#ffc58f", 1.8);
    warm.position.set(7, -3, 2);
    scene.add(warm);

    const sequence =
      props.sequence.toUpperCase().replace(/[^ACGT]/g, "") || "ACGT".repeat(12);
    const reference = buildHelix(sequence, false);
    const alternate = buildHelix(sequence, true);
    const dna = new THREE.Group();
    dna.rotation.set(-0.07, 0.1, -0.18);
    dna.add(reference.group, alternate.group);
    scene.add(dna);
    const cell = makeCell(sequence);
    scene.add(cell);
    const rna = makeRna();
    scene.add(rna.group);
    (
      [
        [dna, "dna"],
        [cell, "cell"],
        [rna.group, "rna"],
      ] as [THREE.Group, View][]
    ).forEach(([group, view]) => {
      group.scale.setScalar(current.current.view === view ? 1 : 0.001);
      group.visible = current.current.view === view;
    });
    reference.group.position.x = current.current.compare ? -2.75 : 0;
    alternate.group.position.x = 2.75;
    alternate.group.scale.setScalar(current.current.compare ? 1 : 0.001);
    alternate.group.visible = current.current.compare;

    const stars = new Float32Array(180 * 3);
    let seed = 9281;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let index = 0; index < stars.length; index += 3) {
      stars[index] = (random() - 0.5) * 44;
      stars[index + 1] = (random() - 0.5) * 32;
      stars[index + 2] = -8 - random() * 18;
    }
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    scene.add(
      new THREE.Points(
        starsGeometry,
        new THREE.PointsMaterial({
          color: "#6a98a4",
          size: 0.033,
          transparent: true,
          opacity: 0.34,
          depthWrite: false,
        }),
      ),
    );

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motion.matches;
    const onMotion = () => {
      reducedMotion = motion.matches;
    };
    motion.addEventListener("change", onMotion);
    let width = 1;
    let height = 1;
    let lastView: View | null = null;
    let lastCompare: boolean | null = null;
    let lastReset = -1;
    let transition = true;
    const desiredPosition = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3();
    const fitCamera = () => {
      const state = current.current;
      const extentY =
        state.view === "dna"
          ? Math.max(14.4, reference.height + 3.2)
          : state.view === "cell"
            ? 12.7
            : 10.2;
      const extentX =
        state.view === "rna"
          ? 13.4
          : state.view === "cell"
            ? 12
            : state.compare
              ? 10.2
              : 5.2;
      const distance =
        Math.max(extentY, extentX / camera.aspect) /
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      desiredPosition.set(state.view === "cell" ? 1.8 : 0, 0.6, distance);
      desiredTarget.set(0, 0, 0);
      transition = true;
    };
    const resize = () => {
      const bounds = container.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      fitCamera();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    camera.position.copy(desiredPosition);
    const onControlStart = () => {
      transition = false;
    };
    controls.addEventListener("start", onControlStart);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (
        current.current.view !== "dna" ||
        Math.hypot(event.clientX - downX, event.clientY - downY) > 6
      )
        return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / width) * 2 - 1,
        (-(event.clientY - bounds.top) / height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      for (const hit of raycaster.intersectObjects(
        [
          reference.group,
          ...(current.current.compare ? [alternate.group] : []),
        ],
        true,
      )) {
        const indices = hit.object.userData.pickIndices as number[] | undefined;
        if (indices && hit.instanceId !== undefined) {
          const index = indices[hit.instanceId];
          if (index >= 0 && index < sequence.length) {
            current.current.onSelectBase(index);
            break;
          }
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    let frame = 0;
    let previousTime = performance.now();
    let elapsed = 0;
    let ready = false;
    let selected = -1;
    let selectedBase: Base | null = null;
    let lastRnaEvidence: boolean | null = null;
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const state = current.current;
      const delta = Math.min((now - previousTime) / 1000, 0.06);
      previousTime = now;
      if (state.playing && !reducedMotion) elapsed += delta;
      const blend = reducedMotion ? 1 : 1 - Math.exp(-delta * 6);
      if (
        lastView !== state.view ||
        lastCompare !== state.compare ||
        lastReset !== state.resetKey
      ) {
        lastView = state.view;
        lastCompare = state.compare;
        lastReset = state.resetKey;
        fitCamera();
      }
      if (transition) {
        camera.position.lerp(desiredPosition, blend);
        controls.target.lerp(desiredTarget, blend);
        if (camera.position.distanceTo(desiredPosition) < 0.015)
          transition = false;
      }
      controls.autoRotate = state.playing && !reducedMotion && !transition;
      controls.update(delta);
      const stageGroups: [THREE.Group, View][] = [
        [dna, "dna"],
        [cell, "cell"],
        [rna.group, "rna"],
      ];
      stageGroups.forEach(([group, view]) => {
        const target = view === state.view ? 1 : 0.001;
        const scale = THREE.MathUtils.lerp(group.scale.x, target, blend);
        group.scale.setScalar(scale);
        group.visible = scale > 0.015;
      });
      const compareTarget = state.compare ? 1 : 0.001;
      alternate.group.scale.setScalar(
        THREE.MathUtils.lerp(alternate.group.scale.x, compareTarget, blend),
      );
      alternate.group.visible = alternate.group.scale.x > 0.02;
      reference.group.position.x = THREE.MathUtils.lerp(
        reference.group.position.x,
        state.compare ? -2.75 : 0,
        blend,
      );
      alternate.group.position.x = THREE.MathUtils.lerp(
        alternate.group.position.x,
        2.75,
        blend,
      );
      const index = THREE.MathUtils.clamp(
        state.selectedIndex,
        0,
        sequence.length - 1,
      );
      if (index !== selected || selectedBase !== state.alternate) {
        selected = index;
        selectedBase = state.alternate;
        [reference, alternate].forEach((model) => {
          model.marker.position.y = index * model.pitch - model.height / 2;
          model.editAtom.position.set(
            Math.cos((index * TAU) / 10.5) * 1.16,
            0,
            Math.sin((index * TAU) / 10.5) * 1.16,
          );
        });
        const base = sequence[index] as Base;
        reference.group.userData.selectedPair = `${base}–${COMPLEMENT[base]}`;
        alternate.group.userData.selectedPair = `${state.alternate}–${COMPLEMENT[state.alternate]}`;
        setLabel(
          reference.baseLabel,
          `${base} · ${COMPLEMENT[base]}`,
          "#c5f5ff",
        );
        setLabel(
          alternate.baseLabel,
          `${state.alternate} · ${COMPLEMENT[state.alternate]}`,
          "#ffce8b",
        );
        (alternate.editAtom.material as THREE.MeshStandardMaterial).color.set(
          state.alternate === base ? "#bdf5f5" : "#ffd392",
        );
      }
      const progress = THREE.MathUtils.clamp(state.progress, 0, 1);
      [reference, alternate].forEach((model, indexOffset) => {
        model.bead.position.copy(
          model.spine.getPointAt((progress * 0.93 + indexOffset * 0.04) % 1),
        );
        model.marker.scale.setScalar(
          1 +
            (!reducedMotion && state.playing
              ? Math.sin(elapsed * 2.3) * 0.035
              : 0),
        );
      });
      const retention = THREE.MathUtils.smoothstep(progress, 0.24, 0.78);
      rna.extension.scale.y = Math.max(0.025, retention);
      const hasRnaEvidence = state.rnaHasEvidence === true;
      rna.extension.visible =
        state.compare && hasRnaEvidence && retention > 0.02;
      rna.extraLabel.visible = rna.extension.visible;
      rna.extraLabel.position.y = 0.7 + retention * 2.35;
      rna.bridge.visible = !rna.extension.visible;
      rna.edited.visible = state.compare;
      rna.signal.visible = hasRnaEvidence;
      if (lastRnaEvidence !== hasRnaEvidence) {
        lastRnaEvidence = hasRnaEvidence;
        setLabel(
          rna.label,
          hasRnaEvidence ? "EDITED TRANSCRIPT" : "RNA EFFECT UNKNOWN",
          "#e8b974",
        );
      }
      rna.signal.position.copy(rna.path.getPointAt(progress * 0.999));
      if (Math.abs(rna.signal.position.x) < 1.75)
        rna.signal.position.y *= Math.max(0.025, retention);
      if (state.view === "cell" && !reducedMotion)
        cell.rotation.y = Math.sin(elapsed * 0.13) * 0.06;
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        current.current.onReady?.();
      }
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
      controls.removeEventListener("start", onControlStart);
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      disposeScene(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [props.sequence]);

  return (
    <div
      ref={host}
      style={{ width: "100%", height: "100%", position: "absolute", inset: 0 }}
    />
  );
}
