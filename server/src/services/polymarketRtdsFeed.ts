/**
 * Thin facade: Polymarket RTDS prices via the shared {@link getRtdsManager} socket (`src/realtime.ts`).
 */
import { getRtdsManager } from "../realtime.js";

export class PolymarketRtdsFeed {
  private readonly rtds = getRtdsManager();

  getUsdForAsset(asset: string): number | null {
    return this.rtds.getUsdForAsset(asset);
  }

  getAgeMsForAsset(asset: string): number | null {
    return this.rtds.getAgeMsForAsset(asset);
  }

  isSocketOpen(): boolean {
    return this.rtds.isSocketOpen();
  }

  start(): void {
    this.rtds.start();
  }
}
