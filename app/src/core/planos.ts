/**
 * Gating por plano de assinatura.
 * Intenções BASE estão em todos os planos. Skills extras exigem um tier mínimo.
 * Tiers: essencial(1) < pro(2) < business(3).
 */
const TIER: Record<string, number> = { essencial: 1, pro: 2, business: 3, free: 1 };

// Skill -> tier mínimo necessário. (criar_lead é controlado separadamente por crm_email.)
const SKILL_TIER: Record<string, number> = {
  clima: 2,            // Pro
  cotacao: 2,          // Pro
  criar_habito: 3,     // Business — Lifestyle/Hábitos
  registrar_habito: 3, // Business
  listar_habitos: 3,   // Business
  // novas skills entram aqui conforme forem construídas
};

const NOME_PLANO: Record<number, string> = { 2: "Pro", 3: "Business" };

/** A intenção está liberada para o plano do usuário? Base sempre true. */
export function intentLiberada(plano: string | null | undefined, intent: string): boolean {
  const req = SKILL_TIER[intent];
  if (!req) return true; // intenção base
  const nivel = TIER[String(plano || "essencial").toLowerCase()] || 1;
  return nivel >= req;
}

/** Nome do plano necessário para uma skill gateada (para a mensagem de upsell). */
export function planoNecessario(intent: string): string {
  const req = SKILL_TIER[intent];
  return NOME_PLANO[req] || "Pro";
}
