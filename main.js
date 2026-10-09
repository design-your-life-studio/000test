import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// --- 全域變數定義 ---

// 本地專案檔案控制代碼 (Chrome/Edge 可直接覆寫同一個檔案)
let currentFileHandle = null;

// 左側 (預覽區)
let leftScene, leftCamera, leftRenderer, leftControls;
let previewMesh; // 目前正在編輯預覽的網格模型

// 右側 (組裝區)
let rightScene, rightCamera, rightRenderer, rightControls;
let transformControl; // 用於拖曳/旋轉物體的控制軸
let raycaster, mouse;
let assembledObjects = []; // 儲存所有加入到右側的零件
let selectedObjects = []; // 目前選取的零件 (可多選)
let selectionPivot = null; // 多選時的共同樞紐：整批零件掛在它底下，一起平移/旋轉
let selectionHelper = null; // 多選時的整體外框

// 圖片功能
const imageStore = {};       // imageId -> { dataURL, texture }
let imageHandles = null;     // 圖片 8 個縮放錨點的群組
let imageHandleMeshes = [];  // 錨點 mesh 列表 (用於點擊偵測)
let resizeState = null;      // 目前正在縮放圖片的狀態
let isGridSnapEnabled = false;
let isShiftDown = false; // 新增：追蹤 Shift 鍵狀態

// 碰撞狀態變數 (僅保留視覺線框)
let collisionBox = null;
let alignmentLinesGroup = null; // 新增：用於存放對齊提醒線的群組

// --- 初始化系統 ---
function initSystem() {
    initLeftScene();
    initRightScene();
    setupUIEventListeners();
    
    // 生成初始的預覽零件
    updatePreviewShape();

    // 啟動統一的動畫渲染迴圈
    rendererLoop();
    
    // 使用 ResizeObserver 確保側邊欄收合動畫時畫布能即時自適應
    const resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
            onWindowResize();
        });
    });
    resizeObserver.observe(document.getElementById('right-canvas-container'));
    resizeObserver.observe(document.getElementById('left-canvas-container'));
    
    // 視窗縮放處理
    window.addEventListener('resize', onWindowResize);

}

function initLeftScene() {
    const container = document.getElementById('left-canvas-container');
    leftScene = new THREE.Scene();
    leftScene.background = new THREE.Color(0x1a1a1a);
    
    // 基礎網格 (小)
    leftScene.add(new THREE.GridHelper(500, 20, 0x444444, 0x222222));

    leftCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 2000);
    leftCamera.position.set(200, 200, 250);

    leftRenderer = new THREE.WebGLRenderer({ antialias: true });
    leftRenderer.setSize(container.clientWidth, container.clientHeight);

    // 點擊預覽中的面 (移動不到幾個像素才算點擊，拖曳仍是旋轉視角)
    let leftDown = null;
    leftRenderer.domElement.addEventListener('pointerdown', (e) => { leftDown = { x: e.clientX, y: e.clientY }; });
    leftRenderer.domElement.addEventListener('pointerup', (e) => {
        if (!leftDown) return;
        const moved = Math.hypot(e.clientX - leftDown.x, e.clientY - leftDown.y);
        leftDown = null;
        if (moved < 4) pickPreviewFace(e);
    });
    leftRenderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(leftRenderer.domElement);

    leftControls = new OrbitControls(leftCamera, leftRenderer.domElement);
    leftControls.enableDamping = true;
    leftControls.dampingFactor = 0.1;

    // 打光
    leftScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 200, 50);
    leftScene.add(dirLight);
}

function initRightScene() {
    const container = document.getElementById('right-canvas-container');
    rightScene = new THREE.Scene();
    rightScene.background = new THREE.Color(0x141414);
    
    // 主工作區網格 (大)
    rightScene.add(new THREE.GridHelper(2000, 50, 0x555555, 0x2a2a2a));
    // 坐標原點標示
    rightScene.add(new THREE.AxesHelper(100));

    rightCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
    rightCamera.position.set(500, 400, 600);

    rightRenderer = new THREE.WebGLRenderer({ antialias: true });
    rightRenderer.setSize(container.clientWidth, container.clientHeight);
    rightRenderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(rightRenderer.domElement);

    // 右側視角控制器
    rightControls = new OrbitControls(rightCamera, rightRenderer.domElement);
    rightControls.enableDamping = true;
    rightControls.dampingFactor = 0.1;

    // 打光
    rightScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight1.position.set(500, 1000, 500);
    rightScene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-500, 500, -500);
    rightScene.add(dirLight2);

    // 初始化對齊線群組
    alignmentLinesGroup = new THREE.Group();
    rightScene.add(alignmentLinesGroup);

    // ================= 組裝互動核心：TransformControls =================
    transformControl = new TransformControls(rightCamera, rightRenderer.domElement);
    // 當使用工具軸拖曳物體時，暫停 OrbitControls 的視角旋轉，避免衝突
    transformControl.addEventListener('dragging-changed', function (event) {
        rightControls.enabled = !event.value;
        if (event.value) {
            beginGroupDrag();
        } else {
            endGroupDrag();
            commitHistory();
        }
        if (!event.value) {
            // 拖曳結束時隱藏角度提示
            document.getElementById('rotation-tooltip').classList.add('hidden');
            
            // 拖曳結束時隱藏碰撞線
            if (collisionBox) collisionBox.visible = false;
            
            // 拖曳結束時清除對齊線
            while(alignmentLinesGroup.children.length > 0){ 
                const child = alignmentLinesGroup.children[0];
                alignmentLinesGroup.remove(child);
                child.geometry.dispose();
                child.material.dispose();
            }
        }
    });
    
    // 新增：監聽變化以顯示旋轉角度與處理碰撞
    transformControl.addEventListener('change', function () {
        if (transformControl.dragging && transformControl.getMode() === 'rotate' && selectedObjects.length > 0 && transformControl.object) {
            const tooltip = document.getElementById('rotation-tooltip');
            tooltip.classList.remove('hidden');
            
            // 將弧度轉換為度數並取整數，避免 -0 出現
            let rx = Math.round(THREE.MathUtils.radToDeg(transformControl.object.rotation.x));
            let ry = Math.round(THREE.MathUtils.radToDeg(transformControl.object.rotation.y));
            let rz = Math.round(THREE.MathUtils.radToDeg(transformControl.object.rotation.z));
            rx = rx === -0 ? 0 : rx;
            ry = ry === -0 ? 0 : ry;
            rz = rz === -0 ? 0 : rz;
            
            tooltip.innerText = `X: ${rx}° | Y: ${ry}° | Z: ${rz}°`;
        }

        // ================= 碰撞偵測 (僅顯示亮粉色對齊線，無停頓) =================
        if (transformControl.dragging && transformControl.getMode() === 'translate' && selectedObjects.length > 0) {
            
            // 碰撞檢查
            const selBox = getSelectionBox();
            let isColliding = false;

            for (let i = 0; i < assembledObjects.length; i++) {
                const obj = assembledObjects[i];
                if (selectedObjects.includes(obj)) continue;

                obj.updateMatrixWorld();
                const targetBox = new THREE.Box3().setFromObject(obj);

                // 判斷是否重疊
                if (selBox.intersectsBox(targetBox)) {
                    isColliding = true;
                    break;
                }
            }

            // 處理碰撞結果 (純視覺)
            if (isColliding) {
                // 顯示亮粉色智慧對齊線
                if (!collisionBox) {
                    collisionBox = new THREE.Box3Helper(new THREE.Box3(), 0xff1493);
                    collisionBox.material.depthTest = false; // 穿透顯示
                    collisionBox.material.transparent = true;
                    collisionBox.material.opacity = 0.8;
                    collisionBox.material.linewidth = 2;
                    rightScene.add(collisionBox);
                }
                collisionBox.box.copy(selBox);
                collisionBox.visible = true;
            } else {
                // 沒碰到，隱藏粉紅框
                if (collisionBox) collisionBox.visible = false;
            }

            // ================= 智慧對齊線 (Smart Guides) =================
            // 先清除前一個影格的線條
            while(alignmentLinesGroup.children.length > 0){ 
                const child = alignmentLinesGroup.children[0];
                alignmentLinesGroup.remove(child);
                child.geometry.dispose();
                child.material.dispose();
            }

            const THRESHOLD = 3; // 對齊容差距離 (單位)
            const centerColor = 0x00e5ff; // 青藍色 (表示置中或切齊)
            const touchColor = 0xff9900;  // 橘黃色 (表示邊界互相碰觸)

            // 取得被選取物件的邊界與中心點
            const boxA = selBox.clone();
            const centerA = new THREE.Vector3();
            boxA.getCenter(centerA);

            // 繪製直線 (Y軸方向) - 用於 X 或 Z 軸對齊時
            const drawVertical = (x, z, color) => {
                const minY = boxA.min.y - 100; // 往下延伸畫線
                const maxY = boxA.max.y + 100; // 往上延伸畫線
                const pts = [new THREE.Vector3(x, minY, z), new THREE.Vector3(x, maxY, z)];
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineBasicMaterial({ color: color, depthTest: false, linewidth: 2, transparent: true, opacity: 0.8 });
                alignmentLinesGroup.add(new THREE.Line(geo, mat));
            };

            // 繪製橫線 (X軸或Z軸方向) - 用於 Y 軸對齊時
            const drawHorizontal = (y, axis, color) => {
                let pts = [];
                if (axis === 'x') {
                    pts = [new THREE.Vector3(boxA.min.x - 100, y, centerA.z), new THREE.Vector3(boxA.max.x + 100, y, centerA.z)];
                } else {
                    pts = [new THREE.Vector3(centerA.x, y, boxA.min.z - 100), new THREE.Vector3(centerA.x, y, boxA.max.z + 100)];
                }
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineBasicMaterial({ color: color, depthTest: false, linewidth: 2, transparent: true, opacity: 0.8 });
                alignmentLinesGroup.add(new THREE.Line(geo, mat));
            };

            for (let i = 0; i < assembledObjects.length; i++) {
                const objB = assembledObjects[i];
                if (selectedObjects.includes(objB)) continue;

                objB.updateMatrixWorld();
                const boxB = new THREE.Box3().setFromObject(objB);
                const centerB = new THREE.Vector3();
                boxB.getCenter(centerB);

                // --- 1. 左右前後 (X / Z) 移動對到了 -> 直線 ---
                
                // [中心對齊]
                if (Math.abs(centerA.x - centerB.x) < THRESHOLD) drawVertical(centerB.x, centerA.z, centerColor);
                if (Math.abs(centerA.z - centerB.z) < THRESHOLD) drawVertical(centerA.x, centerB.z, centerColor);
                
                // [邊緣切齊 (側邊平齊)]
                if (Math.abs(boxA.min.x - boxB.min.x) < THRESHOLD) drawVertical(boxB.min.x, centerA.z, centerColor);
                if (Math.abs(boxA.max.x - boxB.max.x) < THRESHOLD) drawVertical(boxB.max.x, centerA.z, centerColor);
                if (Math.abs(boxA.min.z - boxB.min.z) < THRESHOLD) drawVertical(centerA.x, boxB.min.z, centerColor);
                if (Math.abs(boxA.max.z - boxB.max.z) < THRESHOLD) drawVertical(centerA.x, boxB.max.z, centerColor);
                
                // [邊界碰觸 (左右前後互相靠攏)]
                if (Math.abs(boxA.max.x - boxB.min.x) < THRESHOLD) drawVertical(boxB.min.x, centerA.z, touchColor);
                if (Math.abs(boxA.min.x - boxB.max.x) < THRESHOLD) drawVertical(boxB.max.x, centerA.z, touchColor);
                if (Math.abs(boxA.max.z - boxB.min.z) < THRESHOLD) drawVertical(centerA.x, boxB.min.z, touchColor);
                if (Math.abs(boxA.min.z - boxB.max.z) < THRESHOLD) drawVertical(centerA.x, boxB.max.z, touchColor);


                // --- 2. 上下 (Y) 移動對到了 -> 橫線 ---
                
                // [中心對齊]
                if (Math.abs(centerA.y - centerB.y) < THRESHOLD) {
                    drawHorizontal(centerB.y, 'x', centerColor);
                    drawHorizontal(centerB.y, 'z', centerColor);
                }
                
                // [邊緣切齊 (上下平齊)]
                if (Math.abs(boxA.min.y - boxB.min.y) < THRESHOLD) {
                    drawHorizontal(boxB.min.y, 'x', centerColor);
                    drawHorizontal(boxB.min.y, 'z', centerColor);
                }
                if (Math.abs(boxA.max.y - boxB.max.y) < THRESHOLD) {
                    drawHorizontal(boxB.max.y, 'x', centerColor);
                    drawHorizontal(boxB.max.y, 'z', centerColor);
                }
                
                // [邊界碰觸 (上下互相疊加)]
                if (Math.abs(boxA.max.y - boxB.min.y) < THRESHOLD) {
                    drawHorizontal(boxB.min.y, 'x', touchColor);
                    drawHorizontal(boxB.min.y, 'z', touchColor);
                }
                if (Math.abs(boxA.min.y - boxB.max.y) < THRESHOLD) {
                    drawHorizontal(boxB.max.y, 'x', touchColor);
                    drawHorizontal(boxB.max.y, 'z', touchColor);
                }
            }
        }
    });

    rightScene.add(transformControl);

    // 多選用的共同樞紐 (空物件) 與整體外框
    selectionPivot = new THREE.Object3D();
    rightScene.add(selectionPivot);
    selectionHelper = new THREE.Box3Helper(new THREE.Box3(), 0x00e5ff);
    selectionHelper.material.depthTest = false;
    selectionHelper.material.transparent = true;
    selectionHelper.material.opacity = 0.6;
    selectionHelper.frustumCulled = false;
    selectionHelper.visible = false;
    rightScene.add(selectionHelper);

    // 圖片縮放錨點 (四角 + 四邊中點，共 8 個)，永遠面向相機且大小固定
    imageHandles = new THREE.Group();
    imageHandles.visible = false;
    rightScene.add(imageHandles);
    [[-1, 1], [0, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [0, -1], [1, -1]].forEach(([ax, ay]) => {
        const fill = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true })
        );
        fill.renderOrder = 999;
        fill.userData = { ax, ay };
        const border = new THREE.Mesh(
            new THREE.PlaneGeometry(1.5, 1.5),
            new THREE.MeshBasicMaterial({ color: 0x1473e6, depthTest: false, transparent: true })
        );
        border.renderOrder = 998;
        border.position.z = -0.001;
        fill.add(border);
        imageHandles.add(fill);
    });
    imageHandleMeshes = imageHandles.children;

    // 右側畫面支援直接拖入圖檔
    container.addEventListener('dragover', (e) => { e.preventDefault(); });
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        if (visitMode) return;
        if (e.dataTransfer && e.dataTransfer.files.length) {
            const files = Array.from(e.dataTransfer.files);
            const imgs = files.filter(f => f.type.startsWith('image/'));
            const vids = files.filter(f => f.type.startsWith('video/'));
            if (imgs.length) addImagesFromFiles(imgs);
            if (vids.length) addVideosFromFiles(vids);
        }
    });

    // 滑鼠移到錨點上時改變游標
    rightRenderer.domElement.addEventListener('pointermove', onHoverRightCanvas);

    // ================= 選取邏輯：Raycaster =================
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // 監聽右側畫布的點擊事件來選取零件
    rightRenderer.domElement.addEventListener('pointerdown', onPointerDownRightCanvas);
}

