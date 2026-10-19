import { Router } from 'express';
import { AdminController } from '@/controllers/admin.controller';

export class AdminRoutes {
  public path = '/admin';
  public router = Router();
  private controller = new AdminController();

  constructor() {
    this.router.get(`${this.path}/stats`, this.controller.stats);
    this.router.all(`${this.path}/maintenance`, this.controller.maintenance);
  }
}
