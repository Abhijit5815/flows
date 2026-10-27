// Decorator controllers, as routing-controllers (on Express) and NestJS write them: routes from the class and method
// decorators, the body from a class-validator DTO, guards, and the statuses the frameworks' error classes send.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepo } from '../config/project.ts';
import { candidates } from '../engine/candidates.ts';
import { stepDetails } from '../engine/views.ts';
import { scanRepo } from '../ingest/pipeline.ts';
import { tempProject } from '../shared/testing/project.ts';
import { express5Path } from './express/express.ts';

const tmp = mkdtempSync(join(tmpdir(), 'flows-decorators-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function scan(name: string, files: Record<string, string>) {
  const dir = join(tmp, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const project = tempProject(join(tmp, `${name}-project`));
  const { graph, coverage } = await scanRepo(project, addRepo(project, dir, 'api').config.repos[0]);
  assert.ok(graph);
  const flows = candidates(graph).flows;
  const details = (route: string) => flows.find((flow) => flow.name === route)?.steps.flatMap((step) => [`${step.kind}: ${step.check?.kind === 'api' ? step.check.status : '-'}`, ...stepDetails(step)]);
  return { graph, coverage, routes: flows.map((flow) => flow.name).sort(), details };
}

const DTO = "import { IsEmail, IsOptional, MinLength } from 'class-validator';\nimport { ApiProperty } from '@nestjs/swagger';\nexport class CreateUserDto {\n  @ApiProperty({ example: 'a@b.c' })\n  @IsEmail()\n  email: string;\n\n  @MinLength(8)\n  password: string;\n\n  @IsOptional()\n  name?: string;\n}\n";

test('routing-controllers: routes under the route prefix, @Authorized, @OnUndefined and errors thrown one call away', async () => {
  const { routes, details, graph } = await scan('rc', {
    'package.json': JSON.stringify({ dependencies: { express: '^4.19.2', 'routing-controllers': '^0.10.0', 'class-validator': '^0.14.0' } }),
    'src/app.ts': "import { createExpressServer } from 'routing-controllers';\nimport { UserController } from './UserController';\ncreateExpressServer({ routePrefix: '/api', controllers: [UserController] }).listen(3000);\n",
    'src/dto.ts': DTO,
    'src/errors.ts': "import { HttpError } from 'routing-controllers';\nexport class UserNotFoundError extends HttpError {\n  constructor() {\n    super(404, 'User not found!');\n  }\n}\n",
    'src/UserService.ts': "import { BadRequestError } from 'routing-controllers';\nexport class UserService {\n  create(body: unknown) {\n    if (!body) throw new BadRequestError('Nothing to create');\n    return body;\n  }\n  find(id: string) {\n    return undefined;\n  }\n}\n",
    'src/UserController.ts':
      "import { Authorized, Body, Get, JsonController, OnUndefined, Param, Post } from 'routing-controllers';\nimport { CreateUserDto } from './dto';\nimport { UserNotFoundError } from './errors';\nimport { UserService } from './UserService';\n@JsonController('/users')\nexport class UserController {\n  constructor(private users: UserService) {}\n  @Get('/:id')\n  @OnUndefined(UserNotFoundError)\n  one(@Param('id') id: string) {\n    return this.users.find(id);\n  }\n  @Authorized('admin')\n  @Post()\n  create(@Body() body: CreateUserDto) {\n    return this.users.create(body);\n  }\n}\n",
  });
  assert.equal(graph.framework, 'express');
  assert.deepEqual(routes, ['GET /api/users/:id', 'POST /api/users']);
  assert.deepEqual(details('GET /api/users/:id'), ['api: 200', 'error 404 from UserController.one: User not found! (when it returns nothing)']);
  assert.deepEqual(details('POST /api/users'), [
    'api: 200',
    'body CreateUserDto { email: string IsEmail(), password: string MinLength(8), name?: string }',
    "error 401 from Authorized('admin') (when without a valid session)",
    'error 400 from UserController.create: Nothing to create (when if (!body))',
  ]);
});

test('NestJS: the global prefix, 201 for POST, @HttpCode, @UseGuards and HttpException', async () => {
  const { routes, details, graph, coverage } = await scan('nest', {
    'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^11.0.0', '@nestjs/common': '^11.0.0', 'class-validator': '^0.14.0' } }),
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nasync function start() {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix('api');\n  await app.listen(3000);\n}\nstart();\n",
    'src/app.module.ts': 'export class AppModule {}\n',
    'src/dto.ts': DTO,
    'src/users.controller.ts':
      "import { Body, Controller, Delete, HttpCode, HttpException, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';\nimport { AuthGuard } from '@nestjs/passport';\nimport { CreateUserDto } from './dto';\n@Controller({ path: 'users' })\nexport class UsersController {\n  @Post()\n  create(@Body() dto: CreateUserDto) {\n    if (!dto.email) throw new HttpException('Email taken', 409);\n    return dto;\n  }\n  @UseGuards(AuthGuard('jwt'))\n  @Delete(':id')\n  @HttpCode(204)\n  remove(@Param('id') id: string) {\n    if (!id) throw new NotFoundException('No such user');\n  }\n}\n",
  });
  assert.equal(graph.framework, 'nestjs');
  assert.deepEqual(coverage.unrecognised, []);
  assert.deepEqual(routes, ['DELETE /api/users/:id', 'POST /api/users']);
  assert.deepEqual(details('POST /api/users'), ['api: 201', 'body CreateUserDto { email: string IsEmail(), password: string MinLength(8), name?: string }', 'error 409 from UsersController.create: Email taken (when if (!dto.email))']);
  assert.deepEqual(details('DELETE /api/users/:id'), ['api: 204', "error 401 from AuthGuard('jwt') (when without a valid session)", 'error 404 from UsersController.remove: No such user (when if (!id))']);
});

test("Express 5's path syntax reads as the rest of Flows writes paths", () => {
  assert.deepEqual(['/users{/:id}', '/files/*splat', '/plain/:id'].map(express5Path), ['/users/:id?', '/files/*', '/plain/:id']);
});