// --- 零件的「面」與顏色 ---
// 方塊 6 個面、圓柱 3 個面 (側面/頂面/底面)、圓球整體 1 個
const FACE_LABELS = { box: ['右', '左', '上', '下', '前', '後'], cylinder: ['側面', '頂面', '底面'], sphere: [] };
const faceCountOf = (t) => (t === 'box' ? 6 : t === 'cylinder' ? 3 : 1);
let leftFaceColors = [];
let leftFaceType = null;
let selectedFace = -1; // -1 = 全部

const materialsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]);
const disposeMaterials = (o) => materialsOf(o).forEach(m => m.dispose());

function makePartMaterial(hex) {
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.5, metalness: 0.1 });
}
// 讀取舊檔 (只有單一 color) 時，所有面都套用同一個顏色
function normalizeFaceColors(type, item) {
    const n = faceCountOf(type);
    let fc = Array.isArray(item.faceColors) ? [...item.faceColors] : [];
    if (fc.length !== n) fc = Array(n).fill(fc[0] || item.color || '#888888');
    return fc;
}
function makePartMaterials(type, faceColors) {
    const cols = normalizeFaceColors(type, { faceColors });
    return faceCountOf(type) === 1 ? makePartMaterial(cols[0]) : cols.map(makePartMaterial);
}

function syncFaceState(type) {
    if (leftFaceType === type && leftFaceColors.length === faceCountOf(type)) return;
    const base = leftFaceColors[0] || document.getElementById('part-color').value;
    leftFaceColors = Array(faceCountOf(type)).fill(base);
    selectedFace = -1;
    leftFaceType = type;
    document.getElementById('part-color').value = base;
    rebuildFaceChips(type);
}

function rebuildFaceChips(type) {
    const box = document.getElementById('face-chips');
    const labels = FACE_LABELS[type] || [];
    box.innerHTML = '';
    document.getElementById('face-chips-wrap').classList.toggle('hidden', labels.length === 0);
    document.getElementById('color-label').innerText = labels.length ? '零件顏色 (先選擇面，再修改該面顏色)' : '零件顏色 (整體)';
    if (!labels.length) return;
    const mk = (text, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'face-chip';
        b.dataset.face = idx;
        b.textContent = text;
        b.addEventListener('click', () => selectFace(idx));
        box.appendChild(b);
    };
    mk('全部', -1);
    labels.forEach((l, i) => mk(l, i));
    refreshFaceChips();
}

function refreshFaceChips() {
    document.querySelectorAll('#face-chips .face-chip').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.face) === selectedFace);
    });
}

// 預覽中被選取的面稍微發亮，方便辨識
function applyFaceHighlight() {
    if (!previewMesh || !Array.isArray(previewMesh.material)) return;
    previewMesh.material.forEach((m, i) => m.emissive.setHex(i === selectedFace ? 0x2a3a55 : 0x000000));
}

function selectFace(idx) {
    selectedFace = idx;
    document.getElementById('part-color').value = idx < 0 ? leftFaceColors[0] : leftFaceColors[idx];
    refreshFaceChips();
    applyFaceHighlight();
}

function onFaceColorInput(e) {
    const v = e.target.value;
    if (selectedFace < 0) leftFaceColors.fill(v);
    else leftFaceColors[selectedFace] = v;
    updatePreviewShape();
}

// 點擊左側預覽中的面來選取
const leftRaycaster = new THREE.Raycaster();
function pickPreviewFace(event) {
    if (!previewMesh || !leftRenderer || faceCountOf(leftFaceType) === 1) return;
    const rect = leftRenderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    leftRaycaster.setFromCamera(ndc, leftCamera);
    const hit = leftRaycaster.intersectObject(previewMesh, false)[0];
    if (hit && hit.face) selectFace(hit.face.materialIndex);
}

// --- 左側邏輯：生成與更新預覽圖形 ---
function updatePreviewShape() {
    // 移除舊預覽
    if (previewMesh) {
        leftScene.remove(previewMesh);
        previewMesh.geometry.dispose();
        disposeMaterials(previewMesh);
        // 確保同時釋放附加的子物件 (白色外框線) 的記憶體
        if (previewMesh.children.length > 0) {
            previewMesh.children.forEach(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
        }
    }

    const type = document.getElementById('shape-type').value;
    syncFaceState(type);
    let geometry;

    // 根據選擇讀取對應參數並建立幾何體
    if (type === 'box') {
        const w = parseFloat(document.getElementById('box-w').value) || 100;
        const h = parseFloat(document.getElementById('box-h').value) || 100;
        const d = parseFloat(document.getElementById('box-d').value) || 100;
        geometry = new THREE.BoxGeometry(w, h, d);
    } else if (type === 'cylinder') {
        const r = parseFloat(document.getElementById('cyl-r').value) || 50;
        const h = parseFloat(document.getElementById('cyl-h').value) || 150;
        geometry = new THREE.CylinderGeometry(r, r, h, 32);
    } else if (type === 'sphere') {
        const r = parseFloat(document.getElementById('sph-r').value) || 60;
        geometry = new THREE.SphereGeometry(r, 32, 16);
    }

    // 建立材質 (帶有選定的顏色)
    const material = makePartMaterials(type, leftFaceColors);
    
    previewMesh = new THREE.Mesh(geometry, material);

    // 儲存生成參數，用於存檔與還原重建
    previewMesh.userData = { type: type, color: leftFaceColors[0], faceColors: [...leftFaceColors], params: {} };
    if (type === 'box') {
        previewMesh.userData.params = { 
            w: parseFloat(document.getElementById('box-w').value) || 100,
            h: parseFloat(document.getElementById('box-h').value) || 100,
            d: parseFloat(document.getElementById('box-d').value) || 100
        };
    } else if (type === 'cylinder') {
        previewMesh.userData.params = { 
            r: parseFloat(document.getElementById('cyl-r').value) || 50,
            h: parseFloat(document.getElementById('cyl-h').value) || 150
        };
    } else if (type === 'sphere') {
        previewMesh.userData.params = { 
            r: parseFloat(document.getElementById('sph-r').value) || 60
        };
    }

    // 加入白色的 CAD 風格外框線
    const edges = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.3, transparent: true });
    const lineSegment = new THREE.LineSegments(edges, lineMaterial);
    previewMesh.add(lineSegment); // 將線條加為 Mesh 的子物件，移動時會一起動

    // 將預覽物件置中
    leftScene.add(previewMesh);
    applyFaceHighlight();
}

