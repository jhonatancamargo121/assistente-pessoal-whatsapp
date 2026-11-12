import { Request, Response, NextFunction } from "express";
import { verifyToken, AdminClaims } from "./jwt";

export interface AuthedRequest extends Request {
  admin?: AdminClaims;
}

export function adminRequired(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.token || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const claims = verifyToken(token);
  if (!claims) {
    res.status(401).json({ error: "nao_autenticado" });
    return;
  }
  req.admin = claims;
  next();
}
