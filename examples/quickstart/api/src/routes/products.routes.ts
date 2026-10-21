import { Router, type Request, type Response } from 'express';

// A router factory: each call builds the same read-only routes for one resource.
export function crudRouter(resource: string) {
  const router = Router();
  router.get('/', (req: Request, res: Response) => res.json({ resource, items: [] }));
  router.get('/:id', (req: Request, res: Response) => res.json({ resource, id: req.params.id }));
  return router;
}