// ================= 展示模式：電影式運鏡 =================
// 流程：開場俯衝 → 組裝動畫 → 螺旋環繞 → 逐一聚焦群組 → 爆炸圖再組合 → 收尾
let showcase = null;

function smooth01(x) {
    x = Math.min(1, Math.max(0, x));
    return x * x * (3 - 2 * x);
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeOutQuart = (x) => 1 - Math.pow(1 - clamp01(x), 4);
const easeInOutSine = (x) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2;

// --- 鏡頭狀態：{ t: 注視點, az: 方位角(rad), el: 仰角(度), d: 距離 } ---
function camFromCurrent() {
    const off = rightCamera.position.clone().sub(rightControls.target);
    const d = off.length() || 1;
    return {
        t: rightControls.target.clone(),
        az: Math.atan2(off.x, off.z),
        el: Math.asin(Math.max(-1, Math.min(1, off.y / d))) * 180 / Math.PI,
        d
    };
}
function cloneCam(c) { return { t: c.t.clone(), az: c.az, el: c.el, d: c.d }; }
function mixCam(a, b, k) {
    return {
        t: a.t.clone().lerp(b.t, k),
        az: a.az + (b.az - a.az) * k,
        el: a.el + (b.el - a.el) * k,
        d: a.d + (b.d - a.d) * k
    };
}
function applyCam(c) {
    const e = c.el * Math.PI / 180;
    rightCamera.position.set(
        c.t.x + c.d * Math.cos(e) * Math.sin(c.az),
        c.t.y + c.d * Math.sin(e),
        c.t.z + c.d * Math.cos(e) * Math.cos(c.az)
    );
    rightControls.target.copy(c.t);
    rightCamera.lookAt(c.t);
}

// --- 零件透明度控制 (用於淡入淡出、聚焦時淡化其他零件) ---
function collectMats(o) {
    const list = [...materialsOf(o), ...o.children.map(c => c.material)].filter(Boolean);
    return list.map(m => ({ m, opacity: m.opacity, transparent: m.transparent }));
}
function setAlpha(o, a) {
    const infos = showcase && showcase.mats.get(o);
    if (!infos) return;
    infos.forEach(i => {
        i.m.transparent = a < 0.999 ? true : i.transparent;
        i.m.opacity = i.opacity * a;
    });
}
function easeAlpha(sc, dt, targetFn) {
    const k = 1 - Math.exp(-dt * 7);
    sc.objs.forEach(o => {
        const t = targetFn(o);
        const cur = sc.alpha.get(o);
        let n = cur + (t - cur) * k;
        if (Math.abs(t - n) < 0.01) n = t;
        if (n !== cur) { sc.alpha.set(o, n); setAlpha(o, n); }
    });
}
function setAllAlpha(sc, a) {
    sc.objs.forEach(o => { sc.alpha.set(o, a); setAlpha(o, a); });
}

function toggleShowcase() {
    if (showcase) { stopShowcase(false); return; }
    if (assembledObjects.length === 0) { flashInfo('請先加入零件再展示'); return; }
    if (transformControl.dragging || resizeState) return;

    if (editTarget) exitEditMode();
    setSelection([]); // 取消選取，畫面乾淨地展示
    document.getElementById('selection-hint').classList.add('hidden');

    const objs = [...assembledObjects];
    const sc = {
        last: performance.now(), idx: -1, segT: 0, objs,
        orig: new Map(), mats: new Map(), alpha: new Map(), centers: new Map()
    };

    // 記錄原始狀態，展示結束後完整還原
    const all = new THREE.Box3();
    objs.forEach(o => {
        o.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(o);
        all.union(b);
        sc.centers.set(o, b.getCenter(new THREE.Vector3()));
        sc.orig.set(o, { pos: o.position.clone(), quat: o.quaternion.clone() });
        sc.mats.set(o, collectMats(o));
        sc.alpha.set(o, 1);
    });

    sc.center = all.getCenter(new THREE.Vector3());
    sc.radius = Math.max(all.getSize(new THREE.Vector3()).length() / 2, 50);
    const vFov = rightCamera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * rightCamera.aspect);
    sc.minFov = Math.min(vFov, hFov);
    sc.baseDist = (sc.radius * 1.2) / Math.sin(sc.minFov / 2);
    if (rightCamera.far < sc.baseDist * 6) {
        rightCamera.far = sc.baseDist * 6;
        rightCamera.updateProjectionMatrix();
    }

    // 最外層群組 (單獨的零件自成一個單位)
    const map = new Map();
    objs.forEach(o => {
        const key = outerGroupId(o) || o.uuid;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(o);
    });
    sc.units = [...map.values()].map(members => {
        const box = new THREE.Box3();
        members.forEach(o => box.union(new THREE.Box3().setFromObject(o)));
        const size = box.getSize(new THREE.Vector3());
        return {
            members, isGroup: !!outerGroupId(members[0]),
            center: box.getCenter(new THREE.Vector3()),
            r: Math.max(size.length() / 2, 20)
        };
    });

    sc.cam = camFromCurrent();
    sc.segs = buildShowcaseSegments(sc);
    showcase = sc;

    rightControls.enabled = false;
    const btn = document.getElementById('tool-showcase');
    btn.innerText = '停止展示';
    btn.classList.add('active');
    startShowcaseSeg(0);
}

function buildShowcaseSegments(sc) {
    const segs = [];
    const PI = Math.PI;
    const C = sc.center, R = sc.radius, D = sc.baseDist;
    let c0, cEnd;

    // 1. 開場：鏡頭拉高到遠處，原本的結構淡出
    segs.push({
        dur: 1.0,
        init() {
            c0 = cloneCam(sc.cam);
            cEnd = { t: C.clone(), az: c0.az, el: 65, d: D * 1.8 };
        },
        update(u) {
            const k = smooth01(u);
            sc.cam = mixCam(c0, cEnd, k);
            setAllAlpha(sc, 1 - k);
        }
    });

    // 2. 俯衝 + 組裝：鏡頭快速俯衝推近並漸漸放慢，零件由下往上依序從空中飛入組合
    let starts = null;
    segs.push({
        dur: 8.0,
        caption: '組裝',
        init() {
            c0 = cloneCam(sc.cam);
            cEnd = { t: C.clone(), az: c0.az + 1.2, el: 50, d: D };
            const sorted = [...sc.objs].sort((a, b) => sc.centers.get(a).y - sc.centers.get(b).y);
            const n = sorted.length;
            starts = new Map();
            sorted.forEach((o, i) => {
                const orig = sc.orig.get(o);
                const outward = orig.pos.clone().sub(C); outward.y = 0;
                if (outward.lengthSq() > 1e-6) outward.normalize();
                const startPos = orig.pos.clone()
                    .add(new THREE.Vector3(0, R * 2.0, 0))
                    .add(outward.multiplyScalar(R * 0.5));
                const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i % 2 ? 1 : -1) * PI * 0.75);
                starts.set(o, {
                    pos: startPos,
                    quat: orig.quat.clone().multiply(spin),
                    delay: n > 1 ? (i / (n - 1)) * 0.5 : 0
                });
            });
        },
        update(u) {
            sc.cam = mixCam(c0, cEnd, easeOutCubic(u));
            sc.objs.forEach(o => {
                const st = starts.get(o), orig = sc.orig.get(o);
                const lt = clamp01((u - st.delay) / 0.45);
                const e = easeOutQuart(lt);
                o.position.copy(st.pos).lerp(orig.pos, e);
                o.quaternion.copy(st.quat).slerp(orig.quat, e);
                const a = smooth01(lt / 0.2);
                sc.alpha.set(o, a); setAlpha(o, a);
            });
        },
        end() {
            sc.objs.forEach(o => {
                const orig = sc.orig.get(o);
                o.position.copy(orig.pos); o.quaternion.copy(orig.quat);
            });
            setAllAlpha(sc, 1);
        }
    });

    // 3. 螺旋環繞：邊繞一圈，邊從俯視下降到平視並微微拉近
    segs.push({
        dur: 9.0,
        caption: '環繞',
        init() {
            c0 = cloneCam(sc.cam);
            cEnd = { t: C.clone(), az: c0.az + 2 * PI, el: 10, d: D * 0.85 };
        },
        update(u) { sc.cam = mixCam(c0, cEnd, easeInOutSine(u)); }
    });

    // 4. 逐一聚焦群組：飛到群組旁輕輕環繞，其他零件淡化
    const focus = sc.units.filter(x => x.isGroup).sort((a, b) => b.r - a.r).slice(0, 6);
    focus.forEach((f, i) => {
        const set = new Set(f.members);
        const dist = Math.max(120, (f.r * 1.4) / Math.sin(sc.minFov / 2));
        let arrive;
        segs.push({
            dur: 2.8,
            caption: `聚焦群組 ${i + 1} / ${focus.length}`,
            init() {
                c0 = cloneCam(sc.cam);
                arrive = { t: f.center.clone(), az: c0.az + 0.4, el: 18, d: dist };
            },
            update(u, dt) {
                if (u < 0.4) {
                    sc.cam = mixCam(c0, arrive, smooth01(u / 0.4));
                } else {
                    sc.cam = cloneCam(arrive);
                    sc.cam.az += 0.7 * smooth01((u - 0.4) / 0.6);
                }
                easeAlpha(sc, dt, o => set.has(o) ? 1 : 0.12);
            }
        });
    });

    // 5. 爆炸圖：各群組(或單獨零件)向外散開、停一下，再慢慢收回
    if (sc.units.length >= 2) {
        let offsets;
        segs.push({
            dur: 7.0,
            caption: '爆炸圖',
            init() {
                c0 = cloneCam(sc.cam);
                cEnd = { t: C.clone(), az: c0.az, el: 28, d: D * 1.45 };
                offsets = sc.units.map((un, i) => {
                    const dir = un.center.clone().sub(C); dir.y *= 0.5;
                    if (dir.length() < R * 0.02) {
                        const ang = (i / sc.units.length) * 2 * PI;
                        dir.set(Math.cos(ang), 0.3, Math.sin(ang));
                    }
                    return dir.normalize().multiplyScalar(R * 0.85).add(new THREE.Vector3(0, R * 0.1, 0));
                });
            },
            update(u, dt) {
                const cam = mixCam(c0, cEnd, smooth01(u / 0.3));
                cam.az += 1.4 * easeInOutSine(u);
                sc.cam = cam;
                let e;
                if (u < 0.3) e = easeOutCubic(u / 0.3);
                else if (u < 0.55) e = 1;
                else e = 1 - easeInOutSine((u - 0.55) / 0.45);
                sc.units.forEach((un, i) => {
                    un.members.forEach(o => {
                        const orig = sc.orig.get(o);
                        o.position.copy(orig.pos).addScaledVector(offsets[i], e);
                    });
                });
                easeAlpha(sc, dt, () => 1);
            },
            end() {
                sc.objs.forEach(o => o.position.copy(sc.orig.get(o).pos));
                setAllAlpha(sc, 1);
            }
        });
    }

    // 6. 收尾：拉回最佳斜視角，慢慢減速後停住
    segs.push({
        dur: 3.5,
        caption: '完成',
        init() {
            c0 = cloneCam(sc.cam);
            cEnd = { t: C.clone(), az: c0.az + 0.5, el: 33, d: D };
        },
        update(u, dt) {
            sc.cam = mixCam(c0, cEnd, easeOutCubic(u));
            easeAlpha(sc, dt, () => 1);
        }
    });

    return segs;
}

