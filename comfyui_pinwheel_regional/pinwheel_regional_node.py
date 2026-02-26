"""
PinwheelRegionalPrompts — ComfyUI Custom Node
Interactive multi-layer regional prompting with shape-based masks.
"""

import json
import math
import torch
import torch.nn.functional as F
import node_helpers


# ---------------------------------------------------------------------------
#  Shape Drawing Helpers (all operate on a HxW float tensor, values 0-1)
# ---------------------------------------------------------------------------

def _draw_rectangle(H, W, x, y, w, h):
    """Draw a filled rectangle. x,y,w,h are in pixel coordinates."""
    mask = torch.zeros((H, W), dtype=torch.float32)
    x1, y1 = int(max(0, round(x))), int(max(0, round(y)))
    x2, y2 = int(min(W, round(x + w))), int(min(H, round(y + h)))
    if x2 > x1 and y2 > y1:
        mask[y1:y2, x1:x2] = 1.0
    return mask


def _draw_circle(H, W, cx, cy, rx, ry):
    """Draw a filled ellipse. cx,cy = center, rx,ry = radii in pixels."""
    ys = torch.arange(H, dtype=torch.float32).unsqueeze(1)
    xs = torch.arange(W, dtype=torch.float32).unsqueeze(0)
    if rx <= 0 or ry <= 0:
        return torch.zeros((H, W), dtype=torch.float32)
    dist = ((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2
    mask = (dist <= 1.0).float()
    return mask


def _fill_polygon(H, W, vertices):
    """Fill a polygon defined by a list of (x, y) vertex tuples using scanline."""
    mask = torch.zeros((H, W), dtype=torch.float32)
    if len(vertices) < 3:
        return mask

    min_y = int(max(0, math.floor(min(v[1] for v in vertices))))
    max_y = int(min(H - 1, math.ceil(max(v[1] for v in vertices))))

    n = len(vertices)
    for y in range(min_y, max_y + 1):
        intersections = []
        for i in range(n):
            j = (i + 1) % n
            y1, y2 = vertices[i][1], vertices[j][1]
            x1, x2 = vertices[i][0], vertices[j][0]
            if y1 == y2:
                continue
            if y1 > y2:
                y1, y2 = y2, y1
                x1, x2 = x2, x1
            if y1 <= y < y2:
                t = (y - y1) / (y2 - y1)
                ix = x1 + t * (x2 - x1)
                intersections.append(ix)

        intersections.sort()
        for k in range(0, len(intersections) - 1, 2):
            xa = int(max(0, math.floor(intersections[k])))
            xb = int(min(W, math.ceil(intersections[k + 1])))
            if xb > xa:
                mask[y, xa:xb] = 1.0

    return mask


def _draw_triangle(H, W, x, y, w, h):
    """Draw a filled triangle (isoceles, point at top center)."""
    vertices = [
        (x + w / 2, y),          # top center
        (x, y + h),              # bottom left
        (x + w, y + h),          # bottom right
    ]
    return _fill_polygon(H, W, vertices)


def _draw_star(H, W, cx, cy, w, h):
    """Draw a 5-pointed star inscribed in the bounding box."""
    rx = w / 2
    ry = h / 2
    inner_rx = rx * 0.38
    inner_ry = ry * 0.38
    vertices = []
    for i in range(5):
        # Outer vertex
        angle_outer = math.radians(-90 + i * 72)
        vertices.append((cx + rx * math.cos(angle_outer),
                          cy + ry * math.sin(angle_outer)))
        # Inner vertex
        angle_inner = math.radians(-90 + i * 72 + 36)
        vertices.append((cx + inner_rx * math.cos(angle_inner),
                          cy + inner_ry * math.sin(angle_inner)))
    return _fill_polygon(H, W, vertices)


def _draw_diamond(H, W, cx, cy, w, h):
    """Draw a filled diamond (rhombus) inscribed in the bounding box."""
    half_w = w / 2
    half_h = h / 2
    vertices = [
        (cx, cy - half_h),     # top
        (cx + half_w, cy),     # right
        (cx, cy + half_h),     # bottom
        (cx - half_w, cy),     # left
    ]
    return _fill_polygon(H, W, vertices)


SHAPE_DRAWERS = {
    "rectangle": _draw_rectangle,
    "circle":    _draw_circle,
    "triangle":  _draw_triangle,
    "star":      _draw_star,
    "diamond":   _draw_diamond,
}


def _apply_feather(mask, feather_px):
    """Apply Gaussian blur feathering to a mask tensor."""
    if feather_px <= 0:
        return mask
    # Kernel size must be odd
    kernel_size = feather_px * 2 + 1
    sigma = feather_px / 2.0
    # Use Conv2d-based Gaussian blur
    m = mask.unsqueeze(0).unsqueeze(0)  # 1x1xHxW
    # Create 1D Gaussian kernel
    x = torch.arange(kernel_size, dtype=torch.float32) - feather_px
    gauss_1d = torch.exp(-x ** 2 / (2 * sigma ** 2))
    gauss_1d = gauss_1d / gauss_1d.sum()
    # Separable blur: horizontal then vertical
    kernel_h = gauss_1d.view(1, 1, 1, -1)
    kernel_v = gauss_1d.view(1, 1, -1, 1)
    pad_h = feather_px
    pad_v = feather_px
    m = F.pad(m, (pad_h, pad_h, 0, 0), mode='reflect')
    m = F.conv2d(m, kernel_h)
    m = F.pad(m, (0, 0, pad_v, pad_v), mode='reflect')
    m = F.conv2d(m, kernel_v)
    return m.squeeze(0).squeeze(0).clamp(0, 1)


# ---------------------------------------------------------------------------
#  Main Node Class
# ---------------------------------------------------------------------------

class PinwheelRegionalPrompts:
    """Multi-layer regional prompting with interactive shape-based masks."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "clip": ("CLIP",),
                "base_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Global prompt applied to the entire image."
                }),
                "feather_amount": ("INT", {
                    "default": 20, "min": 0, "max": 100, "step": 1,
                    "tooltip": "Soft-edge feathering radius in pixels for mask blending."
                }),
                "mask_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Strength of regional conditioning masks."
                }),
            },
            "optional": {
                "layer_1_prompt": ("STRING", {"multiline": True, "default": ""}),
                "layer_2_prompt": ("STRING", {"multiline": True, "default": ""}),
                "layer_3_prompt": ("STRING", {"multiline": True, "default": ""}),
                "layer_4_prompt": ("STRING", {"multiline": True, "default": ""}),
                "layer_5_prompt": ("STRING", {"multiline": True, "default": ""}),
                "layer_6_prompt": ("STRING", {"multiline": True, "default": ""}),
            },
            "hidden": {
                "layer_data": ("STRING", {"default": "[]"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "MASK",)
    RETURN_NAMES = ("conditioning", "mask",)
    FUNCTION = "process"
    CATEGORY = "Pinwheel"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-evaluate when layer_data changes
        return kwargs.get("layer_data", "")

    def process(self, image, clip, base_prompt, feather_amount, mask_strength,
                layer_1_prompt="", layer_2_prompt="", layer_3_prompt="",
                layer_4_prompt="", layer_5_prompt="", layer_6_prompt="",
                layer_data="[]"):

        # --- Image dimensions ---
        # image tensor shape: (B, H, W, C)
        B, H, W, C = image.shape
        print(f"[PinwheelRegional] Image dimensions: {W}x{H}, batch={B}")

        # --- Parse layer data from JS frontend ---
        try:
            layers = json.loads(layer_data) if layer_data else []
        except json.JSONDecodeError:
            print("[PinwheelRegional] WARNING: Failed to parse layer_data JSON")
            layers = []

        print(f"[PinwheelRegional] Received {len(layers)} layer(s) from frontend")

        # Map layer indices to prompts
        layer_prompts = {
            1: layer_1_prompt or "",
            2: layer_2_prompt or "",
            3: layer_3_prompt or "",
            4: layer_4_prompt or "",
            5: layer_5_prompt or "",
            6: layer_6_prompt or "",
        }

        # -----------------------------------------------------------------
        # Step 1: Encode the base prompt → base_conditioning
        # -----------------------------------------------------------------
        tokens = clip.tokenize(base_prompt)
        base_cond, base_pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        base_conditioning = [[base_cond, {"pooled_output": base_pooled}]]
        print(f"[PinwheelRegional] Base prompt encoded: '{base_prompt[:60]}...'")

        # -----------------------------------------------------------------
        # Step 2: Process each active layer
        # -----------------------------------------------------------------
        layer_conditionings = []
        combined_mask = torch.zeros((H, W), dtype=torch.float32)

        for layer_info in layers:
            layer_idx = layer_info.get("layer_index", 0)
            shape_type = layer_info.get("shape_type", "rectangle").lower()
            prompt = layer_prompts.get(layer_idx, "").strip()

            if not prompt:
                print(f"[PinwheelRegional] Layer {layer_idx}: SKIPPED (no prompt)")
                continue

            # Convert normalised 0-1 coords to pixel coords
            nx = layer_info.get("x", 0.0)
            ny = layer_info.get("y", 0.0)
            nw = layer_info.get("w", 0.1)
            nh = layer_info.get("h", 0.1)

            px = nx * W
            py = ny * H
            pw = nw * W
            ph = nh * H

            # --- Draw the mask ---
            draw_fn = SHAPE_DRAWERS.get(shape_type, _draw_rectangle)

            if shape_type == "rectangle":
                mask = draw_fn(H, W, px, py, pw, ph)
            elif shape_type == "circle":
                cx = px + pw / 2
                cy = py + ph / 2
                rx = pw / 2
                ry = ph / 2
                mask = draw_fn(H, W, cx, cy, rx, ry)
            elif shape_type == "triangle":
                mask = draw_fn(H, W, px, py, pw, ph)
            elif shape_type == "star":
                cx = px + pw / 2
                cy = py + ph / 2
                mask = draw_fn(H, W, cx, cy, pw, ph)
            elif shape_type == "diamond":
                cx = px + pw / 2
                cy = py + ph / 2
                mask = draw_fn(H, W, cx, cy, pw, ph)
            else:
                mask = _draw_rectangle(H, W, px, py, pw, ph)

            # Apply feathering
            mask = _apply_feather(mask, feather_amount)

            # Debug: mask dimensions and coverage
            mask_coverage = mask.sum().item() / (H * W) * 100
            print(f"[PinwheelRegional] Layer {layer_idx}: shape={shape_type}, "
                  f"mask={W}x{H}, coverage={mask_coverage:.1f}%, "
                  f"pos=({nx:.2f},{ny:.2f}), size=({nw:.2f},{nh:.2f}), "
                  f"prompt='{prompt[:40]}...'")

            # Combine into debug mask (union / max)
            combined_mask = torch.max(combined_mask, mask)

            # --- Encode layer prompt ---
            layer_tokens = clip.tokenize(prompt)
            layer_cond, layer_pooled = clip.encode_from_tokens(
                layer_tokens, return_pooled=True
            )
            layer_cond_list = [[layer_cond, {"pooled_output": layer_pooled}]]

            # --- CRITICAL: Apply mask using ComfyUI's native method ---
            # This mirrors exactly what ConditioningSetMask.append() does:
            #   set_cond_area="default" → set_area_to_bounds=False
            #   strength=mask_strength
            if len(mask.shape) < 3:
                mask = mask.unsqueeze(0)

            layer_cond_masked = node_helpers.conditioning_set_values(
                layer_cond_list,
                {
                    "mask": mask,
                    "set_area_to_bounds": False,
                    "mask_strength": mask_strength,
                }
            )

            layer_conditionings.extend(layer_cond_masked)

        # -----------------------------------------------------------------
        # Step 3: Combine using ConditioningCombine logic (list concat)
        # -----------------------------------------------------------------
        # This is exactly what ConditioningCombine does: conditioning_1 + conditioning_2
        final_conditioning = base_conditioning + layer_conditionings
        print(f"[PinwheelRegional] Final conditioning: {len(base_conditioning)} base + "
              f"{len(layer_conditionings)} regional = {len(final_conditioning)} total entries")

        # -----------------------------------------------------------------
        # Step 4: Return combined conditioning + debug mask
        # -----------------------------------------------------------------
        # combined_mask as (B, H, W) to match ComfyUI MASK format
        output_mask = combined_mask.unsqueeze(0).expand(B, -1, -1)

        return (final_conditioning, output_mask,)
