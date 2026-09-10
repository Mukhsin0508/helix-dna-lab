import * as THREE from "three";

export interface CellEnvironment {
  group: THREE.Group;
  animate: (time: number) => void;
  setNativeAnatomy: (model: THREE.Object3D) => void;
}

function filament(
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points),
      Math.max(32, points.length * 5),
      radius,
      7,
      false,
    ),
    material,
  );
}

/** A spatial teaching illustration; organelle forms and distances are not to scale. */
export function createCellEnvironment(dna: THREE.Group): CellEnvironment {
  const group = new THREE.Group();
  const moving: Array<{ object: THREE.Object3D; phase: number; y: number }> =
    [];
  let seed = 1831;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pearl = new THREE.MeshStandardMaterial({
    color: "#c4e8df",
    roughness: 0.33,
    metalness: 0.13,
    emissive: "#18423f",
    emissiveIntensity: 0.2,
  });
  const teal = new THREE.MeshStandardMaterial({
    color: "#347f87",
    roughness: 0.32,
    metalness: 0.2,
    emissive: "#1b535b",
    emissiveIntensity: 0.3,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: "#d8a169",
    roughness: 0.38,
    metalness: 0.12,
    emissive: "#684021",
    emissiveIntensity: 0.16,
  });
  const shellMaterial = (color: string, opacity: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        tint: { value: new THREE.Color(color) },
        strength: { value: opacity },
      },
      vertexShader: `varying vec3 vNormal; varying vec3 vView;
      void main(){vec4 p=modelViewMatrix*vec4(position,1.);vNormal=normalize(normalMatrix*normal);vView=-p.xyz;gl_Position=projectionMatrix*p;}`,
      fragmentShader: `uniform vec3 tint; uniform float strength; varying vec3 vNormal; varying vec3 vView;
      void main(){vec3 n=normalize(vNormal);float edge=pow(1.-abs(dot(n,normalize(vView))),2.7);
      float light=.48+.52*max(dot(n,normalize(vec3(.4,.8,.6))),0.);
      gl_FragColor=vec4(tint*(.6+edge*.85)*light,(.025+edge*.65)*strength);}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  const surface = new THREE.SphereGeometry(4.9, 72, 48);
  const vertices = surface.getAttribute("position");
  for (let i = 0; i < vertices.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(vertices, i);
    const roughness =
      1 +
      0.018 * Math.sin(p.x * 1.8 + p.z) * Math.cos(p.y * 2.1) +
      0.009 * Math.sin(p.z * 4 + p.y);
    p.multiplyScalar(roughness);
    vertices.setXYZ(i, p.x, p.y, p.z);
  }
  surface.computeVertexNormals();
  const membrane = new THREE.Mesh(surface, shellMaterial("#91d5ca", 0.68));
  membrane.scale.set(1.09, 0.91, 0.9);
  group.add(membrane);
  const innerMembrane = new THREE.Mesh(surface, shellMaterial("#358286", 0.3));
  innerMembrane.scale.copy(membrane.scale).multiplyScalar(0.973);
  group.add(innerMembrane);

  // Small membrane proteins make the surface read as a volume when the camera moves.
  const poreGeometry = new THREE.TorusGeometry(0.11, 0.026, 6, 14);
  const normal = new THREE.Vector3();
  for (let i = 0; i < 75; i++) {
    const y = 1 - (2 * (i + 0.5)) / 75;
    const angle = i * 2.399963;
    normal.set(
      Math.cos(angle) * Math.sqrt(1 - y * y),
      y,
      Math.sin(angle) * Math.sqrt(1 - y * y),
    );
    const pore = new THREE.Mesh(poreGeometry, teal);
    pore.position.copy(normal).multiplyScalar(4.91).multiply(membrane.scale);
    pore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    pore.scale.setScalar(0.75 + random() * 0.6);
    group.add(pore);
  }
  const nucleus = new THREE.Group();
  nucleus.position.set(-0.35, 0.3, 0);
  nucleus.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 56, 40),
      shellMaterial("#9ecfe0", 0.92),
    ),
  );
  const nuclearInner = new THREE.Mesh(
    new THREE.SphereGeometry(2.43, 48, 32),
    new THREE.MeshPhysicalMaterial({
      color: "#315d79",
      roughness: 0.34,
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
    }),
  );
  nucleus.add(nuclearInner);
  const nuclearPoreGeometry = new THREE.TorusGeometry(0.14, 0.035, 8, 18);
  for (let i = 0; i < 18; i++) {
    const y = 1 - (2 * (i + 0.5)) / 18;
    const angle = i * 2.399963;
    normal.set(
      Math.cos(angle) * Math.sqrt(1 - y * y),
      y,
      Math.sin(angle) * Math.sqrt(1 - y * y),
    );
    const pore = new THREE.Mesh(nuclearPoreGeometry, pearl);
    pore.position.copy(normal).multiplyScalar(2.49);
    pore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    nucleus.add(pore);
  }
  dna.scale.setScalar(0.36);
  dna.rotation.set(0.12, 0.35, -0.38);
  nucleus.add(dna);
  const chromatinMaterial = new THREE.MeshStandardMaterial({
    color: "#5d94a2",
    roughness: 0.52,
    transparent: true,
    opacity: 0.5,
    emissive: "#173442",
    emissiveIntensity: 0.2,
  });
  for (let strand = 0; strand < 7; strand++) {
    const points: THREE.Vector3[] = [];
    for (let step = 0; step < 80; step++) {
      const t = (step / 79) * Math.PI * 2;
      const radial = 1.4 + 0.32 * Math.sin(t * 3 + strand);
      points.push(
        new THREE.Vector3(
          Math.cos(t + strand) * radial,
          Math.sin(t * 2 + strand) * 0.75,
          Math.sin(t + strand) * radial,
        ),
      );
    }
    const fiber = filament(points, 0.025, chromatinMaterial);
    fiber.rotation.set(strand * 0.35, strand * 0.5, strand * 0.25);
    nucleus.add(fiber);
  }
  group.add(nucleus);

  const organelleShell = new THREE.MeshPhysicalMaterial({
    color: "#cba06a",
    roughness: 0.3,
    metalness: 0.05,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  for (let i = 0; i < 10; i++) {
    const organelle = new THREE.Group();
    const casing = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.26, 0.65, 6, 16),
      organelleShell,
    );
    organelle.add(casing);
    const folds: THREE.Vector3[] = [];
    for (let k = 0; k < 40; k++) {
      const t = k / 39;
      folds.push(
        new THREE.Vector3(
          Math.sin(t * Math.PI * 10) * 0.18,
          (t - 0.5) * 0.85,
          Math.cos(t * Math.PI * 10) * 0.1,
        ),
      );
    }
    organelle.add(filament(folds, 0.042, gold));
    const angle = i * 2.399963;
    const y = (random() - 0.5) * 5.2;
    const radius = Math.sqrt(Math.max(1, 3.65 ** 2 - y ** 2));
    organelle.position.set(
      Math.cos(angle) * radius,
      y,
      Math.sin(angle) * radius * 0.78,
    );
    organelle.rotation.set(random() * 2, angle, random() * 2);
    group.add(organelle);
    moving.push({ object: organelle, phase: random() * 6, y });
  }

  // Folded membrane stacks and attached granules provide depth around the nucleus.
  for (let layer = 0; layer < 6; layer++) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 38; i++) {
      const t = (i / 37) * Math.PI * 1.5;
      points.push(
        new THREE.Vector3(
          2.55 + Math.cos(t) * (0.8 + layer * 0.035),
          -1.35 + layer * 0.17 + Math.sin(t * 3) * 0.07,
          Math.sin(t) * 0.7 - 0.4,
        ),
      );
    }
    group.add(filament(points, 0.07, teal));
  }
  const particleGeometry = new THREE.IcosahedronGeometry(1, 1);
  const particles = new THREE.InstancedMesh(particleGeometry, pearl, 220);
  const transform = new THREE.Object3D();
  for (let i = 0; i < 220; i++) {
    const y = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radius = 2.65 + random() * 1.65;
    transform.position.set(
      Math.cos(angle) * Math.sqrt(1 - y * y) * radius,
      y * radius,
      Math.sin(angle) * Math.sqrt(1 - y * y) * radius * 0.8,
    );
    transform.scale.setScalar(0.017 + random() * 0.043);
    transform.updateMatrix();
    particles.setMatrixAt(i, transform.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  group.add(particles);
  return {
    group,
    setNativeAnatomy(model) {
      const tuned = new Set<THREE.Material>();
      model.traverse((object) => {
        if (object instanceof THREE.Light) object.visible = false;
        if (!(object instanceof THREE.Mesh)) return;
        object.receiveShadow = /Membrane|Nucleus/.test(object.name);
        object.castShadow = !/Membrane|outer membrane/.test(object.name);
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          if (
            !(material instanceof THREE.MeshStandardMaterial) ||
            tuned.has(material)
          )
            continue;
          tuned.add(material);
          const name = material.name;
          material.emissiveIntensity *= 0.55;
          if (name.startsWith("Membrane")) {
            material.color.set(name.includes("rim") ? "#70b5b6" : "#173c44");
            material.roughness = 0.48;
            material.metalness = 0.06;
          } else if (name.startsWith("Mitochondria")) {
            material.color.set("#ba9263");
            material.transparent = true;
            material.opacity = 0.28;
            material.depthWrite = false;
            material.roughness = 0.45;
          } else if (name.startsWith("Cristae")) {
            material.color.set("#c8b795");
          } else if (name.startsWith("Nucleus") && !name.includes("edge")) {
            material.color.set("#80603e");
            material.roughness = 0.4;
          } else if (name.startsWith("Chromatin")) {
            material.color.set("#ceb285");
          }
        }
      });
      for (const child of group.children) child.visible = child === particles;
      dna.removeFromParent();
      dna.position.set(-0.6, 0.15, 0.2);
      dna.visible = true;
      group.add(model, dna);
    },
    animate(time) {
      particles.rotation.y = time * 0.014;
      nucleus.rotation.y = Math.sin(time * 0.15) * 0.025;
      for (const item of moving) {
        item.object.position.y =
          item.y + Math.sin(time * 0.28 + item.phase) * 0.08;
        item.object.rotation.z = Math.sin(time * 0.14 + item.phase) * 0.12;
      }
    },
  };
}