function startShowcaseSeg(i) {
    const sc = showcase;
    sc.idx = i;
    sc.segT = 0;
    const seg = sc.segs[i];
    seg.init();
    if (seg.caption) flashInfo(seg.caption);
}

function updateShowcase() {
    if (!showcase) return;
    const sc = showcase;
    const now = performance.now();
    const dt = Math.min(0.05, (now - sc.last) / 1000);
    sc.last = now;

    const seg = sc.segs[sc.idx];
    sc.segT += dt;
    const u = Math.min(1, sc.segT / seg.dur);
    seg.update(u, dt);
    applyCam(sc.cam);

    if (u >= 1) {
        if (seg.end) seg.end();
        if (sc.idx + 1 < sc.segs.length) startShowcaseSeg(sc.idx + 1);
        else stopShowcase(true);
    }
}

function stopShowcase(finished) {
    if (!showcase) return;
    const sc = showcase;
    showcase = null;

    // 還原每個零件的位置、角度與透明度
    sc.objs.forEach(o => {
        if (!assembledObjects.includes(o)) return;
        const orig = sc.orig.get(o);
        o.position.copy(orig.pos);
        o.quaternion.copy(orig.quat);
        sc.mats.get(o).forEach(i => { i.m.opacity = i.opacity; i.m.transparent = i.transparent; });
    });

    rightControls.target.copy(sc.cam.t);
    rightControls.enabled = true;
    rightControls.update();
    const btn = document.getElementById('tool-showcase');
    btn.innerText = '展示';
    btn.classList.remove('active');
    setSelection([]); // 恢復「尚未選取」提示
    if (finished) flashInfo('展示結束');
}

// ================= 框選模式 =================
let boxSelectMode = false;
let boxSelect = null;
const defaultCursor = () => (boxSelectMode ? 'crosshair' : '');

function setBoxSelectMode(on) {
    boxSelectMode = on;
    document.getElementById('tool-box-select').classList.toggle('active', on);
    // 框選時左鍵用來畫範圍，視角改用右鍵旋轉、中鍵平移 (滾輪縮放不變)
    rightControls.mouseButtons = on
        ? { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    rightRenderer.domElement.style.cursor = defaultCursor();
    if (on) flashInfo('框選模式：拖曳畫面選取物件，Shift 可加選');
    else cancelBoxSelect();
}

function beginBoxSelect(event) {
    boxSelect = { sx: event.clientX, sy: event.clientY, ev: event, moved: false };
    window.addEventListener('pointermove', onBoxSelectMove);
    window.addEventListener('pointerup', onBoxSelectEnd);
    window.addEventListener('pointercancel', cancelBoxSelect);
}

function onBoxSelectMove(e) {
    if (!boxSelect) return;
    const dx = e.clientX - boxSelect.sx, dy = e.clientY - boxSelect.sy;
    if (!boxSelect.moved && Math.hypot(dx, dy) < 4) return; // 移動太少視為點擊
    boxSelect.moved = true;

    const rect = document.getElementById('right-canvas-container').getBoundingClientRect();
    const el = document.getElementById('box-select-rect');
    const x1 = Math.min(boxSelect.sx, e.clientX) - rect.left;
    const y1 = Math.min(boxSelect.sy, e.clientY) - rect.top;
    el.style.left = x1 + 'px';
    el.style.top = y1 + 'px';
    el.style.width = Math.abs(dx) + 'px';
    el.style.height = Math.abs(dy) + 'px';
    // 由右往左 = 碰到就選 (虛線、綠色)；由左往右 = 完全框住才選 (實線、青色)
    const crossing = e.clientX < boxSelect.sx;
    el.style.borderStyle = crossing ? 'dashed' : 'solid';
    el.style.borderColor = crossing ? '#86efac' : '#67e8f9';
    el.style.background = crossing ? 'rgba(134,239,172,0.12)' : 'rgba(0,229,255,0.12)';
    el.classList.remove('hidden');
}

function onBoxSelectEnd(e) {
    const st = boxSelect;
    if (!st) return;
    cancelBoxSelect();
    if (!st.moved) {
        clickSelect(st.ev); // 沒有拖曳：一般點選
        return;
    }
    selectInScreenRect(st.sx, st.sy, e.clientX, e.clientY, e.clientX < st.sx, e.shiftKey);
}

function cancelBoxSelect() {
    boxSelect = null;
    document.getElementById('box-select-rect').classList.add('hidden');
    window.removeEventListener('pointermove', onBoxSelectMove);
    window.removeEventListener('pointerup', onBoxSelectEnd);
    window.removeEventListener('pointercancel', cancelBoxSelect);
}

// 依螢幕上的矩形範圍選取零件 (以零件的外框投影到螢幕後比對)
function selectInScreenRect(x1, y1, x2, y2, crossing, additive) {
    const rect = document.getElementById('right-canvas-container').getBoundingClientRect();
    const minX = Math.min(x1, x2) - rect.left, maxX = Math.max(x1, x2) - rect.left;
    const minY = Math.min(y1, y2) - rect.top,  maxY = Math.max(y1, y2) - rect.top;

    rightCamera.updateMatrixWorld();
    const v = new THREE.Vector3();
    const found = [];

    assembledObjects.forEach(o => {
        o.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(o);
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, valid = 0;
        for (let i = 0; i < 8; i++) {
            v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
            // 在相機後方的角落無法正確投影，略過
            const camZ = v.clone().applyMatrix4(rightCamera.matrixWorldInverse).z;
            if (camZ > -rightCamera.near) continue;
            v.project(rightCamera);
            const px = (v.x * 0.5 + 0.5) * rect.width;
            const py = (-v.y * 0.5 + 0.5) * rect.height;
            bx0 = Math.min(bx0, px); bx1 = Math.max(bx1, px);
            by0 = Math.min(by0, py); by1 = Math.max(by1, py);
            valid++;
        }
        if (valid === 0) return;
        const hit = crossing
            ? (bx0 <= maxX && bx1 >= minX && by0 <= maxY && by1 >= minY)
            : (bx0 >= minX && bx1 <= maxX && by0 >= minY && by1 <= maxY);
        if (hit) found.push(o);
    });

    // 屬於群組的零件，整組一起選取
    const set = new Set();
    found.forEach(o => getGroupMembers(o).forEach(m => set.add(m)));
    if (additive) selectedObjects.forEach(o => set.add(o));
    setSelection([...set]);
    if (set.size > 0) document.getElementById('right-canvas-container').focus();
}

// ================= 參觀模式 =================
let visitMode = false;

function enterVisitMode() {
    if (showcase) stopShowcase(false);
    exitEditMode();
    if (boxSelectMode) setBoxSelectMode(false);
    cancelBoxSelect();
    setSelection([]);
    visitMode = true;
    document.body.classList.add('visit-mode');
    window.dispatchEvent(new Event('resize'));
}

function exitVisitMode() {
    visitMode = false;
    document.body.classList.remove('visit-mode');
    setSelection([]);
    window.dispatchEvent(new Event('resize'));
}

// ================= 全螢幕 =================
function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
    if (!isFullscreen()) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!req) { flashInfo('此瀏覽器不支援全螢幕'); return; }
        Promise.resolve(req.call(el)).catch(() => {
            flashInfo('無法進入全螢幕 (若頁面嵌在其他網站內，請改用獨立網址開啟)');
        });
    } else {
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) ex.call(document);
    }
}

function updateFullscreenButton() {
    const btn = document.getElementById('btn-fullscreen');
    if (!btn) return;
    btn.innerText = isFullscreen() ? '退出全螢幕' : '全螢幕';
    if (isFullscreen()) flashInfo('按 F 或 Esc 可退出全螢幕');
}

// ================= 回左側編輯 =================
let editTarget = null; // 目前送回左側編輯的右側零件

function enterEditMode() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length !== 1) {
        flashInfo('請先選取「一個」零件，再按回左側編輯');
        return;
    }
    const m = selectedObjects[0];
    if (isPlaneType(m)) {
        flashInfo('圖片／影片請直接拖曳 8 個錨點縮放');
        return;
    }
    if (editTarget) exitEditMode();
    editTarget = m;

    // 把零件的形狀、尺寸、顏色帶回左側表單
    const u = m.userData, p = u.params || {};
    document.getElementById('shape-type').value = u.type;
    ['box', 'cylinder', 'sphere'].forEach(t => {
        document.getElementById('param-' + t).classList.toggle('hidden', t !== u.type);
    });
    if (u.type === 'box') {
        document.getElementById('box-w').value = p.w;
        document.getElementById('box-h').value = p.h;
        document.getElementById('box-d').value = p.d;
    } else if (u.type === 'cylinder') {
        document.getElementById('cyl-r').value = p.r;
        document.getElementById('cyl-h').value = p.h;
    } else if (u.type === 'sphere') {
        document.getElementById('sph-r').value = p.r;
    }
    const fc = normalizeFaceColors(u.type, u);
    leftFaceColors = fc;
    leftFaceType = u.type;
    selectedFace = -1;
    rebuildFaceChips(u.type);
    document.getElementById('part-color').value = fc[0];
    updatePreviewShape();

    // 右側的原零件變半透明，表示正在編輯中
    materialsOf(m).forEach(mt => { mt.transparent = true; mt.opacity = 0.35; });

    document.getElementById('add-to-assembly-btn').innerText = '套用修改至右側零件 ⭢';
    document.getElementById('cancel-edit-btn').classList.remove('hidden');
    document.getElementById('edit-banner').classList.remove('hidden');

    // 左側面板若收合則展開
    if (document.getElementById('left-sidebar').classList.contains('ml-[-380px]')) {
        document.getElementById('toggle-sidebar').click();
    }
}

function exitEditMode() {
    if (editTarget) {
        materialsOf(editTarget).forEach(mt => { mt.transparent = false; mt.opacity = 1; });
        editTarget = null;
    }
    document.getElementById('add-to-assembly-btn').innerText = '加入右方組裝視窗 ⭢';
    document.getElementById('cancel-edit-btn').classList.add('hidden');
    document.getElementById('edit-banner').classList.add('hidden');
}

// 把左側修改後的外觀套用回右側零件 (位置、角度、群組都保留)
function applyEditToTarget() {
    if (!editTarget || !previewMesh) return;
    const m = editTarget;

    const newGeo = previewMesh.geometry.clone();
    m.geometry.dispose();
    m.geometry = newGeo;

    m.children.filter(c => c.isLineSegments).forEach(c => {
        m.remove(c);
        c.geometry.dispose();
        c.material.dispose();
    });
    m.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(newGeo),
        new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true })
    ));

    disposeMaterials(m);
    m.material = makePartMaterials(previewMesh.userData.type, previewMesh.userData.faceColors);

    const gids = m.userData.groupIds || [];
    m.userData = JSON.parse(JSON.stringify(previewMesh.userData));
    m.userData.isAssemblyPart = true;
    m.userData.groupIds = gids;

    exitEditMode();
    setSelection([m]);
    commitHistory();
}

