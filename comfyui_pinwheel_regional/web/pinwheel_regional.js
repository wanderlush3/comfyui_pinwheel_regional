/**
 * PinwheelRegionalPrompts — ComfyUI Frontend Extension
 * Interactive canvas-based shape editor for multi-layer regional prompting.
 *
 * Features:
 *  - Shape persistence via onSerialize/onConfigure (survives reload, tab switch, pan)
 *  - Lock Shapes toggle to prevent accidental dragging
 *  - Continuous redraw from state on every LiteGraph repaint
 */
import { app } from "../../scripts/app.js";

/* ───────────────────────── constants ───────────────────────── */
const MAX_LAYERS = 6;
const HANDLE_SIZE = 8;
const MIN_SHAPE_SIZE = 0.02; // Minimum normalised dimension
const LAYER_COLORS = [
    "rgba(255,  80,  80, 0.35)", // Red
    "rgba( 80, 180, 255, 0.35)", // Blue
    "rgba( 80, 255, 120, 0.35)", // Green
    "rgba(255, 200,  60, 0.35)", // Yellow
    "rgba(200,  80, 255, 0.35)", // Purple
    "rgba(255, 140,  60, 0.35)", // Orange
];
const LAYER_STROKES = [
    "rgba(255,  80,  80, 0.9)",
    "rgba( 80, 180, 255, 0.9)",
    "rgba( 80, 255, 120, 0.9)",
    "rgba(255, 200,  60, 0.9)",
    "rgba(200,  80, 255, 0.9)",
    "rgba(255, 140,  60, 0.9)",
];
const SHAPE_TYPES = ["rectangle", "circle", "triangle", "star", "diamond"];

/* ───────────────────────── shape drawing on canvas ───────────────────────── */

function drawShapeOnCanvas(ctx, shape, x, y, w, h, fill, stroke) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;

    switch (shape) {
        case "rectangle":
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.fill();
            ctx.stroke();
            break;

        case "circle":
            ctx.beginPath();
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            break;

        case "triangle":
            ctx.beginPath();
            ctx.moveTo(x + w / 2, y);
            ctx.lineTo(x, y + h);
            ctx.lineTo(x + w, y + h);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;

        case "star": {
            const cx = x + w / 2, cy = y + h / 2;
            const rx = w / 2, ry = h / 2;
            const irx = rx * 0.38, iry = ry * 0.38;
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const aouter = -Math.PI / 2 + i * (2 * Math.PI / 5);
                const ainner = aouter + Math.PI / 5;
                if (i === 0) ctx.moveTo(cx + rx * Math.cos(aouter), cy + ry * Math.sin(aouter));
                else ctx.lineTo(cx + rx * Math.cos(aouter), cy + ry * Math.sin(aouter));
                ctx.lineTo(cx + irx * Math.cos(ainner), cy + iry * Math.sin(ainner));
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;
        }

        case "diamond":
            ctx.beginPath();
            ctx.moveTo(x + w / 2, y);
            ctx.lineTo(x + w, y + h / 2);
            ctx.lineTo(x + w / 2, y + h);
            ctx.lineTo(x, y + h / 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;
    }
}

/* ───────────────────────── hit testing ───────────────────────── */

function hitTestHandle(mx, my, x, y, w, h) {
    // Returns handle id: "tl","tr","bl","br" or null
    const handles = [
        { id: "tl", hx: x, hy: y },
        { id: "tr", hx: x + w, hy: y },
        { id: "bl", hx: x, hy: y + h },
        { id: "br", hx: x + w, hy: y + h },
    ];
    for (const h of handles) {
        if (Math.abs(mx - h.hx) <= HANDLE_SIZE && Math.abs(my - h.hy) <= HANDLE_SIZE) {
            return h.id;
        }
    }
    return null;
}

function hitTestShape(mx, my, shape, x, y, w, h) {
    // Simple bounding box hit test for all shapes
    return mx >= x && mx <= x + w && my >= y && my <= y + h;
}

/* ───────────────────────── extension registration ───────────────────────── */

