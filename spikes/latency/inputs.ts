// Sample Decider inputs at three sizes. Real token counts differ per tokenizer and are measured in bench.ts.
export const INPUTS = {
  // ~16 tokens: a route, a button label, a network request line
  short: [
    'GET /api/v1/admin/users/:id -> getUser [requireAuth, requireAdmin]',
    'button: Delete account (settings / danger zone)',
    'POST https://www.google-analytics.com/g/collect?v=2&tid=G-7XK2',
    'link: Pricing -> /pricing',
    'DELETE /api/v1/orders/:id -> cancelOrder [requireAuth]',
    'form: Reset password (fields: email)',
    'GET /_next/static/chunks/app/layout-3f2a1c.js',
    'PATCH /api/v1/profile -> updateProfile [requireAuth, validate(ProfileSchema)]',
    'button: Send invoice to customer',
    'GET /health -> healthCheck',
  ],
  // ~64 tokens: a step claim with the code line it cites
  medium: [
    "Step: Submit the checkout form. Evidence app/(shop)/checkout/actions.ts:41: const res = await fetch(`${API_URL}/api/v1/payments`, { method: 'POST', body: JSON.stringify({ cartId, method: 'card' }) });",
    "Step: Create a project. Evidence src/routes/projects.routes.ts:22: router.post('/', requireAuth, validate(CreateProjectSchema), projectController.create); responds 201 with { success, data: project }.",
    'Step: Open the order details page. Evidence app/(shop)/orders/[id]/page.tsx:14: export default async function OrderPage({ params }: { params: { id: string } }) { const order = await getOrder(params.id);',
    "Step: Log out. Evidence components/nav/user-menu.tsx:37: <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/login' })}>Log out</DropdownMenuItem>",
    'Step: Search products by name. Evidence app/(shop)/search/page.tsx:9: const results = await searchProducts({ q: searchParams.q, page: Number(searchParams.page ?? 1) });',
    "Step: Remove a team member. Evidence src/routes/teams.routes.ts:48: router.delete('/:teamId/members/:userId', requireAuth, requireRole('owner'), teamController.removeMember);",
    'Network: POST https://api.segment.io/v1/batch 200 (text/plain, 2.1 kB), initiator analytics.js after page load, repeated every 30 seconds while the tab stays open.',
    "Step: Update notification settings. Evidence app/(account)/settings/notifications/actions.ts:12: 'use server'; export async function saveNotifications(formData: FormData) { const parsed = NotificationSchema.parse(Object.fromEntries(formData));",
  ],
  // ~256 tokens: a whole-flow summary, as used for category and duplicate checks
  long: [
    "Flow: Checkout with a saved card. Kind: ui. Steps: 1. Log in (subflow: Login). 2. Open the cart page /cart (app/(shop)/cart/page.tsx:10); check: the button 'Pay now' is visible (app/(shop)/cart/pay-button.tsx:15). 3. Choose the saved card in the payment method list (app/(shop)/checkout/payment-methods.tsx:28). 4. Press 'Pay now' (app/(shop)/cart/pay-button.tsx:9). 5. The pay action calls POST /api/v1/payments with the cart id and the card id (app/(shop)/checkout/actions.ts:41). 6. On success the page redirects to /orders/[id]/confirmation (app/(shop)/checkout/actions.ts:57); check: the heading 'Thank you for your order' is shown (app/(shop)/orders/[id]/confirmation/page.tsx:22). 7. On failure the form shows the error message from the response envelope { success: false, error } (app/(shop)/checkout/payment-form.tsx:64). Guards: the shop layout requires a session (middleware.ts:8). Destructive-looking: it charges the customer.",
    "Flow: Manage a team's members. Kind: api. Steps: 1. Log in (subflow: API login, POST /api/v1/auth/login, src/routes/auth.routes.ts:12); check: status 200 and data.token. 2. List the team's members with GET /api/v1/teams/:teamId/members (src/routes/teams.routes.ts:31), guarded by requireAuth and requireRole('member'); check: status 200 and data.members[]. 3. Invite a member with POST /api/v1/teams/:teamId/invites (src/routes/teams.routes.ts:39), body validated by InviteSchema (src/schemas/team.schema.ts:18: email, role); check: status 201 and data.inviteId. 4. Change a member's role with PATCH /api/v1/teams/:teamId/members/:userId (src/routes/teams.routes.ts:44), guarded by requireRole('owner'); check: status 200. 5. Remove a member with DELETE /api/v1/teams/:teamId/members/:userId (src/routes/teams.routes.ts:48); check: status 204. Responses use the envelope { success, data, error, timestamp } (src/utils/respond.ts:5). Destructive-looking: step 5 deletes data.",
    "Flow: Reset a forgotten password. Kind: ui. Steps: 1. Open /login (app/(auth)/login/page.tsx:12) and press the link 'Forgot password?' (app/(auth)/login/login-form.tsx:71). 2. The page /forgot-password renders a form with one field, email (app/(auth)/forgot-password/page.tsx:9). 3. Submit the form; the server action requestReset calls POST /api/v1/auth/password-reset (app/(auth)/forgot-password/actions.ts:15); check: the message 'Check your inbox' is shown (app/(auth)/forgot-password/sent.tsx:6). 4. Open the link from the email, /reset-password/[token] (app/(auth)/reset-password/[token]/page.tsx:11). 5. Enter the new password twice; the form validates both with ResetPasswordSchema (lib/validation/auth.ts:33). 6. Submit; the action calls PUT /api/v1/auth/password-reset/:token (app/(auth)/reset-password/[token]/actions.ts:20). 7. On success redirect to /login with the notice 'Password changed' (app/(auth)/reset-password/[token]/actions.ts:29). Guards: none, all pages are public. Destructive-looking: no.",
    "Flow: An administrator bans a user. Kind: ui. Steps: 1. Log in as an administrator (subflow: Login). 2. Open /admin/users (app/(admin)/admin/users/page.tsx:18); the admin layout checks session.user.role === 'admin' and redirects others to /403 (app/(admin)/layout.tsx:12). 3. Search for the user by email with the search box (app/(admin)/admin/users/user-search.tsx:22); the page calls GET /api/v1/admin/users?query= (app/(admin)/admin/users/page.tsx:25). 4. Open the user's row menu and choose 'Ban user' (app/(admin)/admin/users/user-row-menu.tsx:41). 5. Confirm in the dialog 'Ban this user? They will be signed out everywhere.' (components/confirm-dialog.tsx:30). 6. The action calls POST /api/v1/admin/users/:id/ban (app/(admin)/admin/users/actions.ts:52); check: the row shows the badge 'Banned' (app/(admin)/admin/users/user-row.tsx:19). Destructive-looking: yes, it locks an account.",
  ],
} as const;

export type InputSize = keyof typeof INPUTS;
