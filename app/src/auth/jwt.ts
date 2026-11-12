import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AdminClaims {
  sub: string;
  email: string;
  nome: string;
  role: string;
}

export function signToken(claims: AdminClaims): string {
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): AdminClaims | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as AdminClaims;
  } catch {
    return null;
  }
}