// ================= 上一步 / 下一步 (歷史紀錄) =================
const undoStack = [];
const redoStack = [];
let isRestoring = false;
const HISTORY_LIMIT = 100;

function commitHistory() {
    if (isRestoring) return;
    const snap = JSON.stringify(collectParts());
    const top = undoStack[undoStack.length - 1];
    if (top && top.snap === snap) return; // 沒有實際變化就不記錄
    undoStack.push({ snap, sel: selectedObjects.map(o => assembledObjects.indexOf(o)) });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
}

function resetHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    commitHistory();
    updateHistoryButtons();
}

function updateHistoryButtons() {
    const u = document.getElementById('tool-undo');
    const r = document.getElementById('tool-redo');
    if (u) u.disabled = undoStack.length < 2;
    if (r) r.disabled = redoStack.length === 0;
}

function restoreHistory(entry) {
    isRestoring = true;
    try {
        exitEditMode();
        clearAllParts();
        buildParts(JSON.parse(entry.snap));
        setSelection(entry.sel.map(i => assembledObjects[i]).filter(Boolean));
    } finally {
        isRestoring = false;
    }
    updateHistoryButtons();
}

function undoHistory() {
    if (transformControl.dragging || resizeState || showcase) return;
    if (undoStack.length < 2) return;
    redoStack.push(undoStack.pop());
    restoreHistory(undoStack[undoStack.length - 1]);
}

function redoHistory() {
    if (transformControl.dragging || resizeState || showcase) return;
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(next);
    restoreHistory(next);
}

// --- 核心動作：將左側預覽加入到右側組裝區 ---
function addToAssembly() {
    if (showcase) stopShowcase(false);
    if (!previewMesh) return;

    // 複製幾何體與材質，確保每個零件獨立
    const newGeo = previewMesh.geometry.clone();
    const newMat = makePartMaterials(previewMesh.userData.type, previewMesh.userData.faceColors);
    const newMesh = new THREE.Mesh(newGeo, newMat);

    // 同樣複製外框線
    const edges = new THREE.EdgesGeometry(newGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true });
    const newLines = new THREE.LineSegments(edges, lineMat);
    newMesh.add(newLines);

    // 將新零件放置在右側場景的原點上方，提示使用者剛加入
    newMesh.position.set(0, 100, 0); 
    
    // 給予自訂屬性以便識別與存檔
    newMesh.userData = JSON.parse(JSON.stringify(previewMesh.userData));
    newMesh.userData.isAssemblyPart = true;

    rightScene.add(newMesh);
    assembledObjects.push(newMesh);

    // 加入後自動選取它，方便直接開始移動
    selectObject(newMesh);
    commitHistory();
    
    // 讓右側畫布取得焦點，方便接收鍵盤快捷鍵
    document.getElementById('right-canvas-container').focus();
}

// --- 右側互動邏輯：點選與選取 (Shift+點選可多選) ---
function onPointerDownRightCanvas(event) {
    if (visitMode) return; // 參觀模式：只能移動視角，不做任何選取
    // 展示中點擊畫面：先中止展示 (這次點擊不做選取)
    if (showcase) { stopShowcase(false); return; }

    // 確保是在右側容器內點擊
    const container = document.getElementById('right-canvas-container');
    const rect = container.getBoundingClientRect();
    
    // 計算正規化設備坐標 (NDC)
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, rightCamera);

    // 優先判斷是否按到圖片的縮放錨點
    if (!transformControl.dragging && imageHandles.visible) {
        const hh = raycaster.intersectObjects(imageHandleMeshes, false);
        if (hh.length > 0) {
            beginImageResize(hh[0].object, event);
            return;
        }
    }

    // 框選模式：左鍵拖曳畫出選取範圍；沒有拖曳(單純點擊)則仍是一般點選
    if (boxSelectMode && event.button === 0 && !transformControl.dragging) {
        beginBoxSelect(event);
        return;
    }
    clickSelect(event);
}

function clickSelect(event) {
    setMouseFromEvent(event);
    raycaster.setFromCamera(mouse, rightCamera);

    // 只與已加入的零件做射線檢測
    const intersects = raycaster.intersectObjects(assembledObjects, false);

    if (intersects.length > 0) {
        // 如果點擊到 TransformControls 的軸，不要觸發重新選取
        if (transformControl.dragging) return;

        const hit = intersects[0].object;
        const targets = getGroupMembers(hit); // 若屬於群組，整組一起處理

        if (event.shiftKey) {
            // Shift+點選：加入 / 移除選取
            if (selectedObjects.includes(hit)) {
                setSelection(selectedObjects.filter(o => !targets.includes(o)));
            } else {
                setSelection([...selectedObjects, ...targets.filter(o => !selectedObjects.includes(o))]);
            }
        } else {
            setSelection(targets);
        }
    } else {
        // 點擊空白處取消選取 (按著 Shift 時不取消，避免多選時點歪而全部取消)
        if (!transformControl.dragging && !event.shiftKey) {
            setSelection([]);
        }
    }
}

// 取得某零件所屬群組的全部成員 (沒有群組則只有自己)
// 群組可以層層疊加：groupIds 由內到外排列，點選時以「最外層」群組為準
function outerGroupId(o) {
    const ids = o.userData.groupIds;
    return ids && ids.length ? ids[ids.length - 1] : null;
}

function getGroupMembers(mesh) {
    const gid = outerGroupId(mesh);
    if (!gid) return [mesh];
    return assembledObjects.filter(o => (o.userData.groupIds || []).includes(gid));
}

function newGroupId() {
    return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 選取範圍的整體包圍盒 (世界座標)
function getSelectionBox() {
    const box = new THREE.Box3();
    selectedObjects.forEach(o => {
        o.updateWorldMatrix(true, false);
        box.union(new THREE.Box3().setFromObject(o));
    });
    return box;
}

// 把樞紐放到選取範圍中心，並歸零旋轉 (多選時控制軸綁在樞紐上)
function positionPivot() {
    const center = new THREE.Vector3();
    getSelectionBox().getCenter(center);
    selectionPivot.position.copy(center);
    selectionPivot.quaternion.identity();
    selectionPivot.scale.set(1, 1, 1);
    selectionPivot.updateMatrixWorld(true);
}

// 開始拖曳控制軸：多選時把所有零件掛到樞紐下，才會「整批一起轉」而不是各自轉
function beginGroupDrag() {
    if (selectedObjects.length < 2) return;
    selectionPivot.updateMatrixWorld(true);
    selectedObjects.forEach(o => selectionPivot.attach(o)); // attach 會保留世界座標
}

// 結束拖曳：把零件放回場景並保留目前的世界座標，再重設樞紐
function endGroupDrag() {
    if (selectionPivot.children.length > 0) {
        selectionPivot.updateMatrixWorld(true);
        [...selectionPivot.children].forEach(o => rightScene.attach(o));
    }
    if (selectedObjects.length > 1) positionPivot();
}

function setSelection(list) {
    // 若正在拖曳中途被改變選取，先把零件放回場景
    endGroupDrag();

    selectedObjects = list.filter((o, i) => list.indexOf(o) === i);

    // 更新每個零件的選取高光
    assembledObjects.forEach(o => setHighlight(o, selectedObjects.includes(o)));

    // 清除碰撞線與對齊線
    if (collisionBox) collisionBox.visible = false;
    if (alignmentLinesGroup) {
        while (alignmentLinesGroup.children.length > 0) {
            const child = alignmentLinesGroup.children[0];
            alignmentLinesGroup.remove(child);
            child.geometry.dispose();
            child.material.dispose();
        }
    }

    const hint = document.getElementById('selection-hint');
    if (selectedObjects.length === 0) {
        transformControl.detach();
        hint.classList.remove('hidden');
    } else {
        hint.classList.add('hidden');
        if (selectedObjects.length === 1) {
            transformControl.attach(selectedObjects[0]);
        } else {
            positionPivot();
            transformControl.attach(selectionPivot);
        }
    }
    refreshSelectionInfo();
}

function selectObject(mesh) { setSelection([mesh]); }
function deselectObject() { setSelection([]); }

function refreshSelectionInfo() {
    const info = document.getElementById('selection-info');
    if (selectedObjects.length < 2) {
        info.classList.add('hidden');
        return;
    }
    const gids = new Set(selectedObjects.map(outerGroupId).filter(Boolean));
    info.innerText = `已選取 ${selectedObjects.length} 個零件` + (gids.size > 0 ? `（含 ${gids.size} 個群組）` : '');
    info.classList.remove('hidden');
}

function flashInfo(msg) {
    const info = document.getElementById('selection-info');
    info.innerText = msg;
    info.classList.remove('hidden');
    setTimeout(refreshSelectionInfo, 1800);
}

// --- 群組功能 ---
function createGroup() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length < 2) {
        flashInfo('請先按住 Shift 點選 2 個以上的零件');
        return;
    }
    // 目前選取內有幾個「最外層」群組 / 單獨零件
    const outers = new Set(selectedObjects.map(o => outerGroupId(o) || ('solo_' + o.uuid)));
    if (outers.size === 1 && outerGroupId(selectedObjects[0])) {
        flashInfo('選取的已經是同一個群組');
        return;
    }
    // 在原有群組之上再包一層，內層群組完整保留
    const gid = newGroupId();
    selectedObjects.forEach(o => {
        o.userData.groupIds = [...(o.userData.groupIds || []), gid];
    });
    commitHistory();
    refreshSelectionInfo();
    flashInfo(`已建立群組（包含 ${outers.size} 個項目、共 ${selectedObjects.length} 個零件）`);
}

// 解散群組：每次只解散「最外層」的那一層，內層的小群組保留
function ungroupSelected() {
    if (showcase) stopShowcase(false);
    const hasGroup = selectedObjects.some(o => outerGroupId(o));
    if (!hasGroup) {
        flashInfo('選取的零件沒有群組');
        return;
    }
    const outers = new Set(selectedObjects.map(outerGroupId).filter(Boolean));
    selectedObjects.forEach(o => {
        if (o.userData.groupIds && o.userData.groupIds.length) o.userData.groupIds.pop();
    });
    commitHistory();
    refreshSelectionInfo();
    flashInfo(`已解散 ${outers.size} 個群組（內層群組保留）`);
}

// --- 工具列對齊功能實作 ---
function snapToFloor() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length === 0) {
        alertHint(); return;
    }
    // 以整個選取範圍的最低點貼齊 Y=0 基準面 (多選時保持彼此相對位置)
    const lowestY = getSelectionBox().min.y;
    selectedObjects.forEach(o => { o.position.y -= lowestY; });
    if (selectedObjects.length > 1) positionPivot();
    commitHistory();
}

