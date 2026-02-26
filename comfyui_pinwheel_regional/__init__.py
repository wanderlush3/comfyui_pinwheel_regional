from .pinwheel_regional_node import PinwheelRegionalPrompts

NODE_CLASS_MAPPINGS = {
    "PinwheelRegionalPrompts": PinwheelRegionalPrompts
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PinwheelRegionalPrompts": "Pinwheel Regional Prompts"
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
