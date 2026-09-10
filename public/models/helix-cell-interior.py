"""Original educational cutaway cell, authored through Higgsfield 3D Jutsu MCP.
Stylized geometry; not measured anatomy, prediction output, or molecular motion.
"""
import bpy
import math
import random
from mathutils import Vector

random.seed(41)
scene = bpy.context.scene
scene.name = 'Helix — Cell Interior'
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.media_type = 'IMAGE'
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = False
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 1
scene.world = bpy.data.worlds.new('Deep blue-black environment')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.003, 0.007, 0.014, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.15
scene['scientific_status'] = 'Original stylized educational cell cutaway; not measured biology or model output.'

def material(name, rgb, metal=0.0, rough=0.4, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*rgb, 1)
    p = mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    p.inputs['Emission Color'].default_value = (*rgb, 1)
    p.inputs['Emission Strength'].default_value = emission
    return mat

shell = material('Membrane · deep petrol', (0.018,0.105,0.13), .28, .29, .12)
cyan = material('Membrane · cyan rim', (.08,.65,.66), .3, .25, 1.25)
inner = material('Membrane · blue interior ridges', (.025,.22,.28), .4, .34, .18)
gold = material('Nucleus · warm amber', (.68,.23,.04), .28, .32, .15)
amber = material('Nucleus · illuminated edge', (1.0,.43,.06), .25, .24, .75)
chrom = material('Chromatin · copper filaments', (.92,.29,.055), .15, .33, .7)
core = material('Nucleolus · warm dense core', (.27,.075,.022), .2, .25, .08)
purple = material('Mitochondria · aubergine', (.20,.065,.12), .15, .33, .05)
pink = material('Cristae · coral folds', (.86,.22,.18), .15, .3, .35)
er = material('ER · deep blue', (.03,.16,.27), .35, .31, .12)
er_edge = material('ER · blue edge', (.08,.36,.52), .35, .26, .35)
golgi = material('Golgi · warm peach', (.62,.3,.15), .2, .34, .12)
rib = material('Ribosome · muted gold', (.54,.36,.13), .4, .35, .15)
vesicle = material('Vesicles · jade', (.08,.33,.28), .22, .28, .22)

