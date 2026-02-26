import type { GatewayRequestContext } from "../services/keycloakGateway.js";

declare global {
  namespace Express {
    interface Request {
      gatewayContext?: GatewayRequestContext;
    }
  }
}

export {};
