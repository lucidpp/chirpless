import * as THREE from 'three';
import { boxUnwrapUVs, surfaceManager } from './utils.js';
import { Vehicle } from './Vehicle.js';

export class World {
    constructor(scene) {
        this.scene = scene;
        this.mapGroup = new THREE.Group();
        this.scene.add(this.mapGroup);
        
        this.items = [];
        this.killBricks = [];
        this.collidables = [];
        this.launchPads = [];
        this.teleporters = [];
        
        this.vehicles = [];
        this.animated = [];

        this.bgm = null;

        this.skyboxMesh = null;
        this.setupSkybox();
        this.loadMap('platform');
    }

    setupSkybox() {
        const loader = new THREE.TextureLoader();
        
        const loadSide = (path) => {
            const tex = loader.load(path);
            tex.colorSpace = THREE.SRGBColorSpace;
            return new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false });
        };

        const matDN = loadSide('/null_plainsky512_dn.jpg');
        // Fix orientation of bottom face - User requested rotation
        matDN.map.center.set(0.5, 0.5);
        matDN.map.rotation = Math.PI; // Rotated 180 degrees

        const materials = [
            loadSide('/null_plainsky512_rt.jpg'), // px
            loadSide('/null_plainsky512_lf.jpg'), // nx
            loadSide('/null_plainsky512_up.jpg'), // py
            matDN,                                  // ny
            loadSide('/null_plainsky512_bk.jpg'), // pz
            loadSide('/null_plainsky512_ft.jpg')  // nz
        ];

        const geo = new THREE.BoxGeometry(400, 400, 400);
        this.skyboxMesh = new THREE.Mesh(geo, materials);
        this.skyboxMesh.renderOrder = -Infinity;
        this.scene.add(this.skyboxMesh);
    }

    clear() {
        this.items.forEach(mesh => {
            this.mapGroup.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
        });
        
        this.bgm = null;

        // Clear Vehicles
        this.vehicles.forEach(v => {
            this.scene.remove(v.mesh);
            // v.dispose();
        });
        this.vehicles = [];
        this.animated = [];

        this.items = [];
        this.collidables = [];
        this.killBricks = [];
        this.launchPads = [];
        this.teleporters = [];
    }

    loadMap(name) {
        this.clear();
        switch(name) {
            case 'baseplate': this.setupBaseplate(); break;
            case 'platform': this.setupPlatform(); break;
            case 'chirpless_hunt': this.setupChirplessHunt(); break;
            case 'lucky_world': this.setupLuckyWorld(); break;
            case 'easter_2026': this.setupEaster2026(); break;
            case 'chirpless_halloween': /* legacy: keep but don't load by menu */ this.setupChirplessHalloween(); break;
            case 'chirpcity': this.setupChirpCity(); break;
            default: console.warn("Unknown map: " + name); this.setupPlatform(); break;
        }
    }

    // New: JSON Serialization for User Worlds
    serialize() {
        const data = [];
        // Save BGM as a special meta entry or property
        if (this.bgm) {
            data.push({ type: 'meta_bgm', url: this.bgm });
        }

        this.items.forEach(obj => {
            if (obj.userData && obj.userData.serial) {
                const s = obj.userData.serial;
                data.push({
                    type: s.type,
                    x: obj.position.x,
                    y: obj.position.y,
                    z: obj.position.z,
                    w: s.w, h: s.h, d: s.d, // Dimensions (if baked)
                    sx: obj.scale.x, // Scale (if not baked)
                    sy: obj.scale.y,
                    sz: obj.scale.z,
                    rx: obj.rotation.x,
                    ry: obj.rotation.y,
                    rz: obj.rotation.z,
                    color: s.color, // integer
                    flags: s.flags
                });
            }
        });
        return data;
    }

    loadFromData(data) {
        this.clear();
        if (!Array.isArray(data)) return;
        
        data.forEach(d => {
            if (d.type === 'meta_bgm') {
                this.bgm = d.url;
            } else if (d.type === 'block' || d.type === 'box') {
                const mesh = this.createBlock(d.x, d.y, d.z, d.w, d.h, d.d, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            } else if (d.type === 'sphere' || d.type === 'cylinder' || d.type === 'wedge') {
                const mesh = this.createPart(d.type, d.x, d.y, d.z, {x:d.w, y:d.h, z:d.d}, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            }
        });
    }

    addToWorld(mesh, types = ['static']) {
        this.mapGroup.add(mesh);
        this.items.push(mesh);
        if (types.includes('static')) this.collidables.push(mesh);
        if (types.includes('kill')) this.killBricks.push(mesh);
        if (types.includes('launch')) this.launchPads.push(mesh);
        if (types.includes('teleport')) this.teleporters.push(mesh);
    }

    createPart(type, x, y, z, size, color, flags = ['static']) {
        // Wrapper for shapes
        if (type === 'block' || type === 'box') {
            return this.createBlock(x, y, z, size.x, size.y, size.z, color, flags);
        }

        let geo;
        if (type === 'sphere') {
            geo = new THREE.SphereGeometry(Math.min(size.x, size.y, size.z) / 2, 16, 16);
        } else if (type === 'cylinder') {
            geo = new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 16);
        } else if (type === 'wedge') {
            // Wedge logic: Box with collapsed vertices
            geo = new THREE.BoxGeometry(size.x, size.y, size.z);
            boxUnwrapUVs(geo); // Apply standard box UVs before distorting
            
            const pos = geo.attributes.position;
            const wHalf = size.x / 2;
            const hHalf = size.y / 2;
            const dHalf = size.z / 2;
            
            // Iterate over vertices and collapse "Front Top" to "Front Bottom"
            // Front face is +z (dHalf). Top is +y (hHalf).
            // We want to collapse (x, +h, +d) -> (x, -h, +d)
            // Or typically Roblox wedge is: Back face vertical, Bottom flat, Hypotenuse slope.
            // If we assume Box is centered.
            // Front face (+z) vertices at Y=+hHalf should become Y=-hHalf
            
            for(let i=0; i<pos.count; i++) {
                const vy = pos.getY(i);
                const vz = pos.getZ(i);
                
                // Check if vertex is on the Front (+Z) and Top (+Y)
                if (vz > 0.1 && vy > 0.1) {
                    pos.setY(i, -hHalf); // Snap down
                }
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
        }

        const col = new THREE.Color(color);
        const mat = new THREE.MeshStandardMaterial({ 
            map: surfaceManager.textures.studs, 
            color: col,
            roughness: 0.5 
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        mesh.userData.serial = {
            type: type,
            w: size.x, h: size.y, d: size.z,
            color: color,
            flags: flags
        };
        
        mesh.name = type.charAt(0).toUpperCase() + type.slice(1);
        this.addToWorld(mesh, flags);
        return mesh;
    }

    createBlock(x, y, z, w, h, d, color, types = ['static']) {
        const geo = new THREE.BoxGeometry(w, h, d);
        boxUnwrapUVs(geo);
        
        const col = new THREE.Color(color);

        const studMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.studs, color: col });
        const inletMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.inlet, color: col });
        const sideMat = new THREE.MeshStandardMaterial({ color: col });
        
        // Top=Studs, Bottom=Inlet
        const mats = [sideMat, sideMat, studMat, inletMat, sideMat, sideMat];
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(x, y, z);
        
        // Save serialization data
        mesh.userData.serial = {
            type: 'block',
            w: w, h: h, d: d,
            color: color,
            flags: types
        };

        if (types.includes('spawn')) {
            mesh.name = "SpawnLocation";
            this.addSpawnDecal(mesh);
        } else {
            mesh.name = "Part";
        }

        this.addToWorld(mesh, types);
        return mesh;
    }

    addSpawnDecal(parentMesh) {
         // Decal
         const canvas = document.createElement('canvas');
         canvas.width = 64; canvas.height = 64;
         const ctx = canvas.getContext('2d');
         ctx.fillStyle = '#888'; ctx.fillRect(0,0,64,64);
         ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
         ctx.beginPath(); ctx.arc(32,32,20,0,Math.PI*2); ctx.stroke();
         const decalTex = new THREE.CanvasTexture(canvas);
         
         const decalGeo = new THREE.PlaneGeometry(4, 4);
         decalGeo.rotateX(-Math.PI/2);
         const decal = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ map: decalTex, transparent:true }));
         decal.position.y = parentMesh.userData.serial.h / 2 + 0.01;
         parentMesh.add(decal);
    }

    setupBaseplate() {
        // Floor
        const base = this.createBlock(0, -2, 0, 512, 4, 512, 0x242424, ['static']);
        // Ensure the main baseplate shows up as "Baseplate" in explorer/studio
        base.name = 'Baseplate';
        
        // Spawn Location
        this.createBlock(0, 0.5, 0, 6, 1, 6, 0x888888, ['static', 'spawn']);
    }

    getSpawnPoint() {
        const spawns = this.items.filter(i => 
            i.userData.serial && i.userData.serial.flags && i.userData.serial.flags.includes('spawn')
        );
        if (spawns.length > 0) {
            // Pick random if multiple
            const s = spawns[Math.floor(Math.random() * spawns.length)];
            // Spawn above the pad
            const h = s.userData.serial.h || 1;
            // World position
            return s.position.clone().add(new THREE.Vector3(0, h/2 + 5, 0));
        }
        return new THREE.Vector3(0, 10, 0);
    }

    setupPlatform() {
        // Platform Config
        const centerSize = 256; // Studs
        const height = 2;      // Studs

        // Materials
        const centerMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const inletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const centerMats = [centerMat, centerMat, centerMat, inletMat, centerMat, centerMat];

        const rimColor = new THREE.Color(0x888888);

        const rimMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: rimColor, roughness: 0.8
        });
        const rimInletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: rimColor, roughness: 0.8
        });
        const rimMats = [rimMat, rimMat, rimMat, rimInletMat, rimMat, rimMat];

        // 1. Center Mesh
        const centerGeo = new THREE.BoxGeometry(centerSize, height, centerSize);
        boxUnwrapUVs(centerGeo);
        const centerMesh = new THREE.Mesh(centerGeo, centerMats);
        centerMesh.position.set(0, height/2, 0);
        this.addToWorld(centerMesh);

        // 2. Rim Meshes Helper
        const addRim = (w, h, d, x, y, z) => {
            const geo = new THREE.BoxGeometry(w, h, d);
            boxUnwrapUVs(geo);
            const mesh = new THREE.Mesh(geo, rimMats);
            mesh.position.set(x, y, z);
            this.addToWorld(mesh);
        };

        // Rims
        const rl = centerSize + 2;
        addRim(rl, height, 1, 0, height/2, -(centerSize+1)/2);
        addRim(rl, height, 1, 0, height/2, (centerSize+1)/2);
        addRim(1, height, centerSize, -(centerSize+1)/2, height/2, 0);
        addRim(1, height, centerSize, (centerSize+1)/2, height/2, 0);

        // Kill Part
        const kSize = 4;
        this.createBlock(10, 2 + kSize/2, 10, kSize, kSize, kSize, 0xff0000, ['static', 'kill']);

        // --- NEW CONTENT ---

        // House
        const hx = -60;
        const hz = 60;
        // Floor
        this.createBlock(hx, 1, hz, 30, 1, 30, 0x664422);
        // Walls
        this.createBlock(hx - 14, 8, hz, 2, 14, 30, 0xffffcc); // Left
        this.createBlock(hx + 14, 8, hz, 2, 14, 30, 0xffffcc); // Right
        this.createBlock(hx, 8, hz - 14, 26, 14, 2, 0xffffcc); // Back
        // Front (Doorway)
        this.createBlock(hx - 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx + 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx, 12, hz + 14, 6, 6, 2, 0xffffcc); // Door header
        // Roof
        const roof = this.createBlock(hx, 16, hz, 34, 2, 34, 0xcc0000);
        roof.rotation.x = 0.1;
        
        // Trampoline
        const tx = 40; const tz = 40;
        this.createBlock(tx, 0.5, tz, 12, 1, 12, 0x111111);
        this.createBlock(tx, 1.5, tz, 10, 1, 10, 0x0000ff, ['static', 'launch']);


        // Teleporter to Mega Platform
        const tp = this.createBlock(-15, 2.1, 0, 6, 0.2, 6, 0x00ff00, ['static', 'teleport']);
        tp.userData = { destination: new THREE.Vector3(1000, 5, 0), name: "Mega Platform" };

        // MEGA PLATFORM (Offset 1000)
        const ox = 1000;
        const oz = 0;

        // Main Floor (200x200)
        this.createBlock(ox, 0, oz, 200, 2, 200, 0x555555);

        // 1. CARS
        const car1 = new Vehicle(this.scene, ox + 20, 5, oz - 20, 0xff0000);
        this.vehicles.push(car1);
        
        const car2 = new Vehicle(this.scene, ox + 30, 5, oz - 20, 0x0055ff);
        this.vehicles.push(car2);

        // 2. CRUSHER
        // Base
        this.createBlock(ox - 40, 1, oz + 40, 20, 2, 20, 0x333333);
        // Crusher Head
        const crusher = this.createBlock(ox - 40, 15, oz + 40, 18, 10, 18, 0x222222, ['static', 'kill']);
        this.animated.push({
            mesh: crusher,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 1.5;
                // Move between y=3 and y=25
                obj.mesh.position.y = 14 + Math.sin(obj.time) * 11;
            }
        });

        // 4. RAMP (Using steps for collision stability, as simple box collision is AABB)
        const rx = ox + 50;
        const rz = oz + 50;
        for(let i=0; i<20; i++) {
            // Ramp going up
            this.createBlock(rx, i, rz + i*2, 20, 1, 2, 0x888888);
        }
        // Jump pad at end of ramp
        this.createBlock(rx, 20, rz + 42, 20, 1, 6, 0xff00ff, ['static', 'launch']);

        // 5. SWINGSET
        const sx = ox + 20;
        const sz = oz + 60;
        // Frame
        this.createBlock(sx - 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx + 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx, 30, sz, 22, 1, 1, 0x4e342e);
        // Swing Seat
        const seat = this.createBlock(sx, 10, sz, 6, 0.5, 4, 0xff0000);
        this.animated.push({
            mesh: seat,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 2.5;
                const angle = Math.sin(obj.time) * 0.8;
                // Pivot is at (sx, 30, sz)
                const len = 20;
                obj.mesh.position.x = sx + Math.sin(angle) * len;
                obj.mesh.position.y = 30 - Math.cos(angle) * len;
                obj.mesh.rotation.z = -angle;
            }
        });

        // 6. FLOAT ERROR TELEPORTER
        // Far out on the platform
        const fpTp = this.createBlock(ox + 90, 1.1, oz + 90, 8, 0.2, 8, 0xff00ff, ['static', 'teleport']);
        fpTp.userData = { destination: new THREE.Vector3(ox, 1000000, oz), name: "Far Lands" };
        
        // Floating Point Platform
        const fpx = ox;
        const fpy = 1000000;
        // Need to add this to world, but createBlock adds to group. 
        // Note: Rendering at 1,000,000 might cause jitter (z-fighting/precision), which is the intended effect!
        const fpGeo = new THREE.BoxGeometry(50, 2, 50);
        boxUnwrapUVs(fpGeo);
        const fpMesh = new THREE.Mesh(fpGeo, new THREE.MeshStandardMaterial({color: 0xaaaaaa, map: surfaceManager.textures.studs}));
        fpMesh.position.set(fpx, fpy - 5, oz);
        this.addToWorld(fpMesh);
    }

    setupObby() {
        // Start
        this.createBlock(0, 0, 0, 14, 1, 14, 0x00cc00);

        // Step 1
        this.createBlock(0, 0, -15, 8, 1, 8, 0xaaaaaa);

        // Step 2
        this.createBlock(0, 2, -25, 6, 1, 6, 0xaaaaaa);

        // Step 3 (Gap)
        this.createBlock(0, 4, -36, 4, 1, 4, 0xaaaaaa);

        // Step 4 (Wall Jump / High)
        this.createBlock(0, 6, -45, 4, 1, 4, 0xaaaaaa);

        // Truss/Beam
        this.createBlock(0, 6, -55, 2, 1, 10, 0x666666);
        
        // Kill obstacle on beam
        this.createBlock(0, 6.75, -55, 2, 0.5, 2, 0xff0000, ['static', 'kill']);

        // End
        this.createBlock(0, 8, -70, 15, 1, 15, 0xffff00);
        // Winner pillar
        this.createBlock(0, 12, -70, 2, 8, 2, 0xffaa00);
    }

    setupChirplessHunt() {
        // Large grassy base
        const base = this.createBlock(0, -1, 0, 300, 2, 300, 0x2e8b57, ['static']);
        base.name = "Grasslands";
        
        // Spawn Location
        this.createBlock(0, 0.5, 0, 10, 1, 10, 0xcccccc, ['static', 'spawn']);

        // A "nice" tiered fountain or centerpiece
        for(let i=0; i<4; i++) {
            const size = 30 - (i * 6);
            this.createBlock(0, i * 2, 0, size, 2, size, 0x88ccff);
        }
        // Top of fountain - The "Chirp" trophy (a yellow sphere)
        const trophy = this.createPart('sphere', 0, 10, 0, {x:4, y:4, z:4}, 0xffcc00);
        trophy.name = "The Chirp";
        this.animated.push({
            mesh: trophy,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 2;
                obj.mesh.position.y = 10 + Math.sin(obj.time) * 1.5;
                obj.mesh.rotation.y += dt;
            }
        });

        // Scattered "Eggs" or items to hunt
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
        for(let i=0; i<15; i++) {
            const rx = (Math.random() - 0.5) * 200;
            const rz = (Math.random() - 0.5) * 200;
            const color = colors[Math.floor(Math.random() * colors.length)];
            const egg = this.createPart('sphere', rx, 1, rz, {x:2, y:2, z:2}, color);
            egg.name = "Egg " + (i+1);
        }

        // Some nature-like pillars/trees
        for(let i=0; i<10; i++) {
            const rx = (Math.random() - 0.5) * 240;
            const rz = (Math.random() - 0.5) * 240;
            if (Math.abs(rx) < 20 && Math.abs(rz) < 20) continue; // don't spawn near center
            
            // Trunk
            this.createBlock(rx, 5, rz, 2, 10, 2, 0x5d4037);
            // Leaves
            this.createBlock(rx, 11, rz, 8, 4, 8, 0x1b5e20);
        }

        // Floating parkour challenge
        for(let i=0; i<8; i++) {
            this.createBlock(-60 - (i*10), 5 + (i*3), -60, 6, 1, 6, 0xeeeeee);
        }
        // Prize at end of parkour
        this.createBlock(-140, 28, -60, 4, 4, 4, 0xffd700, ['static', 'launch']);
    }

    // New large city map: ChirpCity
    setupChirpCity() {
        // Large city footprint
        this.createBlock(0, -1, 0, 1200, 2, 1200, 0x9aa0a6, ['static']);
        // Central spawn plaza
        this.createBlock(0, 0.5, 0, 24, 1, 24, 0xcccccc, ['static', 'spawn']);

        // Grid of streets with blocks of buildings
        const blockSize = 60;
        const spacing = 80;
        const rows = 6;
        const cols = 6;
        const startX = -((cols-1) * spacing) / 2;
        const startZ = -((rows-1) * spacing) / 2;

        for (let r=0; r<rows; r++) {
            for (let c=0; c<cols; c++) {
                const bx = startX + c * spacing;
                const bz = startZ + r * spacing;
                // Random building height and footprint
                const bw = blockSize - 8 + Math.floor(Math.random()*10);
                const bd = blockSize - 8 + Math.floor(Math.random()*10);
                const h = 10 + Math.floor(Math.random()*40);
                // Most buildings are solid; create as simple box
                const building = this.createBlock(bx, h/2, bz, bw, h, bd, 0xcccccc, ['static']);
                building.name = `Building_${r}_${c}`;
                // A few windows / roof elements
                if (Math.random() < 0.15) {
                    // small rooftop structure
                    this.createBlock(bx + 6, h + 2, bz - 6, 8, 4, 8, 0x444444, ['static']);
                }
            }
        }

        // Create two accessible interior buildings (with openings/doorways)
        const houseA = this.createBlock(-120, 12, 180, 40, 24, 40, 0xe0d6c8, ['static']);
        // Carve out a doorway by placing a thin empty space (use a thin "door" and mark as not collidable by not adding to collidables) 
        const doorA = this.createBlock(-120, 6, 200, 12, 12, 0.5, 0x663300, ['static']);
        doorA.userData.isDoor = true;
        doorA.userData.candyAvailable = false;

        const interiorFloor = this.createBlock(-120, 0.5, 180, 38, 1, 38, 0xaaaaaa, ['static']);
        // Make a simple interior room by placing a few inner parts (tables)
        this.createBlock(-120, 2, 180, 6, 2, 4, 0x8b5a2b, ['static']);

        const houseB = this.createBlock(260, 10, -140, 50, 20, 36, 0xdedede, ['static']);
        const doorB = this.createBlock(260, 5, -122, 10, 10, 0.5, 0x663300, ['static']);
        doorB.userData.isDoor = true;
        doorB.userData.candyAvailable = false;
        this.createBlock(260, 0.5, -140, 46, 1, 32, 0x999999, ['static']);

        // Gas Station: pumps + canopy + small shop
        const gx = 80, gz = -250;
        // canopy
        this.createBlock(gx, 8, gz, 40, 1, 30, 0xffffff, ['static']);
        // pumps (decorative)
        for (let i=0;i<4;i++) {
            const px = gx - 12 + i*8;
            const p = this.createBlock(px, 1.2, gz - 6, 2, 2.4, 2, 0xff0000, ['static']);
            p.name = 'GasPump';
        }
        // small shop
        this.createBlock(gx + 30, 4, gz, 12, 8, 10, 0xffffcc, ['static']);

        // Main downtown tower cluster (tall buildings)
        for (let i=0; i<8; i++) {
            const tx = 360 + (i%4) * 18;
            const tz = 220 + Math.floor(i/4) * 18;
            const th = 40 + Math.floor(Math.random()*120);
            this.createBlock(tx, th/2, tz, 12, th, 12, 0x444b55, ['static']);
        }

        // Add some roads (long thin blocks) to visually separate blocks
        for (let i= -400; i<=400; i+=80) {
            this.createBlock(i, 0.1, -420, 60, 0.2, 1600, 0x222222, ['static']);
            this.createBlock(-420, 0.1, i, 1600, 0.2, 60, 0x222222, ['static']);
        }

        // Add a large park and plaza near center with some props
        this.createBlock(0, 0.5, 220, 140, 1, 140, 0x66bb66, ['static']);
        for (let i=0;i<12;i++) {
            const rx = (Math.random()-0.5) * 120;
            const rz = 220 + (Math.random()-0.5) * 120;
            this.createBlock(rx, 2, rz, 4, 4, 4, 0x8b5a2b);
        }

        // Make city "big" by adding a few outlying landmarks
        this.createBlock(-520, 1, 0, 80, 2, 80, 0x555555, ['static']); // industrial yard
        this.createBlock(520, 1, 0, 80, 2, 80, 0x555555, ['static']);  // stadium pad

        // Name some important objects
        this.items.forEach(it => {
            if (it.name && it.name.startsWith('Building')) {
                // keep as-is
            }
        });

        // Add a few animated elements (traffic light placeholders)
        const light = this.createBlock(40, 6, 40, 1, 8, 1, 0x222222, ['static']);
        this.animated.push({
            mesh: light,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt;
                const t = Math.floor(obj.time) % 3;
                // no-op visual placeholder (could swap colors), kept lightweight
            }
        });

        // Provide large map name
        base.name = 'ChirpCity';
    }

    // Lucky World: coins on the floor to collect for buying pets
    setupLuckyWorld() {
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x66bb66, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Scatter many coin pickups (ensure they are added to items so collection logic sees them)
        const coinGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12);
        coinGeom.rotateX(Math.PI/2);
        for (let i=0; i<60; i++) {
            const rx = (Math.random() - 0.5) * 160;
            const rz = (Math.random() - 0.5) * 160;
            const ry = 1 + Math.random() * 1.5;
            const mat = new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0x886600, metalness: 1.0, roughness: 0.2 });
            const coin = new THREE.Mesh(coinGeom.clone(), mat);
            coin.position.set(rx, ry, rz);
            coin.userData.serial = { type: 'coin' };
            coin.name = 'Coin';
            this.mapGroup.add(coin);
            this.items.push(coin);
            // coins are not collidables so they don't block movement
        }

        // Pet shop marker (in-world)
        const shop = this.createBlock(12, 1, 12, 6, 2, 6, 0x88ccff, ['static']);
        shop.name = 'PetShop';
    }

    setupChirplessHalloween() {
        // Small town Halloween map with one house and a knockable door that gives candy once
        // Ground
        this.createBlock(0, -1, 0, 120, 2, 120, 0x222222, ['static']);
        // Spawn pad
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // House footprint
        const hx = 0, hz = -30;
        this.createBlock(hx, 1, hz, 40, 1, 40, 0x4d2a20); // floor
        this.createBlock(hx - 19, 10, hz, 2, 18, 40, 0xefe6d6); // left wall
        this.createBlock(hx + 19, 10, hz, 2, 18, 40, 0xefe6d6); // right wall
        this.createBlock(hx, 10, hz - 19, 36, 18, 2, 0xefe6d6); // back wall
        // Front wall split to leave door
        this.createBlock(hx - 10, 10, hz + 19, 16, 18, 2, 0xefe6d6);
        this.createBlock(hx + 10, 14, hz + 19, 8, 10, 2, 0xefe6d6); // window block

        // Roof
        this.createBlock(hx, 20, hz, 44, 2, 44, 0x2b1b17);

        // Door (small thin part used as interactable object)
        const door = this.createBlock(hx, 5, hz + 19.6, 4, 8, 0.2, 0x663300, ['static']);
        door.name = 'Door';
        door.userData.isDoor = true;
        door.userData.candyAvailable = true; // one-time candy

        // A porch light (just decoration)
        this.createBlock(hx - 6, 8, hz + 21, 2, 2, 0.2, 0xffff88, ['static']);

        // Some pumpkins
        for (let i=0;i<6;i++) {
            const px = hx + Math.random()*20 - 10;
            const pz = hz + 22 + Math.random()*6 - 3;
            this.createPart('sphere', px, 1, pz, {x:1.5,y:1.5,z:1.5}, 0xff6600);
        }
    }

    // Easter 2026: simple obby with NPC to start and 2 stages; completing unlocks a build tool for the player
    setupEaster2026() {
        // Ground
        this.createBlock(0, -1, 0, 200, 2, 200, 0x88cc88, ['static']);
        this.createBlock(0, 0.5, 0, 8, 1, 8, 0xcccccc, ['static', 'spawn']);

        // Friendly NPC (an "Easter Bunny" statue) the player can interact with
        const npcGeo = new THREE.CylinderGeometry(0.6, 0.6, 1.8, 12);
        const npcMat = new THREE.MeshStandardMaterial({ color: 0xff66cc, emissive: 0x442222 });
        const bunny = new THREE.Mesh(npcGeo, npcMat);
        bunny.position.set(10, 1, 0);
        bunny.name = 'EasterBunnyNPC';
        bunny.userData = { isNPC: true, npcId: 'easter_bunny_1', dialogState: 0, candyGiven: false, obbyStarted: false, obbyProgress: 0 };
        this.mapGroup.add(bunny);
        this.items.push(bunny);

        // Sign / NPC marker (small plane)
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0,0,128,32);
        ctx.fillStyle = 'black';
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Easter Bunny', 64, 20);
        const tex = new THREE.CanvasTexture(canvas);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        sign.position.set(10, 2.5, 0);
        sign.lookAt(new THREE.Vector3(0,2.5,0));
        this.mapGroup.add(sign);

        // Create two progressive obby stages placed outwards
        // Stage 1: simple stepping stones
        const stage1Origin = new THREE.Vector3(30, 1, 0);
        for (let i=0;i<6;i++) {
            this.createBlock(stage1Origin.x + i*6, 1, stage1Origin.z + Math.sin(i)*2, 4, 1, 4, 0xddddff, ['static']);
        }
        // Stage 1 finish marker
        const finish1 = this.createBlock(stage1Origin.x + 6*6, 1, stage1Origin.z, 4, 1, 4, 0x00ff88, ['static']);
        finish1.name = 'EasterFinish1';
        finish1.userData.isFinish = 1;

        // Stage 2: small platforms with gaps and tiny jumps
        const stage2Origin = new THREE.Vector3(100, 1, 0);
        for (let j=0;j<8;j++) {
            const y = 1 + (j%2)*1.5;
            this.createBlock(stage2Origin.x + j*6, y, stage2Origin.z + ((j%3)-1)*2, 3.5, 1, 3.5, 0xffeebb, ['static']);
        }
        // Stage 2 finish marker
        const finish2 = this.createBlock(stage2Origin.x + 8*6, 1, stage2Origin.z, 5, 1, 5, 0x00ffaa, ['static']);
        finish2.name = 'EasterFinish2';
        finish2.userData.isFinish = 2;

        // Store NPC reference so gameplay code can find it
        this._easterNPC = bunny;
        this._easterFinish1 = finish1;
        this._easterFinish2 = finish2;
    }

    setupSpace() {
        // Baseplate
        this.createBlock(0, 0, 0, 80, 2, 80, 0x333333);

        // Launcher
        this.createBlock(0, 1.25, 0, 8, 0.5, 8, 0xff00ff, ['static', 'launch']);

        // High Platform
        this.createBlock(0, 400, 0, 40, 1, 40, 0xffffff);
        this.createBlock(0, 405, 0, 4, 8, 4, 0xffff00);
    }

    update(dt) {
        this.animated.forEach(anim => anim.update(dt, anim));
        this.vehicles.forEach(v => v.update(dt, this.collidables));
    }
}