function centerObject() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length === 0) {
        alertHint(); return;
    }
    if (selectedObjects.length === 1) {
        // 將 X 和 Z 歸零，Y 保持不變
        selectedObjects[0].position.x = 0;
        selectedObjects[0].position.z = 0;
    } else {
        // 多選：讓整體中心移到場景中心 (保持彼此相對位置)
        const c = new THREE.Vector3();
        getSelectionBox().getCenter(c);
        selectedObjects.forEach(o => { o.position.x -= c.x; o.position.z -= c.z; });
        positionPivot();
    }
    commitHistory();
}

// 複製單一零件 (原位複製，位置與角度完全相同)
function cloneAssemblyMesh(src) {
    // 以世界座標原位複製
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    src.updateWorldMatrix(true, false);
    src.matrixWorld.decompose(pos, quat, scl);

    let newMesh;
    if (src.userData.type === 'image') {
        newMesh = createImageMesh(src.userData.imageId, scl.x, scl.y);
        newMesh.userData.groupIds = [...(src.userData.groupIds || [])];
    } else if (src.userData.type === 'video') {
        newMesh = createVideoMesh(src.userData.videoId, scl.x, scl.y, src.userData.fileName);
        newMesh.userData.groupIds = [...(src.userData.groupIds || [])];
    } else {
        const newGeo = src.geometry.clone();
        const cloneMat = (m) => {
            const c = m.clone();
            c.emissive.setHex(0x000000); // 避免把選取高光也複製過去
            c.transparent = false; c.opacity = 1; // 避免複製到「編輯中」的半透明狀態
            return c;
        };
        const newMat = Array.isArray(src.material) ? src.material.map(cloneMat) : cloneMat(src.material);
        newMesh = new THREE.Mesh(newGeo, newMat);

        const edges = new THREE.EdgesGeometry(newGeo);
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true });
        newMesh.add(new THREE.LineSegments(edges, lineMat));

        newMesh.userData = JSON.parse(JSON.stringify(src.userData));
        newMesh.userData.isAssemblyPart = true;
    }

    newMesh.position.copy(pos);
    newMesh.quaternion.copy(quat);

    rightScene.add(newMesh);
    assembledObjects.push(newMesh);
    return newMesh;
}

// 選取高光：一般零件用發光，圖片改用外框變色
function setHighlight(o, on) {
    if (isPlaneType(o)) {
        const line = o.children.find(c => c.isLineSegments);
        if (line) line.material.color.setHex(on ? 0x00e5ff : 0x888888);
    } else {
        materialsOf(o).forEach(m => m.emissive.setHex(on ? 0x222222 : 0x000000));
    }
}

// ================= 圖片功能 =================
function registerImage(id, dataURL) {
    const texture = new THREE.TextureLoader().load(dataURL);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = rightRenderer.capabilities.getMaxAnisotropy();
    imageStore[id] = { dataURL, texture };
}

// 建立平面物件 (圖片 / 影片共用)：單位平面 1x1，以 scale 表示寬高，不加入場景
function createPlaneMesh(material, w, h) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.set(w, h, 1);

    // 外框 (選取時變青色)
    const pts = [-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0,
                 0.5, -0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 0, -0.5, 0.5, 0];
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    mesh.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x888888 })));
    return mesh;
}

// 圖片與影片都是可縮放的平面
const isPlaneType = (o) => o.userData.type === 'image' || o.userData.type === 'video';

function createImageMesh(imageId, w, h) {
    const entry = imageStore[imageId];
    const mat = new THREE.MeshBasicMaterial({
        map: entry.texture, transparent: true, side: THREE.DoubleSide, toneMapped: false
    });
    const mesh = createPlaneMesh(mat, w, h);
    mesh.userData = { isAssemblyPart: true, type: 'image', imageId, groupIds: [] };
    return mesh;
}

// ================= 影片功能 (影片檔不存進專案，只存位置與大小) =================
const videoStore = {}; // videoId -> { video, texture, url, fileName, wantPlay }

function makeVideoPlaceholderTexture(fileName) {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    g.fillStyle = '#1f1f1f'; g.fillRect(0, 0, 640, 360);
    g.strokeStyle = '#666'; g.setLineDash([14, 10]); g.lineWidth = 4;
    g.strokeRect(10, 10, 620, 340);
    g.textAlign = 'center'; g.fillStyle = '#ddd';
    g.font = 'bold 44px sans-serif'; g.fillText('影片尚未載入', 320, 150);
    g.font = '26px sans-serif'; g.fillStyle = '#aaa';
    const name = fileName && fileName.length > 28 ? fileName.slice(0, 27) + '…' : (fileName || '');
    g.fillText(name, 320, 200);
    g.font = '22px sans-serif'; g.fillStyle = '#7aa7ff';
    g.fillText('選取此框後按「重新連結影片」', 320, 260);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

// 建立影片物件；videoId 不存在時顯示「影片尚未載入」的佔位畫面
function createVideoMesh(videoId, w, h, fileName) {
    const entry = videoId ? videoStore[videoId] : null;
    const mat = new THREE.MeshBasicMaterial({
        map: entry ? entry.texture : makeVideoPlaceholderTexture(fileName),
        side: THREE.DoubleSide, toneMapped: false
    });
    const mesh = createPlaneMesh(mat, w, h);
    mesh.userData = {
        isAssemblyPart: true, type: 'video',
        videoId: entry ? videoId : null,
        fileName: fileName || (entry ? entry.fileName : ''),
        groupIds: []
    };
    return mesh;
}

function loadVideoFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = !videoSoundOn; // 預設靜音；聲音開啟時，新影片也會有聲音
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.preload = 'auto';
        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('此瀏覽器無法播放這個影片格式'));
        };
        video.onloadedmetadata = () => {
            const texture = new THREE.VideoTexture(video);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            const id = 'vid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            videoStore[id] = { video, texture, url, fileName: file.name, wantPlay: true };
            video.play().catch(() => {
                // 瀏覽器不允許有聲自動播放時，退回靜音播放並更新按鈕
                if (!video.muted) { video.muted = true; videoSoundOn = false; updateVideoSoundButton(); }
                video.play().catch(() => {});
            });
            resolve({ id, w: video.videoWidth || 640, h: video.videoHeight || 360 });
        };
        video.src = url;
    });
}

async function addVideosFromFiles(files) {
    if (showcase) stopShowcase(false);
    let last = null;
    for (const file of Array.from(files)) {
        if (!file.type.startsWith('video/')) continue;
        try {
            const { id, w, h } = await loadVideoFile(file);
            const k = 240 / Math.max(w, h); // 預設長邊 240 單位，保持影片比例
            const mesh = createVideoMesh(id, w * k, h * k, file.name);
            mesh.position.set(0, (h * k) / 2, 0);
            rightScene.add(mesh);
            assembledObjects.push(mesh);
            last = mesh;
        } catch (err) {
            console.error('影片載入失敗:', err);
            flashInfo('影片無法播放：' + file.name);
        }
    }
    if (last) {
        setSelection([last]);
        commitHistory();
        document.getElementById('right-canvas-container').focus();
    }
}

// 把影片連結到既有的影片框 (用於重新開啟專案後補回影片)
async function relinkVideoFile(file) {
    if (!file) return;
    const target = selectedObjects.length === 1 && selectedObjects[0].userData.type === 'video' ? selectedObjects[0] : null;
    if (!target) { flashInfo('請先選取一個影片框'); return; }
    try {
        const { id } = await loadVideoFile(file);
        const oldName = target.userData.fileName;
        const wasPlaceholder = !target.userData.videoId;
        const link = (m) => {
            if (m.material.map && !m.userData.videoId) m.material.map.dispose(); // 釋放佔位畫面
            m.material.map = videoStore[id].texture;
            m.material.needsUpdate = true;
            m.userData.videoId = id;
            m.userData.fileName = file.name;
        };
        link(target);
        // 同樣檔名、尚未載入的其他影片框，一併連結
        if (wasPlaceholder) {
            assembledObjects.forEach(o => {
                if (o !== target && o.userData.type === 'video' && !o.userData.videoId && o.userData.fileName === oldName) link(o);
            });
        }
        commitHistory();
        flashInfo('影片已連結');
    } catch (err) {
        console.error(err);
        flashInfo('影片無法播放：' + file.name);
    }
}

function targetVideoEntries() {
    let list = selectedObjects.filter(o => o.userData.type === 'video' && o.userData.videoId);
    if (list.length === 0) list = assembledObjects.filter(o => o.userData.type === 'video' && o.userData.videoId);
    return [...new Set(list.map(o => videoStore[o.userData.videoId]))].filter(Boolean);
}

function toggleVideoPlay() {
    const entries = targetVideoEntries();
    if (entries.length === 0) { flashInfo('沒有可控制的影片'); return; }
    const anyPlaying = entries.some(e => !e.video.paused);
    entries.forEach(e => {
        e.wantPlay = !anyPlaying;
        if (e.wantPlay) e.video.play().catch(() => {}); else e.video.pause();
    });
    flashInfo(anyPlaying ? '影片已暫停' : '影片播放中');
}

// 影片聲音：全域開關，預設為關閉 (靜音)
let videoSoundOn = false;
function updateVideoSoundButton() {
    const btn = document.getElementById('tool-video-mute');
    if (btn) btn.innerText = videoSoundOn ? '影片聲音(開)' : '影片聲音(關)';
}
function toggleVideoSound() {
    videoSoundOn = !videoSoundOn;
    Object.values(videoStore).forEach(e => { e.video.muted = !videoSoundOn; });
    updateVideoSoundButton();
}

// 沒有任何物件使用的影片自動暫停，節省效能；復原操作把它找回來時再繼續播放
let videoSyncTick = 0;
function syncVideoPlayback() {
    if (++videoSyncTick % 30 !== 0) return;
    Object.entries(videoStore).forEach(([id, e]) => {
        const used = assembledObjects.some(o => o.userData.videoId === id);
        if (!used) { if (!e.video.paused) e.video.pause(); }
        else if (e.wantPlay && e.video.paused) e.video.play().catch(() => {});
    });
}

function disposeAllVideos() {
    Object.values(videoStore).forEach(e => {
        e.video.pause();
        e.video.removeAttribute('src');
        e.video.load();
        URL.revokeObjectURL(e.url);
        e.texture.dispose();
    });
    Object.keys(videoStore).forEach(k => delete videoStore[k]);
}

function processImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('無法解析圖片'));
            img.onload = () => {
                const MAX = 2048; // 過大的圖片縮小，避免專案檔與記憶體過大
                let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
                const k = Math.min(1, MAX / Math.max(w, h));
                const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
                const canvas = document.createElement('canvas');
                canvas.width = cw; canvas.height = ch;
                canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
                const keepAlpha = /png|gif|webp|svg/.test(file.type);
                const dataURL = keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
                resolve({ dataURL, w: cw, h: ch });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function addImagesFromFiles(files) {
    if (showcase) stopShowcase(false);
    let last = null;
    for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        try {
            const { dataURL, w, h } = await processImageFile(file);
            const id = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            registerImage(id, dataURL);
            // 預設長邊 200 單位，保持原圖比例
            const k = 200 / Math.max(w, h);
            const mesh = createImageMesh(id, w * k, h * k);
            mesh.position.set(0, (h * k) / 2, 0);
            rightScene.add(mesh);
            assembledObjects.push(mesh);
            last = mesh;
        } catch (err) {
            console.error('圖片載入失敗:', err);
            flashInfo('圖片讀取失敗：' + file.name);
        }
    }
    if (last) {
        setSelection([last]);
        commitHistory();
        document.getElementById('right-canvas-container').focus();
    }
}

