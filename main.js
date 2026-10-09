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
    m.
