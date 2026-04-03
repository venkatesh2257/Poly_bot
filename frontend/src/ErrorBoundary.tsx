import React, { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { err: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("UI error boundary:", err, info.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui", color: "#e2e8f0", background: "#0f172a" }}>
          <h1 style={{ fontSize: 18 }}>Something went wrong</h1>
          <pre style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>{this.state.err.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
