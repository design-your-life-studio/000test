import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// --- 全域變數定義 ---
let currentFileHandle = null;
let leftScene, leftCamera, leftRenderer, leftControls;
let previewMesh;

// ... (中間省略，把你原本幾百行的 Three.js 邏輯全部貼過來) ...

function rendererLoop() {
    requestAnimationFrame(rendererLoop);
    updateShowcase();
    syncVideoPlayback();
    // ... 略
}

// 啟動程式
window.onload = initSystem;