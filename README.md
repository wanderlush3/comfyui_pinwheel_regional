copy comfyui_pinwheel_regional/ into your ComfyUI custom_nodes/ directory
Restart ComfyUI — the node appears under Add Node → Pinwheel → Pinwheel Regional Prompts
Connect an IMAGE source to the image input and a CLIP model to clip
Add layers using the "+" button, position shapes on the canvas
Type prompts into layer_1_prompt through layer_6_prompt matching your layers
Connect the CONDITIONING output to a KSampler and the MASK output to a preview for debugging

<img width="490" height="987" alt="Screenshot 2026-02-25 205826" src="https://github.com/user-attachments/assets/e998cb71-3da0-426d-940b-ea87d0551005" />


<img width="1152" height="896" alt="ComfyUI_00002_" src="https://github.com/user-attachments/assets/dc994ad3-3538-414b-a427-c80cc71de4f2" />
