import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { ProjectAccessService } from '../projects/project-access.service';
import {
  AddDependencyDto,
  CreateTaskDto,
  TaskDetailDto,
  TaskListQueryDto,
  TaskPageDto,
  UpdateTaskDto,
} from './dto/task.dto';
import { TasksService } from './tasks.service';

// Every project member works with tasks; admin rights are not needed.
// Non-members get 404 from the access gate before any task is looked at.
@ApiTags('tasks')
@ApiCookieAuth()
@Controller('projects/:code/tasks')
export class TasksController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly tasks: TasksService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskDetailDto> {
    return this.tasks.create(user, await this.access.resolve(user, code), dto);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Query() query: TaskListQueryDto,
  ): Promise<TaskPageDto> {
    return this.tasks.list(await this.access.resolve(user, code), query);
  }

  @Get(':taskCode')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
  ): Promise<TaskDetailDto> {
    return this.tasks.get(await this.access.resolve(user, code), taskCode);
  }

  @Patch(':taskCode')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskDetailDto> {
    return this.tasks.update(user, await this.access.resolve(user, code), taskCode, dto);
  }

  @Delete(':taskCode')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
  ): Promise<void> {
    await this.tasks.remove(user, await this.access.resolve(user, code), taskCode);
  }

  /** Not started → In progress. */
  @Post(':taskCode/start')
  @HttpCode(200)
  async start(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
  ): Promise<TaskDetailDto> {
    return this.tasks.transition(user, await this.access.resolve(user, code), taskCode, 'start');
  }

  /** In progress → Done. */
  @Post(':taskCode/done')
  @HttpCode(200)
  async done(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
  ): Promise<TaskDetailDto> {
    return this.tasks.transition(user, await this.access.resolve(user, code), taskCode, 'done');
  }

  /** Done → In progress. */
  @Post(':taskCode/reopen')
  @HttpCode(200)
  async reopen(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
  ): Promise<TaskDetailDto> {
    return this.tasks.transition(user, await this.access.resolve(user, code), taskCode, 'reopen');
  }

  /** Makes this task wait on another task of the same project. */
  @Post(':taskCode/dependencies')
  async addDependency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
    @Body() dto: AddDependencyDto,
  ): Promise<TaskDetailDto> {
    return this.tasks.addDependency(user, await this.access.resolve(user, code), taskCode, dto);
  }

  /** This task stops waiting on `dependsOnCode`. */
  @Delete(':taskCode/dependencies/:dependsOnCode')
  @HttpCode(204)
  async removeDependency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('taskCode') taskCode: string,
    @Param('dependsOnCode') dependsOnCode: string,
  ): Promise<void> {
    await this.tasks.removeDependency(user, await this.access.resolve(user, code), taskCode, dependsOnCode);
  }
}
