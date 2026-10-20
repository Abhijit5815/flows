import { z } from 'zod';

export const CategorySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'id must be lower-case words joined by hyphens'),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB'),
  editable: z.boolean(),
  enabled: z.boolean().default(true), // off: none of its flows are exported (PLAN.md Phase 5)
});

export type Category = z.infer<typeof CategorySchema>;

// Flows go here when the Decider answers `unknown`, so it must always exist and can't be edited.
export const FALLBACK_CATEGORY_ID = 'uncategorized';

// Okabe-Ito colours (colour-blind safe); grey for the fallback.
export const DEFAULT_CATEGORIES: readonly Category[] = [
  { id: 'auth', name: 'Sign-in & account', color: '#0072B2', editable: true, enabled: true },
  { id: 'browse', name: 'Browse & view', color: '#56B4E9', editable: true, enabled: true },
  { id: 'create-edit', name: 'Create & edit', color: '#009E73', editable: true, enabled: true },
  { id: 'search', name: 'Search & filter', color: '#E69F00', editable: true, enabled: true },
  { id: 'settings', name: 'Profile & settings', color: '#CC79A7', editable: true, enabled: true },
  { id: 'admin', name: 'Administration', color: '#D55E00', editable: true, enabled: true },
  { id: FALLBACK_CATEGORY_ID, name: 'Uncategorized', color: '#999999', editable: false, enabled: true },
];
