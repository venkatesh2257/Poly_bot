export class PredictionEngine {
    history = [];
    nextMarketPoint() {
        const last = this.history[this.history.length - 1];
        const lastUp = last?.up ?? 50;
        const movement = (Math.random() - 0.45) * 3;
        const up = Math.max(1, Math.min(99, lastUp + movement));
        const down = 100 - up;
        const point = {
            time: new Date().toLocaleTimeString(),
            up,
            down,
            movement
        };
        this.history = [...this.history.slice(-79), point];
        return this.history;
    }
    predict() {
        const recent = this.history.slice(-10);
        const trend = recent.reduce((acc, p) => acc + p.movement, 0);
        const direction = trend >= 0 ? "UP" : "DOWN";
        const confidenceBase = 92 + Math.random() * 8;
        const trendBoost = Math.min(2, Math.abs(trend) * 0.2);
        return {
            prediction: direction,
            confidence: Math.min(100, Number((confidenceBase + trendBoost).toFixed(2))),
            ts: Date.now()
        };
    }
}