// 每一幀更新錨點位置與大小 (僅在單選一張圖片時顯示)
function updateImageHandles() {
    const img = (selectedObjects.length === 1 && isPlaneType(selectedObjects[0])) ? selectedObjects[0] : null;
    imageHandles.visible = !!img;
    if (!img) return;
    img.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    imageHandleMeshes.forEach(h => {
        p.set(h.userData.ax * 0.5, h.userData.ay * 0.5, 0);
        img.localToWorld(p);
        h.position.copy(p);
        h.quaternion.copy(rightCamera.quaternion); // 永遠面向相機
        h.scale.setScalar(rightCamera.position.distanceTo(p) * 0.014); // 螢幕上大小固定
    });
}

function setMouseFromEvent(event) {
    const rect = document.getElementById('right-canvas-container').getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function onHoverRightCanvas(event) {
    const el = rightRenderer.domElement;
    if (resizeState || transformControl.dragging || !imageHandles.visible) {
        if (!resizeState) el.style.cursor = defaultCursor();
        return;
    }
    setMouseFromEvent(event);
    raycaster.setFromCamera(mouse, rightCamera);
    const hh = raycaster.intersectObjects(imageHandleMeshes, false);
    if (hh.length === 0) { el.style.cursor = defaultCursor(); return; }
    const { ax, ay } = hh[0].object.userData;
    el.style.cursor = (ax !== 0 && ay !== 0) ? (ax * ay > 0 ? 'nesw-resize' : 'nwse-resize')
                      : (ax !== 0 ? 'ew-resize' : 'ns-resize');
}

function beginImageResize(handle, event) {
    const img = selectedObjects[0];
    img.updateWorldMatrix(true, false);
    const P0 = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
    img.matrixWorld.decompose(P0, Q, S);
    resizeState = {
        img, P0, Q,
        ax: handle.userData.ax, ay: handle.userData.ay,
        w0: S.x, h0: S.y,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(Q), P0)
    };
    rightControls.enabled = false; // 縮放時暫停視角旋轉
    window.addEventListener('pointermove', onImageResizeMove);
    window.addEventListener('pointerup', endImageResize);
    window.addEventListener('pointercancel', endImageResize);
}

function onImageResizeMove(event) {
    if (!resizeState) return;
    const { img, P0, Q, ax, ay, w0, h0, plane } = resizeState;
    setMouseFromEvent(event);
    raycaster.setFromCamera(mouse, rightCamera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return;

    // 滑鼠位置換算成圖片本身的座標 (圖片中心為原點，X 向右、Y 向上)
    const local = hit.sub(P0).applyQuaternion(Q.clone().invert());

    const MIN = 2;
    // 對側錨點固定不動；拖曳的邊/角決定新的寬高
    let newW = ax !== 0 ? Math.max(MIN, (local.x + ax * w0 / 2) * ax) : w0;
    let newH = ay !== 0 ? Math.max(MIN, (local.y + ay * h0 / 2) * ay) : h0;

    if (event.shiftKey) {
        // 按住 Shift：等比縮放 (角落取變化較大的那一邊；邊的中點則另一軸跟著變)
        let k;
        if (ax !== 0 && ay !== 0) k = Math.max(newW / w0, newH / h0);
        else k = ax !== 0 ? newW / w0 : newH / h0;
        newW = Math.max(MIN, w0 * k);
        newH = Math.max(MIN, h0 * k);
    }

    // 新中心：有被拖曳的軸，中心 = 對側固定點 + 新尺寸的一半；另一軸維持原中心
    const cx = ax !== 0 ? ax * (newW - w0) / 2 : 0;
    const cy = ay !== 0 ? ay * (newH - h0) / 2 : 0;

    img.scale.set(newW, newH, 1);
    img.position.copy(P0).add(new THREE.Vector3(cx, cy, 0).applyQuaternion(Q));
}

function endImageResize() {
    if (!resizeState) return;
    resizeState = null;
    commitHistory();
    rightControls.enabled = true;
    rightRenderer.domElement.style.cursor = defaultCursor();
    window.removeEventListener('pointermove', onImageResizeMove);
    window.removeEventListener('pointerup', endImageResize);
    window.removeEventListener('pointercancel', endImageResize);
}

// 複製選取的零件 (支援多選；原位複製，不位移)
function duplicateSelectedObject() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length === 0) {
        alertHint(); return;
    }
    const idMap = {}; // 舊群組 -> 新群組，讓複製出來的零件維持同樣的群組關係
    const clones = selectedObjects.map(src => {
        const m = cloneAssemblyMesh(src);
        // 每一層群組都對應到新的群組，保留複製前的巢狀結構
        m.userData.groupIds = (src.userData.groupIds || []).map(gid => {
            if (!idMap[gid]) idMap[gid] = newGroupId();
            return idMap[gid];
        });
        return m;
    });
    // 複製完成後，自動選取新零件，可直接拖曳移開
    setSelection(clones);
    commitHistory();
}

function disposeMesh(mesh) {
    if (mesh === editTarget) exitEditMode();
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry.dispose();
    disposeMaterials(mesh);
    mesh.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
    const index = assembledObjects.indexOf(mesh);
    if (index > -1) assembledObjects.splice(index, 1);
}

function deleteSelectedObject() {
    if (showcase) stopShowcase(false);
    if (selectedObjects.length === 0) return;
    const toDelete = [...selectedObjects];
    setSelection([]);
    toDelete.forEach(disposeMesh);
    commitHistory();
}

function clearAllParts() {
    setSelection([]);
    [...assembledObjects].forEach(disposeMesh);
}

function alertHint() {
    const hint = document.getElementById('selection-hint');
    hint.classList.remove('hidden');
    // 閃爍一下
    hint.style.opacity = '0.5';
    setTimeout(() => hint.style.opacity = '1', 100);
}

// ================= 本地專案存檔功能 =================
function collectParts() {
    return assembledObjects.map(obj => {
        const item = {
            type: obj.userData.type,
            params: obj.userData.params,
            color: obj.userData.color,
            faceColors: obj.userData.faceColors ? [...obj.userData.faceColors] : undefined,
            groups: obj.userData.groupIds ? [...obj.userData.groupIds] : [],
            position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
            rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z }
        };
        if (obj.userData.type === 'image') {
            item.params = { w: obj.scale.x, h: obj.scale.y };
            item.imageId = obj.userData.imageId;
        } else if (obj.userData.type === 'video') {
            item.params = { w: obj.scale.x, h: obj.scale.y };
            item.videoId = obj.userData.videoId;
            item.fileName = obj.userData.fileName;
        }
        return item;
    });
}

function collectWorkspace() {
    // 影片檔不存進專案：只保留位置、大小與檔名；videoId 只在這次開啟期間有意義
    const parts = collectParts().map(p => p.type === 'video' ? { ...p, videoId: undefined } : p);
    const usedImages = {};
    parts.forEach(p => { if (p.imageId) usedImages[p.imageId] = imageStore[p.imageId].dataURL; });
    return { version: 1, savedAt: new Date().toISOString(), parts, images: usedImages };
}

function flashButton(btn, text, ms = 2000) {
    const orig = btn.dataset.label || (btn.dataset.label = btn.innerText);
    btn.innerText = text;
    setTimeout(() => { btn.innerText = orig; }, ms);
}

async function saveWorkspace() {
    const btn = document.getElementById('btn-save');
    const json = JSON.stringify(collectWorkspace(), null, 2);
    const fileName = 'assembly-project.json';

    try {
        if (window.showSaveFilePicker) {
            // Chrome / Edge：第一次選擇位置，之後直接覆寫同一個檔案
            if (!currentFileHandle) {
                currentFileHandle = await window.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [{ description: '組裝專案', accept: { 'application/json': ['.json'] } }]
                });
            }
            const writable = await currentFileHandle.createWritable();
            await writable.write(json);
            await writable.close();
        } else {
            // Safari / Firefox：以下載方式存成檔案
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        flashButton(btn, '儲存成功！');
    } catch (error) {
        if (error && error.name === 'AbortError') return; // 使用者取消
        console.error('儲存失敗:', error);
        currentFileHandle = null;
        flashButton(btn, '儲存失敗');
    }
}

async function openWorkspaceFile(file, handle = null) {
    const btn = document.getElementById('btn-open');
    try {
        const parsed = JSON.parse(await file.text());
        const parts = Array.isArray(parsed) ? parsed : parsed.parts;
        if (!Array.isArray(parts)) throw new Error('檔案格式不正確');
        applyWorkspaceData(parts, Array.isArray(parsed) ? {} : (parsed.images || {}));
        resetHistory();
        currentFileHandle = handle; // 開啟後再按「儲存專案」會覆寫此檔 (僅 Chrome/Edge)
        flashButton(btn, '開啟成功！');
    } catch (error) {
        console.error('開啟失敗:', error);
        flashButton(btn, '開啟失敗');
    }
}

async function openWorkspace() {
    if (window.showOpenFilePicker) {
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{ description: '組裝專案', accept: { 'application/json': ['.json'] } }]
            });
            await openWorkspaceFile(await handle.getFile(), handle);
        } catch (error) {
            if (!error || error.name !== 'AbortError') console.error(error);
        }
    } else {
        document.getElementById('file-open').click();
    }
}

function applyWorkspaceData(data, images = {}) {
    if (showcase) stopShowcase(false);
    exitEditMode();
    clearAllParts();

    // 重建圖片庫
    Object.values(imageStore).forEach(e => e.texture && e.texture.dispose());
    Object.keys(imageStore).forEach(k => delete imageStore[k]);
    Object.entries(images).forEach(([id, dataURL]) => registerImage(id, dataURL));
    disposeAllVideos(); // 影片不存檔，開啟專案時清掉目前的影片，影片框顯示為「尚未載入」

    buildParts(data);
}

