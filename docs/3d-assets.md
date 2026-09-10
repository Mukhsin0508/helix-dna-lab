# Helix cell interior

The cell interior is an original native Blender scene authored through Higgsfield 3D Jutsu MCP. It is a stylized educational illustration, not measured cell anatomy or an AlphaGenome prediction. Its dimensions and organelle arrangement are artistic; this asset does not represent a specific cell type.

## Editable source and delivery

- Private project: [Helix — Cell Interior](https://higgsfield.ai/3d-jutsu/206f98f8-bff7-4b91-b3de-603ffdb572d2), committed revision **1**, Blender **5.2.0 LTS**.
- Browser model: `public/models/helix-cell-interior.glb` — **1,801,628 bytes**.
- Editable scene: `public/models/helix-cell-interior.blend` — **2,904,103 bytes**.
- Authoring script: `public/models/helix-cell-interior.py` — the original bpy code submitted to the service.
- Native render: `public/models/helix-cell-interior-preview.png` — **1000 × 750**, rendered from committed revision 1 with EEVEE.
- Checksums and provenance: `public/models/helix-cell-interior.provenance.json`.

The GLB is self-contained: no external buffers, textures, or image dependencies. It contains **118 unique meshes**, **222 nodes**, **14 materials**, and **90,416 unique-mesh triangles**. Shared ribosome meshes reuse geometry. Curve geometry is converted for glTF export. Materials use portable Principled shading; four lights use `KHR_lights_punctual`.

## Browser placement

The exported model is Y-up and its open cutaway faces **+Z**. Approximate bounds are X −6…6, Y −4.8…4.8, Z −4.8…2. Units use glTF meter conventions for consistent rendering, not literal biological scale. The nucleus is centered at **(−0.6, 0.15, 0.2)** with approximate radius **2.05**. The lab places its interactive DNA at this center and applies no model scale correction.

Native render camera, expressed in glTF coordinates: **(8.7, 8.2, 18)** looking at the origin, orthographic scale **14.4**. The browser chooses its own interactive camera.

Semantic node names identify Membrane, Nucleus, Chromatin, Mitochondrion, ER, Golgi, Vesicle, and Ribosome geometry. The GLB contains **no animation**; the lab supplies interactive DNA and particle animation independently. Its renderer can retune cyan, amber, and pearl materials without changing the delivered geometry.

## Verification

Binary validation checked the glTF version, declared byte length, self-contained resources, and geometry counts. The native EEVEE preview was inspected: the complete cell fits the frame, the nuclear cutaway remains visible, and there are no missing textures or added text. The renderer agent independently confirmed that this exact GLB loads and visibly renders in Three.js, with the nucleus placement aligned and no loader/runtime errors. Browser palette adjustments are separate from the committed native source.
