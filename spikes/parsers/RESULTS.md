# Parser spike results (Phase 2, open item 13.2)

ast-grep (@ast-grep/napi) parsed 460 files from the three sample repos.
- per-file parse time: p50 0.05 ms, p95 0.22 ms, max 1.34 ms, total 36 ms
- files with parse errors: 3
  - next-learn/basics/assets-metadata-css-starter/pages/index.js (2 error nodes, first at line 42)
  - next-learn/basics/learn-starter/pages/index.js (2 error nodes, first at line 41)
  - next-learn/basics/navigate-between-pages-starter/pages/index.js (2 error nodes, first at line 41)

Pattern checks (match lines):
- express-starter users.route.ts: $R.$M($PATH, ...) route calls: 5 match(es) at lines 17, 18, 19, 20, 21
- chessu auth.route.ts: router.route($PATH) chains: 5 match(es) at lines 7, 10, 12, 14, 15
- chessu routes/index.ts: router.use($PREFIX, $ROUTER) mounts: 3 match(es) at lines 9, 10, 11
- chessu lib/game.ts: fetch($URL, ...) calls: 4 match(es) at lines 6, 27, 40, 60
- next-learn actions.ts: "use server" directive: 1 match(es) at lines 1

ts-morph project loads:
- chessu/client/tsconfig.json: 35 files in 124 ms
- typescript-express-starter/lib/default/tsconfig.json: 21 files in 24 ms
- chessu/server/tsconfig.json: 14 files in 70 ms
- next-learn/dashboard/final-example/tsconfig.json: 41 files in 94 ms

ts-morph resolution checks:
- PASS: chessu client: `${API_URL}` in lib/game.ts resolves through the @/ alias to its declaration -> API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
- PASS: express-starter: `${this.path}` resolves to the class property initializer -> path = '/users'
- PASS: express-starter: `new UserRoute()` in server.ts resolves through the @routes/ alias to the class -> ClassDeclaration in typescript-express-starter/lib/default/src/routes/users.route.ts
- PASS: chessu server: `games` in router.use("/games", games) resolves to the router in games.route.ts -> VariableDeclaration "router = Router()" in chessu/server/src/routes/games.route.ts
- PASS: next-learn: useFormState(createInvoice) resolves to the "use server" action -> FunctionDeclaration in next-learn/dashboard/final-example/app/lib/actions.ts (file starts with "use server")
