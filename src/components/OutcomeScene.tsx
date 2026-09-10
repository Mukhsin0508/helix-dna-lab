import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface OutcomeSceneProps {
  mode: "baseline" | "intervention";
  playing: boolean;
  resetKey: number;
  onReady?: () => void;
  onError?: (message: string) => void;
}

interface BloodCell {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  phase: number;
  speed: number;
  tumble: THREE.Vector3;
  orientation: THREE.Euler;
  stationary: boolean;
}

const TAU = Math.PI * 2;
const VESSEL_LENGTH = 27;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A closed, concave disc rather than a flattened sphere or torus. */
function redCellGeometry(): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  for (let index = 0; index <= 40; index += 1) {
    const angle = (index / 40) * Math.PI;
    const radius = Math.sin(angle);
    profile.push(
      new THREE.Vector2(radius, Math.cos(angle) * (0.135 + 0.49 * radius * radius)),
    );
  }
  const geometry = new THREE.LatheGeometry(profile, 48);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** A tapered crescent with a rounded membrane; an illustrative sickled morphology. */
function sickleCellGeometry(): THREE.BufferGeometry {
  const longitudinal = 42;
  const radial = 18;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index <= longitudinal; index += 1) {
    const t = index / longitudinal;
    const x = (t - 0.5) * 2.6;
    const y = Math.sin(t * Math.PI) * 0.98 - 0.39;
    const tangent = new THREE.Vector2(2.6, Math.PI * Math.cos(t * Math.PI) * 0.98).normalize();
    const width = Math.pow(Math.sin(t * Math.PI), 0.72) * 0.3;
    for (let ring = 0; ring <= radial; ring += 1) {
      const angle = (ring / radial) * TAU;
      const offset = Math.cos(angle) * width;
      positions.push(x - tangent.y * offset, y + tangent.x * offset, Math.sin(angle) * width * 0.68);
      uvs.push(t, ring / radial);
      if (index < longitudinal && ring < radial) {
        const a = index * (radial + 1) + ring;
        const b = a + radial + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function membraneTexture(): THREE.DataTexture {
  const size = 64;
  const random = seededRandom(843);
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const value = 117 + Math.floor(random() * 22);
    pixels.set([value, value, value, 255], index * 4);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.repeat.set(3, 2);
  texture.needsUpdate = true;
  return texture;
}

/** Visual mechanism comparison only. Speeds, shapes and cell counts are art direction, not a model. */
export default function OutcomeScene({ mode, playing, resetKey, onReady, onError }: OutcomeSceneProps) {
  const container = useRef<HTMLDivElement>(null);
  const playingRef = useRef(playing);
  const readyRef = useRef(onReady);
  const errorRef = useRef(onError);
  const [error, setError] = useState<string | null>(null);
  playingRef.current = playing;
  readyRef.current = onReady;
  errorRef.current = onError;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let intersectionObserver: IntersectionObserver | undefined;
    let animationFrame = 0;
    let visible = true;
    let needsRender = true;
    let sceneTime = 0;
    let previousTime = 0;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionPreference.matches;
    const scene = new THREE.Scene();
    const texture = membraneTexture();
    const geometrySet = new Set<THREE.BufferGeometry>();
    const materialSet = new Set<THREE.Material>();
    const fail = (message: string) => {
      if (disposed) return;
      cancelAnimationFrame(animationFrame);
      setError(message);
      errorRef.current?.(message);
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      fail("The 3D view paused because graphics resources became unavailable. Reload to reconnect.");
    };
    const updateMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
    };
    const cleanUp = () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      motionPreference.removeEventListener("change", updateMotionPreference);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      controls?.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          geometrySet.add(object.geometry);
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => materialSet.add(material));
        }
      });
      geometrySet.forEach((geometry) => geometry.dispose());
      materialSet.forEach((material) => material.dispose());
      texture.dispose();
      if (renderer) {
        renderer.domElement.removeEventListener("webglcontextlost", contextLost);
        renderer.dispose();
        renderer.domElement.remove();
      }
    };

    try {
      setError(null);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.setClearColor("#080c14", 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.touchAction = "none";
      renderer.domElement.setAttribute("aria-label", mode === "baseline"
        ? "Interactive illustration of sickled and disc-shaped red blood cells in a blood vessel. Drag to orbit; scroll to zoom."
        : "Interactive illustration of disc-shaped red blood cells after the fetal hemoglobin mechanism. Drag to orbit; scroll to zoom.");
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      host.appendChild(renderer.domElement);

      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 65);
      camera.position.set(2.1, 1.8, 15.6);
      camera.lookAt(0, 0, 0);
      scene.fog = new THREE.FogExp2("#080c14", 0.026);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.065;
      controls.enablePan = false;
      controls.minDistance = 8;
      controls.maxDistance = 25;
      controls.minPolarAngle = 0.45;
      controls.maxPolarAngle = Math.PI - 0.45;
      controls.rotateSpeed = 0.55;
      controls.zoomSpeed = 0.7;

      scene.add(new THREE.HemisphereLight("#b6cde0", "#220815", 1.12));
      const key = new THREE.DirectionalLight("#ffe3de", 3.4);
      key.position.set(-4, 7, 9);
      scene.add(key);
      const fill = new THREE.DirectionalLight("#83a8c8", 1.1);
      fill.position.set(6, -3, 5);
      scene.add(fill);
      const rim = new THREE.DirectionalLight("#ff425e", 3);
      rim.position.set(3, 3, -6);
      scene.add(rim);

      const disc = redCellGeometry();
      const sickle = sickleCellGeometry();
      geometrySet.add(disc);
      geometrySet.add(sickle);
      const materials = ["#a71938", "#be2441", "#9b1732"].map((color) => {
        const material = new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.4,
          metalness: 0.015,
          clearcoat: 0.2,
          clearcoatRoughness: 0.5,
          sheen: 0.25,
          sheenColor: new THREE.Color("#f17a89"),
          sheenRoughness: 0.75,
          bumpMap: texture,
          bumpScale: 0.015,
        });
        materialSet.add(material);
        return material;
      });

      const random = seededRandom(9047);
      const cells: BloodCell[] = [];
      for (let index = 0; index < 49; index += 1) {
        const isSickled = mode === "baseline" && index % 3 === 0;
        const stationary = mode === "baseline" && index < 9;
        const mesh = new THREE.Mesh(isSickled ? sickle : disc, materials[index % materials.length]);
        const x = stationary ? (random() - 0.5) * 3.4 + 0.4 : (random() - 0.5) * VESSEL_LENGTH;
        const angle = random() * TAU;
        const radius = Math.sqrt(random()) * (stationary ? 1.7 : 2.45);
        const origin = new THREE.Vector3(x, Math.sin(angle) * radius * 0.8, Math.cos(angle) * radius);
        const scale = 0.5 + random() * 0.24;
        mesh.scale.set(scale, scale * (0.9 + random() * 0.17), scale);
        const orientation = new THREE.Euler((random() - 0.5) * 1.4, (random() - 0.5) * 1.25, random() * TAU);
        mesh.rotation.copy(orientation);
        mesh.position.copy(origin);
        scene.add(mesh);
        cells.push({
          mesh,
          origin,
          phase: random() * TAU,
          speed: 0.52 + random() * 0.27,
          tumble: new THREE.Vector3((random() - 0.5) * 0.17, (random() - 0.5) * 0.17, (random() - 0.5) * 0.13),
          orientation,
          stationary,
        });
      }

      // Only the rear half is visible: a subtle spatial boundary, never an opaque tube over the cells.
      const vesselGeometry = new THREE.CylinderGeometry(3.45, 3.45, 34, 48, 1, true, Math.PI / 2, Math.PI);
      vesselGeometry.rotateZ(Math.PI / 2);
      vesselGeometry.scale(1, 0.84, 1);
      const vesselMaterial = new THREE.MeshBasicMaterial({ color: "#b94b65", transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false });
      const vessel = new THREE.Mesh(vesselGeometry, vesselMaterial);
      scene.add(vessel);

      const contourMaterial = new THREE.LineBasicMaterial({ color: "#875464", transparent: true, opacity: 0.19, depthWrite: false });
      for (let index = 0; index < 7; index += 1) {
        const angle = (index / 6) * Math.PI + Math.PI / 2;
        const points: THREE.Vector3[] = [];
        for (let step = 0; step <= 70; step += 1) {
          const x = (step / 70 - 0.5) * 34;
          points.push(new THREE.Vector3(x, Math.sin(angle) * 2.9 + Math.sin(x * 0.28 + angle) * 0.04, Math.cos(angle) * 3.45));
        }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), contourMaterial));
      }

      const motePositions = new Float32Array(125 * 3);
      for (let index = 0; index < 125; index += 1) {
        motePositions[index * 3] = (random() - 0.5) * 32;
        motePositions[index * 3 + 1] = (random() - 0.5) * 5;
        motePositions[index * 3 + 2] = (random() - 0.5) * 5;
      }
      const moteGeometry = new THREE.BufferGeometry();
      moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
      const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({ color: "#d597a2", size: 0.025, transparent: true, opacity: 0.32, depthWrite: false }));
      scene.add(motes);

      const resize = () => {
        if (disposed || !renderer) return;
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(host.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        needsRender = true;
      };
      resize();
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      intersectionObserver = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        needsRender = true;
      });
      intersectionObserver.observe(host);
      motionPreference.addEventListener("change", updateMotionPreference);

      const animate = (now: number) => {
        if (disposed || !renderer) return;
        const delta = previousTime === 0 ? 0 : Math.min((now - previousTime) / 1000, 0.045);
        previousTime = now;
        if (visible && !document.hidden) {
          const advancing = playingRef.current && !reducedMotion;
          if (advancing) sceneTime += delta;
          for (const cell of cells) {
            const travel = cell.stationary ? Math.sin(sceneTime * 0.22 + cell.phase) * 0.08 : sceneTime * cell.speed;
            cell.mesh.position.x = ((cell.origin.x + travel + VESSEL_LENGTH / 2) % VESSEL_LENGTH) - VESSEL_LENGTH / 2;
            cell.mesh.position.y = cell.origin.y + Math.sin(sceneTime * 0.2 + cell.phase) * 0.09;
            cell.mesh.position.z = cell.origin.z + Math.cos(sceneTime * 0.16 + cell.phase) * 0.08;
            const rotationTime = cell.stationary ? Math.sin(sceneTime * 0.3) * 0.4 : sceneTime;
            cell.mesh.rotation.set(
              cell.orientation.x + cell.tumble.x * rotationTime,
              cell.orientation.y + cell.tumble.y * rotationTime,
              cell.orientation.z + cell.tumble.z * rotationTime,
            );
          }
          motes.position.x = (sceneTime * 0.085) % 1.8;
          const cameraChanged = controls?.update() ?? false;
          if (advancing || cameraChanged || needsRender) {
            try {
              renderer.render(scene, camera);
              needsRender = false;
            } catch {
              fail("The 3D view could not render. The study results are still available.");
              return;
            }
          }
        }
        animationFrame = requestAnimationFrame(animate);
      };
      renderer.render(scene, camera);
      readyRef.current?.();
      animationFrame = requestAnimationFrame(animate);
    } catch {
      fail("3D is unavailable in this browser. The study results are still available.");
    }

    return cleanUp;
  }, [mode, resetKey]);

  return (
    <div ref={container} className="outcome-scene" style={{ position: "relative", width: "100%", height: "100%", minHeight: 260, overflow: "hidden", background: "#080c14" }}>
      {error && <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 32, color: "#a9b6c7", fontSize: 14, lineHeight: 1.6, textAlign: "center", background: "#080c14" }}>{error}</div>}
    </div>
  );
}