app.registerExtension({
    name: "Pinwheel.RegionalPrompts",

    async nodeCreated(node) {
        if (node.comfyClass !== "PinwheelRegionalPrompts") return;

        /* ── state ── */
        const state = {
            layers: [],             // {layer_index, shape_type, x, y, w, h} (normalised 0-1)
            selectedIndex: -1,
            dragging: false,
            resizing: false,
            resizeHandle: null,
            dragStartX: 0,
            dragStartY: 0,
            dragOrigX: 0,
            dragOrigY: 0,
            dragOrigW: 0,
            dragOrigH: 0,
            canvasWidth: 400,
            canvasHeight: 400,
            imageAspect: 1.0,
            imageLoaded: false,
            bgImage: null,
            locked: false,          // Lock shapes toggle
        };

        // ── Initialize node.properties for serialization ──
        if (!node.properties) node.properties = {};
        if (!node.properties.shapes) node.properties.shapes = [];
        if (node.properties.shapesLocked === undefined) node.properties.shapesLocked = false;

        /* ── helper: sync state → hidden widget + node.properties ── */
        function syncToWidget() {
            // Sync to hidden layer_data widget (for backend)
            const w = node.widgets?.find(w => w.name === "layer_data");
            if (w) {
                w.value = JSON.stringify(state.layers);
            }
            // Sync to node.properties for serialization persistence
            node.properties.shapes = JSON.parse(JSON.stringify(state.layers));
            node.properties.shapesLocked = state.locked;
            node.setDirtyCanvas(true, true);
        }

        /* ── helper: try to load the background image from the input ── */
        function tryLoadImage() {
            // ComfyUI stores image previews; try to get the connected image node's output
            const imageInput = node.inputs?.find(i => i.name === "image");
            if (imageInput && imageInput.link != null) {
                const linkInfo = app.graph.links[imageInput.link];
                if (linkInfo) {
                    const srcNode = app.graph.getNodeById(linkInfo.origin_id);
                    if (srcNode && srcNode.imgs && srcNode.imgs.length > 0) {
                        const img = srcNode.imgs[0];
                        if (img && img.naturalWidth > 0) {
                            state.bgImage = img;
                            state.imageAspect = img.naturalWidth / img.naturalHeight;
                            state.imageLoaded = true;
                            return;
                        }
                    }
                }
            }
            state.imageLoaded = false;
        }

        /* ── Serialization: save state when workflow is saved ── */
        const origOnSerialize = node.onSerialize;
        node.onSerialize = function (data) {
            if (origOnSerialize) origOnSerialize.call(this, data);
            if (!data.properties) data.properties = {};
            data.properties.shapes = JSON.parse(JSON.stringify(state.layers));
            data.properties.shapesLocked = state.locked;
        };

        /* ── Deserialization: restore state when workflow is loaded ── */
        const origOnConfigure = node.onConfigure;
        node.onConfigure = function (data) {
            if (origOnConfigure) origOnConfigure.call(this, data);
            if (data.properties) {
                if (Array.isArray(data.properties.shapes)) {
                    state.layers = JSON.parse(JSON.stringify(data.properties.shapes));
                }
                if (typeof data.properties.shapesLocked === "boolean") {
                    state.locked = data.properties.shapesLocked;
                }
            }
            // Defer UI rebuild until DOM is ready
            setTimeout(() => {
                rebuildLayerList();
                updateLockButton();
                syncToWidget();
            }, 50);
        };

        /* ── canvas widget ── */
        const canvasWidget = node.addDOMWidget("pinwheel_canvas", "customcanvas", document.createElement("div"), {
            serialize: false,
            hideOnZoom: false,
        });

        // Create the container structure
        const container = canvasWidget.element;
        container.style.cssText = `
            display: flex; flex-direction: column; gap: 6px;
            padding: 6px; background: #1a1a2e; border-radius: 8px;
            font-family: 'Segoe UI', sans-serif; font-size: 12px; color: #ccc;
        `;

        // Toolbar
        const toolbar = document.createElement("div");
        toolbar.style.cssText = `
            display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        `;

        const addBtn = document.createElement("button");
        addBtn.textContent = "+ Add Layer";
        addBtn.style.cssText = `
            padding: 4px 12px; background: #4a90d9; color: white; border: none;
            border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;
        `;
        addBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (state.layers.length >= MAX_LAYERS) return;
            const idx = state.layers.length + 1;
            state.layers.push({
                layer_index: idx,
                shape_type: "rectangle",
                x: 0.1 + (idx - 1) * 0.05,
                y: 0.1 + (idx - 1) * 0.05,
                w: 0.25,
                h: 0.25,
            });
            state.selectedIndex = state.layers.length - 1;
            rebuildLayerList();
            syncToWidget();
        });
        toolbar.appendChild(addBtn);

        const clearBtn = document.createElement("button");
        clearBtn.textContent = "Clear All";
        clearBtn.style.cssText = `
            padding: 4px 12px; background: #d94a4a; color: white; border: none;
            border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;
        `;
        clearBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        clearBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            state.layers = [];
            state.selectedIndex = -1;
            rebuildLayerList();
            syncToWidget();
        });
        toolbar.appendChild(clearBtn);

        // Lock/Unlock button
        const lockBtn = document.createElement("button");
        lockBtn.style.cssText = `
            padding: 4px 12px; border: none;
            border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;
        `;
        function updateLockButton() {
            if (state.locked) {
                lockBtn.textContent = "🔒 Locked";
                lockBtn.style.background = "#d94a4a";
                lockBtn.style.color = "white";
                canvas.style.cursor = "default";
            } else {
                lockBtn.textContent = "🔓 Unlock";
                lockBtn.style.background = "#3a7d3a";
                lockBtn.style.color = "white";
                canvas.style.cursor = "crosshair";
            }
        }
        lockBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        lockBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            state.locked = !state.locked;
            updateLockButton();
            syncToWidget();
        });
        toolbar.appendChild(lockBtn);

        container.appendChild(toolbar);

        // Canvas
        const canvas = document.createElement("canvas");
        canvas.style.cssText = `
            border: 1px solid #333; border-radius: 4px; cursor: crosshair;
            background: #0d0d1a; width: 100%; display: block;
        `;
        container.appendChild(canvas);
        const ctx = canvas.getContext("2d");

        // Layer list
        const layerListDiv = document.createElement("div");
        layerListDiv.style.cssText = `display: flex; flex-direction: column; gap: 3px;`;
        container.appendChild(layerListDiv);

        // Initialize lock button state
        updateLockButton();

        /* ── layer list UI ── */
        function rebuildLayerList() {
            layerListDiv.innerHTML = "";
            state.layers.forEach((layer, i) => {
                const row = document.createElement("div");
                row.style.cssText = `
                    display: flex; align-items: center; gap: 6px;
                    padding: 3px 6px; background: ${i === state.selectedIndex ? '#2d2d50' : '#16162b'};
                    border-radius: 4px; border-left: 3px solid ${LAYER_STROKES[i % LAYER_STROKES.length]};
                    cursor: pointer;
                `;
                row.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                row.addEventListener("click", (e) => {
                    e.stopPropagation();
                    state.selectedIndex = i;
                    rebuildLayerList();
                    node.setDirtyCanvas(true, true);
                });

                const label = document.createElement("span");
                label.textContent = `Layer ${layer.layer_index}`;
                label.style.cssText = `font-weight: 600; min-width: 50px; color: ${LAYER_STROKES[i % LAYER_STROKES.length]};`;
                row.appendChild(label);

                const select = document.createElement("select");
                select.style.cssText = `
                    background: #222; color: #ccc; border: 1px solid #444;
                    border-radius: 3px; padding: 2px 4px; font-size: 11px;
                `;
                SHAPE_TYPES.forEach(st => {
                    const opt = document.createElement("option");
                    opt.value = st;
                    opt.textContent = st.charAt(0).toUpperCase() + st.slice(1);
                    if (st === layer.shape_type) opt.selected = true;
                    select.appendChild(opt);
                });
                select.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                select.addEventListener("change", (e) => {
                    e.stopPropagation();
                    layer.shape_type = e.target.value;
                    syncToWidget();
                });
                row.appendChild(select);

                const coordsSpan = document.createElement("span");
                coordsSpan.style.cssText = `font-size: 10px; color: #888; flex: 1;`;
                coordsSpan.textContent = `(${(layer.x * 100).toFixed(0)}%, ${(layer.y * 100).toFixed(0)}%) ${(layer.w * 100).toFixed(0)}×${(layer.h * 100).toFixed(0)}%`;
                row.appendChild(coordsSpan);

                const removeBtn = document.createElement("button");
                removeBtn.textContent = "✕";
                removeBtn.style.cssText = `
                    background: #d94a4a; color: white; border: none; border-radius: 3px;
                    width: 20px; height: 20px; cursor: pointer; font-size: 12px;
                    display: flex; align-items: center; justify-content: center;
                `;
                removeBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                removeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    state.layers.splice(i, 1);
                    // Re-index layers
                    state.layers.forEach((l, idx) => { l.layer_index = idx + 1; });
                    if (state.selectedIndex >= state.layers.length) {
                        state.selectedIndex = state.layers.length - 1;
                    }
                    rebuildLayerList();
                    syncToWidget();
                });
                row.appendChild(removeBtn);

                layerListDiv.appendChild(row);
            });
        }

        /* ── canvas rendering (reads from state.layers every frame) ── */
        function renderCanvas() {
            tryLoadImage();

            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const displayW = Math.max(rect.width, 200);
            let displayH;

            if (state.imageLoaded && state.bgImage) {
                displayH = displayW / state.imageAspect;
            } else {
                displayH = displayW; // Square fallback
            }

            canvas.width = displayW * dpr;
            canvas.height = displayH * dpr;
            canvas.style.height = displayH + "px";
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            state.canvasWidth = displayW;
            state.canvasHeight = displayH;

            // Draw background
            ctx.fillStyle = "#0d0d1a";
            ctx.fillRect(0, 0, displayW, displayH);

            if (state.imageLoaded && state.bgImage) {
                try {
                    ctx.drawImage(state.bgImage, 0, 0, displayW, displayH);
                } catch (e) {
                    // Image might not be ready yet
                }
            } else {
                // Placeholder grid
                ctx.strokeStyle = "#222";
                ctx.lineWidth = 0.5;
                for (let gx = 0; gx < displayW; gx += 20) {
                    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, displayH); ctx.stroke();
                }
                for (let gy = 0; gy < displayH; gy += 20) {
                    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(displayW, gy); ctx.stroke();
                }
                ctx.fillStyle = "#555";
                ctx.font = "14px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("Connect an image to see preview", displayW / 2, displayH / 2);
            }

            // Draw all layers from state (ensures persistence across repaints)
            state.layers.forEach((layer, i) => {
                const sx = layer.x * displayW;
                const sy = layer.y * displayH;
                const sw = layer.w * displayW;
                const sh = layer.h * displayH;
                const fill = LAYER_COLORS[i % LAYER_COLORS.length];
                const stroke = LAYER_STROKES[i % LAYER_STROKES.length];

                drawShapeOnCanvas(ctx, layer.shape_type, sx, sy, sw, sh, fill, stroke);

                // Layer label
                ctx.fillStyle = stroke;
                ctx.font = "bold 11px sans-serif";
                ctx.textAlign = "left";
                ctx.fillText(`L${layer.layer_index}`, sx + 4, sy + 14);

                // Selection handles
                if (i === state.selectedIndex) {
                    ctx.strokeStyle = "#fff";
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(sx, sy, sw, sh);
                    ctx.setLineDash([]);

                    // Corner handles (only show when not locked)
                    if (!state.locked) {
                        const handles = [
                            [sx, sy], [sx + sw, sy],
                            [sx, sy + sh], [sx + sw, sy + sh],
                        ];
                        handles.forEach(([hx, hy]) => {
                            ctx.fillStyle = "#fff";
                            ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
                            ctx.strokeStyle = "#000";
                            ctx.lineWidth = 1;
                            ctx.strokeRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
                        });
                    }
                }
            });

            // Show lock indicator on canvas
            if (state.locked && state.layers.length > 0) {
                ctx.fillStyle = "rgba(255, 80, 80, 0.7)";
                ctx.font = "bold 11px sans-serif";
                ctx.textAlign = "right";
                ctx.fillText("🔒 LOCKED", displayW - 8, 16);
            }

            // Update the computed height for the widget
            canvasWidget.computedHeight = displayH + 10;
        }

        /* ── mouse interaction ── */
        function getCanvasPos(e) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            };
        }

        canvas.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();

            // If locked, only allow selection (clicking), not dragging/resizing
            const pos = getCanvasPos(e);

            if (state.locked) {
                // Still allow selecting layers when locked (for visual feedback)
                for (let i = state.layers.length - 1; i >= 0; i--) {
                    const layer = state.layers[i];
                    const sx = layer.x * state.canvasWidth;
                    const sy = layer.y * state.canvasHeight;
                    const sw = layer.w * state.canvasWidth;
                    const sh = layer.h * state.canvasHeight;
                    if (hitTestShape(pos.x, pos.y, layer.shape_type, sx, sy, sw, sh)) {
                        state.selectedIndex = i;
                        rebuildLayerList();
                        node.setDirtyCanvas(true, true);
                        return;
                    }
                }
                state.selectedIndex = -1;
                rebuildLayerList();
                node.setDirtyCanvas(true, true);
                return;
            }

            // Check handles on selected layer first
            if (state.selectedIndex >= 0) {
                const layer = state.layers[state.selectedIndex];
                const sx = layer.x * state.canvasWidth;
                const sy = layer.y * state.canvasHeight;
                const sw = layer.w * state.canvasWidth;
                const sh = layer.h * state.canvasHeight;
                const handle = hitTestHandle(pos.x, pos.y, sx, sy, sw, sh);
                if (handle) {
                    state.resizing = true;
                    state.resizeHandle = handle;
                    state.dragStartX = pos.x;
                    state.dragStartY = pos.y;
                    state.dragOrigX = layer.x;
                    state.dragOrigY = layer.y;
                    state.dragOrigW = layer.w;
                    state.dragOrigH = layer.h;
                    return;
                }
            }

            // Check shape hits (top-most / last drawn first)
            for (let i = state.layers.length - 1; i >= 0; i--) {
                const layer = state.layers[i];
                const sx = layer.x * state.canvasWidth;
                const sy = layer.y * state.canvasHeight;
                const sw = layer.w * state.canvasWidth;
                const sh = layer.h * state.canvasHeight;
                if (hitTestShape(pos.x, pos.y, layer.shape_type, sx, sy, sw, sh)) {
                    state.selectedIndex = i;
                    state.dragging = true;
                    state.dragStartX = pos.x;
                    state.dragStartY = pos.y;
                    state.dragOrigX = layer.x;
                    state.dragOrigY = layer.y;
                    rebuildLayerList();
                    node.setDirtyCanvas(true, true);
                    return;
                }
            }

            // Clicked empty space — deselect
            state.selectedIndex = -1;
            rebuildLayerList();
            node.setDirtyCanvas(true, true);
        });

        canvas.addEventListener("mousemove", (e) => {
            if (state.locked) return; // No drag/resize when locked
            if (!state.dragging && !state.resizing) return;
            e.stopPropagation();
            e.preventDefault();
            const pos = getCanvasPos(e);
            const dx = (pos.x - state.dragStartX) / state.canvasWidth;
            const dy = (pos.y - state.dragStartY) / state.canvasHeight;

            if (state.dragging && state.selectedIndex >= 0) {
                const layer = state.layers[state.selectedIndex];
                layer.x = Math.max(0, Math.min(1 - layer.w, state.dragOrigX + dx));
                layer.y = Math.max(0, Math.min(1 - layer.h, state.dragOrigY + dy));
                syncToWidget();
            }

            if (state.resizing && state.selectedIndex >= 0) {
                const layer = state.layers[state.selectedIndex];
                const h = state.resizeHandle;
                let nx = state.dragOrigX;
                let ny = state.dragOrigY;
                let nw = state.dragOrigW;
                let nh = state.dragOrigH;

                if (h.includes("r")) {
                    nw = Math.max(MIN_SHAPE_SIZE, state.dragOrigW + dx);
                }
                if (h.includes("l")) {
                    const newX = state.dragOrigX + dx;
                    nw = Math.max(MIN_SHAPE_SIZE, state.dragOrigW - dx);
                    if (nw > MIN_SHAPE_SIZE) nx = newX;
                }
                if (h.includes("b")) {
                    nh = Math.max(MIN_SHAPE_SIZE, state.dragOrigH + dy);
                }
                if (h.includes("t")) {
                    const newY = state.dragOrigY + dy;
                    nh = Math.max(MIN_SHAPE_SIZE, state.dragOrigH - dy);
                    if (nh > MIN_SHAPE_SIZE) ny = newY;
                }

                layer.x = Math.max(0, Math.min(1, nx));
                layer.y = Math.max(0, Math.min(1, ny));
                layer.w = Math.min(1 - layer.x, Math.max(MIN_SHAPE_SIZE, nw));
                layer.h = Math.min(1 - layer.y, Math.max(MIN_SHAPE_SIZE, nh));

                rebuildLayerList();
                syncToWidget();
            }
        });

        const mouseUpHandler = (e) => {
            if (state.dragging || state.resizing) {
                state.dragging = false;
                state.resizing = false;
                state.resizeHandle = null;
                rebuildLayerList();
                syncToWidget();
            }
        };
        canvas.addEventListener("mouseup", mouseUpHandler);
        document.addEventListener("mouseup", mouseUpHandler);

        /* ── widget draw callback (called each frame by LiteGraph) ── */
        const origDraw = canvasWidget.draw;
        canvasWidget.draw = function (ctx2, node2, widgetWidth, y, widgetHeight) {
            if (origDraw) origDraw.call(this, ctx2, node2, widgetWidth, y, widgetHeight);
            renderCanvas();
        };

        /* ── ensure the hidden layer_data widget exists ── */
        // ComfyUI creates widgets from INPUT_TYPES. The hidden widget should already exist.
        // If not, we add one manually as a fallback.
        setTimeout(() => {
            let ldWidget = node.widgets?.find(w => w.name === "layer_data");
            if (!ldWidget) {
                node.addWidget("text", "layer_data", "[]", () => { }, { serialize: true });
                ldWidget = node.widgets.find(w => w.name === "layer_data");
                if (ldWidget) ldWidget.type = "converted-widget"; // Hide from UI
            }

            // Restore from properties if available (handles initial load)
            if (node.properties && Array.isArray(node.properties.shapes) && node.properties.shapes.length > 0 && state.layers.length === 0) {
                state.layers = JSON.parse(JSON.stringify(node.properties.shapes));
                if (typeof node.properties.shapesLocked === "boolean") {
                    state.locked = node.properties.shapesLocked;
                }
                updateLockButton();
            }
            // Also try loading from widget value if properties were empty
            else if (state.layers.length === 0 && ldWidget && ldWidget.value) {
                try {
                    const parsed = JSON.parse(ldWidget.value);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        state.layers = parsed;
                    }
                } catch (e) { /* ignore */ }
            }

            rebuildLayerList();
            syncToWidget();
        }, 100);

        /* ── adjust node size ── */
        const origOnResize = node.onResize;
        node.onResize = function (size) {
            if (origOnResize) origOnResize.call(this, size);
            renderCanvas();
        };

        // Set a reasonable initial size
        node.size[0] = Math.max(node.size[0], 450);
        node.size[1] = Math.max(node.size[1], 700);
    },
});
