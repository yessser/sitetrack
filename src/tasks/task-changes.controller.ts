import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCookieAuth, ApiGoneResponse, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { ProjectAccessService } from '../projects/project-access.service';
import {
  TaskBatchDto,
  TaskBatchErrorDto,
  TaskBatchQueryDto,
  TaskBatchResultDto,
  TaskChangesPageDto,
  TaskChangesQueryDto,
  TaskSnapshotDto,
} from './dto/task-changes.dto';
import { TaskChangesService } from './task-changes.service';

/**
 * The whole-graph routes, for clients that keep the graph themselves: load the
 * snapshot once, send edits in batches, and poll the changelog for everyone else's.
 */
@ApiTags('tasks')
@ApiCookieAuth()
@Controller('projects/:code/tasks')
export class TaskChangesController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly changes: TaskChangesService,
  ) {}

  /** Every live task and link of the project, with the version they are at. */
  @Get('snapshot')
  async snapshot(@CurrentUser() user: AuthUser, @Param('code') code: string): Promise<TaskSnapshotDto> {
    return this.changes.snapshot((await this.access.resolve(user, code)).projectId);
  }

  /**
   * Applies a batch of changes, all or nothing. A rejected batch answers with
   * every problem in `errors`: 409 if any is about the current state (a
   * conflict, a cycle, a status rule), else 400.
   */
  @Post('changes')
  @HttpCode(200)
  @ApiConflictResponse({ type: TaskBatchErrorDto, isArray: true, description: 'In `errors` of the body.' })
  async apply(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Query() query: TaskBatchQueryDto,
    @Body() dto: TaskBatchDto,
  ): Promise<TaskBatchResultDto> {
    const access = await this.access.resolve(user, code);
    return this.changes.apply(user, access.projectId, dto, { dryRun: query.dryRun });
  }

  /** The changelog after `since`, oldest first. */
  @Get('changes')
  @ApiGoneResponse({ description: 'The log no longer reaches back to `since`: reload the snapshot.' })
  async since(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Query() query: TaskChangesQueryDto,
  ): Promise<TaskChangesPageDto> {
    return this.changes.since((await this.access.resolve(user, code)).projectId, query.since);
  }
}
