/** Emitted on `game.events` with the agent id when an agent sprite is clicked. */
export const AGENT_CLICK_EVENT = "agent-click";
/** Emitted on `game.events` by the HUD Roofs button. The Village flips every roof, as key R does. */
export const TOGGLE_ROOFS_EVENT = "toggle-roofs";
/** Emitted by the Village with a building id when the avatar reaches or faces a building, and with null when it walks away. */
export const SIGN_EVENT = "building-sign";
/** Emitted by a Room with its building id when the avatar enters. */
export const ROOM_ENTER_EVENT = "room-enter";
/** Emitted by a Room when the avatar leaves it. */
export const ROOM_LEAVE_EVENT = "room-leave";
