export type Direction = "UP" | "DOWN";

export interface MarketPoint {
  time: string;
  up: number;
  down: number;
  movement: number;
}

export interface Prediction {
  prediction: Direction;
  confidence: number;
  ts: number;
}
