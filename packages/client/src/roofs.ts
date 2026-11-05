import type { BuildingId } from "@agentcity/world/shared";

/** Town roof visibility. `R` and the HUD button flip every roof at once. */
export class RoofState {
  allHidden = false;

  toggleAll(): void {
    this.allHidden = !this.allHidden;
  }

  // Every roof follows the global toggle. The id stays in the signature for callers that draw roofs per building.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hidden(_id: BuildingId): boolean {
    return this.allHidden;
  }
}