def mesh_obj(name, verts, faces, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for f in obj.data.polygons: f.use_smooth = True
    return obj

def tube(name, points, radius, mat, cyclic=False):
    c = bpy.data.curves.new(name, 'CURVE')
    c.dimensions = '3D'
    c.resolution_u = 1
    c.bevel_depth = radius
    c.bevel_resolution = 2
    c.use_fill_caps = True
    s = c.splines.new('POLY')
    s.points.add(len(points)-1)
    for p, xyz in zip(s.points, points): p.co = (*xyz, 1)
    s.use_cyclic_u = cyclic
    o = bpy.data.objects.new(name, c)
    scene.collection.objects.link(o)
    c.materials.append(mat)
    return o

def sphere(name, center, scale, mat, segments=32, rings=18):
    verts, faces = [], []
    for j in range(rings+1):
        th = math.pi*j/rings
        for i in range(segments):
            ph = 2*math.pi*i/segments
            verts.append((math.sin(th)*math.cos(ph), math.sin(th)*math.sin(ph), math.cos(th)))
    for j in range(rings):
        for i in range(segments):
            a=j*segments+i; b=j*segments+(i+1)%segments
            faces.append((a,b,b+segments,a+segments))
    o=mesh_obj(name,verts,faces,mat); o.location=center; o.scale=scale
    return o

def bowl(name, center, axes, cut_cos, mat, rim_mat, wobble=0.03):
    verts, faces = [], []
    rings, slices = 32, 100
    end=math.acos(cut_cos)
    for j in range(rings+1):
        th=end*j/rings
        for i in range(slices):
            ph=2*math.pi*i/slices
            wave=1+wobble*(math.sin(ph*5+th)*.6+math.cos(ph*3-th)*.4)*math.sin(th)
            verts.append((center[0]+axes[0]*math.sin(th)*math.cos(ph)*wave,
                          center[1]+axes[1]*math.cos(th)*wave,
                          center[2]+axes[2]*math.sin(th)*math.sin(ph)*wave))
    for j in range(rings):
        for i in range(slices):
            a=j*slices+i; b=j*slices+(i+1)%slices
            faces.append((a,a+slices,b+slices,b))
    o=mesh_obj(name,verts,faces,mat)
    tube(name+' · cutaway edge',verts[-slices:], .055 if axes[0]>3 else .04,rim_mat,True)
    return o

# The near-facing hemisphere is deliberately open; the remaining shell gives depth.
bowl('Membrane · open cell envelope',(0,0,0),(6,4.8,4.65),-.27,shell,cyan)
for offset in (0.075,0.16):
    points=[]
    for i in range(140):
        ph=2*math.pi*i/140; th=math.acos(-.27)-offset
        wave=1+.03*(math.sin(ph*5+th)*.6+math.cos(ph*3-th)*.4)*math.sin(th)
        points.append((6*math.sin(th)*math.cos(ph)*wave,4.8*math.cos(th)*wave,4.65*math.sin(th)*math.sin(ph)*wave))
    tube('Membrane · lipid boundary '+str(offset),points,.024,inner,True)

# Nucleus has its own open envelope and a visible, spatial chromatin interior.
nc=(-.6,-.2,.15)
bowl('Nucleus · open nuclear envelope',nc,(2.05,1.75,2.05),-.38,gold,amber,.015)
sphere('Nucleus · nucleolus',(-.72,.14,.05),(.61,.52,.58),core,40,24)
for strand in range(8):
    pts=[]
    for i in range(130):
        t=i/129; a=t*math.pi*4+strand*.83
        radial=1.05+.2*math.sin(a*1.7+strand)
        pts.append((nc[0]+radial*math.cos(a),nc[1]+.2+.67*math.sin(a*.79+strand*.7),nc[2]-1.35+2.7*t))
    tube('Chromatin · folded strand %02d'%strand,pts,.031 if strand%2 else .045,chrom)
for i in range(22):
    ph=2*math.pi*i/22
    sphere('Nucleus · pore %02d'%i,(nc[0]+1.84*math.cos(ph),nc[1]-.68,nc[2]+1.84*math.sin(ph)),(.075,.042,.075),amber,12,8)

# Broad ER membranes rather than decorative lines alone.
for layer in range(6):
    verts,faces,edge=[],[],[]
    for i in range(65):
        a=.15+i/64*4.8; r=2.55+.1*layer
        for side in (-1,1):
            rr=r+side*.22
            verts.append((nc[0]+rr*math.cos(a),.4+rr*.72*math.sin(a),-1.2+layer*.32+.17*math.sin(a*2+layer*.45)))
        edge.append(verts[-1])
        if i: faces.append((2*i-2,2*i-1,2*i+1,2*i))
    mesh_obj('ER · folded membrane %02d'%layer,verts,faces,er)
    tube('ER · raised edge %02d'%layer,edge,.032,er_edge)

mitos=[((3.4,-.35,1.85),(1,.52,.48),(.1,.35,-.45)),
       ((3.05,.4,-2.22),(.95,.50,.46),(.4,-.45,.8)),
       ((-3.55,-.15,-1.7),(.90,.48,.42),(.2,.3,-.6)),
       ((-3.3,1.3,2.23),(1.0,.5,.46),(.4,.2,.2)),
       ((1.55,2.25,2.3),(.83,.44,.4),(.1,.1,-.7))]
for n,(center,scale,rotation) in enumerate(mitos):
    body=sphere('Mitochondrion %02d · outer membrane'%n,center,scale,purple,40,22)
    body.rotation_euler=rotation
    for fold in range(8):
        x=-.72+fold*.205
        pts=[]
        for i in range(30):
            a=-1.18+i/29*2.36
            y=-.42*math.cos(a)*(1-x*x)**.5
            z=.41*math.sin(a)*(1-x*x)**.5
            pts.append((x+.055*math.sin(a*3),y-.017,z))
        o=tube('Mitochondrion %02d · crista %02d'%(n,fold),pts,.035,pink)
        o.parent=body

for layer in range(6):
    pts=[]
    for i in range(42):
        a=-1.2+i/41*2.4
        pts.append((-3.15+(.7+.045*layer)*math.sin(a),-1.10+.32*math.cos(a),.25+layer*.21+.10*math.cos(a)))
    tube('Golgi · cisterna %02d'%layer,pts,.12,golgi)

# Shared sphere mesh keeps repeated particles inexpensive in a GLB viewer.
prototype=sphere('Ribosome · 000',(0,0,0),(.062,.062,.062),rib,12,8)
for i in range(100):
    while True:
        x=random.uniform(-4.8,4.8); y=random.uniform(-.6,2.8); z=random.uniform(-3.4,3.4)
        if (x/5.3)**2+(y/4.2)**2+(z/4)**2<.92 and ((x+.6)/2.4)**2+((y+.2)/2.1)**2+((z-.15)/2.4)**2>1.15: break
    o=prototype if i==0 else bpy.data.objects.new('Ribosome · %03d'%i,prototype.data)
    if i: scene.collection.objects.link(o)
    o.location=(x,y,z); s=random.uniform(.038,.07); o.scale=(s,s,s)
for i in range(17):
    a=i*2.39996; r=3.8+random.random()*.6
    sphere('Vesicle · %02d'%i,(r*math.cos(a),random.uniform(-.5,1.8),3.0*math.sin(a)),(.15,.15,.15),vesicle,20,12)

def point_light(name,loc,color,power,radius):
    data=bpy.data.lights.new(name,'POINT'); data.energy=power; data.color=color; data.shadow_soft_size=radius
    o=bpy.data.objects.new(name,data); scene.collection.objects.link(o); o.location=loc
point_light('Light · cool motivated key',(-4,-7,7),(.36,.8,1),1450,4.0)
point_light('Light · soft warm fill',(5,-4,2),(1,.56,.28),1000,3.0)
point_light('Light · upper cyan rim',(1,3,6),(.12,.62,1),1700,2.0)
point_light('Light · nucleus interior',(-.6,-1.1,.9),(1,.36,.10),90,.8)
camera=bpy.data.cameras.new('Cell portrait camera')
cam=bpy.data.objects.new('Cell portrait camera',camera); scene.collection.objects.link(cam)
cam.location=(8.7,-18,8.2)
cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler()
camera.type='ORTHO'; camera.ortho_scale=14.4; camera.lens=50
scene.camera=cam
scene.view_settings.view_transform='Khronos PBR Neutral'
scene.view_settings.look='None'
scene.view_settings.exposure=0
scene['delivery_note']='Static editable cutaway; portable Principled materials. GLB converts Blender Z-up to Y-up.'
result={'objects':len(scene.objects),'mesh_objects':sum(o.type=='MESH' for o in scene.objects),'curve_objects':sum(o.type=='CURVE' for o in scene.objects),'camera_location':list(cam.location),'camera_target':[0,0,0],'bounds_blender_approx':[[-6,-2,-4.8],[6,4.8,4.8]],'scientific_status':scene['scientific_status']}
