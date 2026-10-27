import type { FrameworkAdapter } from '../adapter.ts';
import { decoratorControllers } from '../decorators.ts';

// NestJS: controllers are decorated classes (@Controller('users') with @Get(':id')), read by the shared decorator
// reader; its module wiring (which controllers a module registers) is not followed, so every controller counts.
export const nestAdapter: FrameworkAdapter = {
  id: 'nestjs',
  role: 'api',
  detection: { dependency: '@nestjs/core', testedMajors: [7, 11] },
  rules: [],
  suspects: [],
  extract: (context) => decoratorControllers(context),
};