// 依照零件資料重建模型 (不動圖片庫；開啟專案與還原歷史共用)
function buildParts(data) {
            data.forEach(item => {
                if (item.type === 'video') {
                    const vm = createVideoMesh(item.videoId, item.params.w, item.params.h, item.fileName);
                    vm.position.set(item.position.x, item.position.y, item.position.z);
                    vm.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
                    vm.userData.groupIds = item.groups || (item.group ? [item.group] : []);
                    rightScene.add(vm);
                    assembledObjects.push(vm);
                    return;
                }
                if (item.type === 'image') {
                    if (!imageStore[item.imageId]) return;
                    const im = createImageMesh(item.imageId, item.params.w, item.params.h);
                    im.position.set(item.position.x, item.position.y, item.position.z);
                    im.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
                    im.userData.groupIds = item.groups || (item.group ? [item.group] : []);
                    rightScene.add(im);
                    assembledObjects.push(im);
                    return;
                }
                let geometry;
                if (item.type === 'box') {
                    geometry = new THREE.BoxGeometry(item.params.w, item.params.h, item.params.d);
                } else if (item.type === 'cylinder') {
                    geometry = new THREE.CylinderGeometry(item.params.r, item.params.r, item.params.h, 32);
                } else if (item.type === 'sphere') {
                    geometry = new THREE.SphereGeometry(item.params.r, 32, 16);
                }
                
                const faceColors = normalizeFaceColors(item.type, item);
                const material = makePartMaterials(item.type, faceColors);
                
                const mesh = new THREE.Mesh(geometry, material);
                
                const edges = new THREE.EdgesGeometry(geometry);
                const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true });
                mesh.add(new THREE.LineSegments(edges, lineMat));
                
                mesh.position.set(item.position.x, item.position.y, item.position.z);
                mesh.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
                
                mesh.userData = { 
                    isAssemblyPart: true,
                    type: item.type,
                    params: item.params,
                    color: faceColors[0],
                    faceColors,
                    groupIds: item.groups || (item.group ? [item.group] : [])
                };
                
                rightScene.add(mesh);
                assembledObjects.push(mesh);
            });
}

// 新增：統一更新吸附參數邏輯 (依照 Shift 狀態與網格狀態)
function updateTransformSnaps() {
    if (transformControl.getMode() === 'rotate') {
        if (isShiftDown) {
            // 按住 Shift 強制鎖定 30 度
            transformControl.setRotationSnap(THREE.MathUtils.degToRad(30));
        } else if (isGridSnapEnabled) {
            transformControl.setRotationSnap(THREE.MathUtils.degToRad(15));
        } else {
            transformControl.setRotationSnap(null);
        }
    } else if (transformControl.getMode() === 'translate') {
        if (isGridSnapEnabled) {
            transformControl.setTranslationSnap(50);
        } else {
            transformControl.setTranslationSnap(null);
        }
    }
}

// --- UI 事件綁定 ---
function setupUIEventListeners() {
    
    // 1. 左側表單切換邏輯
    const shapeSelect = document.getElementById('shape-type');
    shapeSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        document.getElementById('param-box').classList.add('hidden');
        document.getElementById('param-cylinder').classList.add('hidden');
        document.getElementById('param-sphere').classList.add('hidden');
        document.getElementById(`param-${val}`).classList.remove('hidden');
        updatePreviewShape();
    });

    // 綁定所有左側輸入框的 input 事件，即時更新預覽
    const inputs = document.querySelectorAll('aside input');
    inputs.forEach(input => {
        if (input.id === 'part-color') return; // 顏色另外處理 (依選取的面)
        input.addEventListener('input', updatePreviewShape);
    });
    document.getElementById('part-color').addEventListener('input', onFaceColorInput);

    // 2. 加入組裝區按鈕與存檔按鈕
    document.getElementById('add-to-assembly-btn').addEventListener('click', () => {
        if (editTarget) applyEditToTarget(); else addToAssembly();
    });
    document.getElementById('cancel-edit-btn').addEventListener('click', exitEditMode);
    document.getElementById('tool-edit-left').addEventListener('click', enterEditMode);
    document.getElementById('tool-undo').addEventListener('click', undoHistory);
    document.getElementById('tool-visit').addEventListener('click', enterVisitMode);
    document.getElementById('btn-exit-visit').addEventListener('click', exitVisitMode);
    document.getElementById('tool-box-select').addEventListener('click', () => setBoxSelectMode(!boxSelectMode));
    document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
    document.getElementById('tool-showcase').addEventListener('click', toggleShowcase);
    document.getElementById('tool-redo').addEventListener('click', redoHistory);
    resetHistory();
    document.getElementById('btn-save').addEventListener('click', saveWorkspace);
    document.getElementById('btn-open').addEventListener('click', openWorkspace);
    document.getElementById('file-open').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (f) openWorkspaceFile(f, null);
        e.target.value = '';
    });

    // 3. 右側工具列按鈕
    const btnTrans = document.getElementById('mode-translate');
    const btnRot = document.getElementById('mode-rotate');
    
    btnTrans.addEventListener('click', () => {
        transformControl.setMode('translate');
        btnTrans.classList.add('active');
        btnRot.classList.remove('active');
        updateTransformSnaps(); // 確保模式切換時套用正確的 Snap
    });
    btnRot.addEventListener('click', () => {
        transformControl.setMode('rotate');
        btnRot.classList.add('active');
        btnTrans.classList.remove('active');
        updateTransformSnaps(); // 確保模式切換時套用正確的 Snap
    });

    const btnSnap = document.getElementById('tool-snap-grid');
    btnSnap.addEventListener('click', () => {
        isGridSnapEnabled = !isGridSnapEnabled;
        if (isGridSnapEnabled) {
            btnSnap.classList.add('active');
            btnSnap.innerText = '網格吸附: 開';
        } else {
            btnSnap.classList.remove('active');
            btnSnap.innerText = '網格吸附: 關';
        }
        updateTransformSnaps(); // 更新 Snap 狀態
    });

    document.getElementById('tool-align-floor').addEventListener('click', snapToFloor);
    document.getElementById('tool-align-center').addEventListener('click', centerObject);
    document.getElementById('tool-duplicate').addEventListener('click', duplicateSelectedObject); // 綁定複製按鈕
    document.getElementById('tool-delete').addEventListener('click', deleteSelectedObject);
    const imageInput = document.getElementById('image-file-input');
    document.getElementById('tool-upload-image').addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => {
        if (e.target.files.length) addImagesFromFiles(e.target.files);
        e.target.value = '';
    });
    const videoInput = document.getElementById('video-file-input');
    document.getElementById('tool-upload-video').addEventListener('click', () => videoInput.click());
    videoInput.addEventListener('change', (e) => {
        if (e.target.files.length) addVideosFromFiles(e.target.files);
        e.target.value = '';
    });
    const relinkInput = document.getElementById('video-relink-input');
    document.getElementById('tool-relink-video').addEventListener('click', () => {
        if (!(selectedObjects.length === 1 && selectedObjects[0].userData.type === 'video')) {
            flashInfo('請先選取一個影片框'); return;
        }
        relinkInput.click();
    });
    relinkInput.addEventListener('change', (e) => {
        relinkVideoFile(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('tool-video-play').addEventListener('click', toggleVideoPlay);
    document.getElementById('tool-video-mute').addEventListener('click', toggleVideoSound);
    document.getElementById('tool-group').addEventListener('click', createGroup);
    document.getElementById('tool-ungroup').addEventListener('click', ungroupSelected);

    // 4. 側邊欄收合邏輯
    const sidebar = document.getElementById('left-sidebar');
    const toggleBtn = document.getElementById('toggle-sidebar');
    const toggleIcon = document.getElementById('toggle-icon');
    let isSidebarOpen = true;

    toggleBtn.addEventListener('click', () => {
        isSidebarOpen = !isSidebarOpen;
        if (isSidebarOpen) {
            sidebar.classList.remove('ml-[-380px]');
            toggleIcon.innerText = '◀';
        } else {
            sidebar.classList.add('ml-[-380px]');
            toggleIcon.innerText = '▶';
        }
    });

    // 鍵盤快捷鍵
    window.addEventListener('keydown', (e) => {
        // 防呆機制：如果在 input 輸入框內打字（例如輸入尺寸或色碼），不要觸發快捷鍵
        if (e.target.tagName.toLowerCase() === 'input') return;

        // F：進入 / 退出全螢幕 (Esc 由瀏覽器負責退出全螢幕)
        if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            toggleFullscreen();
            return;
        }

        // 參觀模式：只能移動視角，其他快捷鍵全部停用
        if (visitMode) return;

        if (showcase) {
            if (e.key === 'Escape') stopShowcase(false);
            return;
        }
        if (e.key === 'Escape' && boxSelect) { cancelBoxSelect(); return; }

        // 上一步 / 下一步：Ctrl(Cmd)+Z、Ctrl(Cmd)+Shift+Z、Ctrl+Y
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'z') { e.preventDefault(); if (e.shiftKey) redoHistory(); else undoHistory(); return; }
            if (k === 'y') { e.preventDefault(); redoHistory(); return; }
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelectedObject();
        } else if (e.key.toLowerCase() === 'h') {
            btnTrans.click();
        } else if (e.key.toLowerCase() === 'r') {
            btnRot.click();
        } else if (e.key.toLowerCase() === 'c') { // 綁定 C 鍵為複製快捷鍵
            duplicateSelectedObject();
        } else if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey) {
            setBoxSelectMode(!boxSelectMode);
        } else if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey) {
            enterEditMode();
        } else if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey) {
            createGroup();
        } else if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey) {
            ungroupSelected();
        } else if (e.key === 'Shift') {
            isShiftDown = true;
            updateTransformSnaps();
        }
    });

    // 新增：釋放 Shift 鍵的監聽
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') {
            isShiftDown = false;
            updateTransformSnaps();
        }
    });
}

// --- 渲染迴圈與自適應 ---
function onWindowResize() {
    const leftContainer = document.getElementById('left-canvas-container');
    const rightContainer = document.getElementById('right-canvas-container');

    // 加入 clientWidth/clientHeight > 0 的判斷，防止 Three.js 產生 Matrix 運算崩潰
    if (leftCamera && leftRenderer && leftContainer.clientWidth > 0 && leftContainer.clientHeight > 0) {
        leftCamera.aspect = leftContainer.clientWidth / leftContainer.clientHeight;
        leftCamera.updateProjectionMatrix();
        leftRenderer.setSize(leftContainer.clientWidth, leftContainer.clientHeight);
    }

    if (rightCamera && rightRenderer && rightContainer.clientWidth > 0 && rightContainer.clientHeight > 0) {
        rightCamera.aspect = rightContainer.clientWidth / rightContainer.clientHeight;
        rightCamera.updateProjectionMatrix();
        rightRenderer.setSize(rightContainer.clientWidth, rightContainer.clientHeight);
    }
}

function rendererLoop() {
    requestAnimationFrame(rendererLoop);
    
    // 展示模式：自動移動視角
    updateShowcase();
    syncVideoPlayback();

    // 更新控制器
    if (leftControls) leftControls.update();
    if (rightControls) rightControls.update();

    // 渲染雙場景
    if (leftRenderer && leftScene && leftCamera) {
        leftRenderer.render(leftScene, leftCamera);
    }
    if (imageHandles && rightCamera) updateImageHandles();
    if (selectionHelper) {
        if (selectedObjects.length > 1) {
            selectionHelper.box.copy(getSelectionBox());
            selectionHelper.visible = true;
        } else {
            selectionHelper.visible = false;
        }
    }
    if (rightRenderer && rightScene && rightCamera) {
        rightRenderer.render(rightScene, rightCamera);
    }
}

// 啟動程式
window.onload = initSystem;
