import { z } from 'zod';
import type { Account } from './account.ts';

export const INTEGRATION_TOKEN_BODY_LIMIT = 2048;
export const INTEGRATION_TOKEN_ACTIVE_LIMIT = 20;
export const integrationScopeSchema = z.enum(['analyses:read', 'analyses:write']);
export type IntegrationScope = z.infer<typeof integrationScopeSchema>;
export const integrationTokenCreateSchema = z.object({
  label: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u),
  access: z.enum(['read', 'write']).default('read'),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
}).strict();
export type IntegrationTokenCreate = z.infer<typeof integrationTokenCreateSchema>;
export interface IntegrationTokenSummary {
  id: string;
  label: string;
  scopes: IntegrationScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}
export interface IntegrationIdentity { account: Account; scopes: IntegrationScope[] }
/** The secret appears only in a successful creation response, never in summaries. */
export interface IntegrationTokenCreated { token: string; details: IntegrationTokenSummary }

export function integrationScopes(access: 'read' | 'write'): IntegrationScope[] {
  return access === 'write' ? ['analyses:read', 'analyses:write'] : ['analyses:read'];
}
