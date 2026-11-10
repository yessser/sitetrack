import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { CreateProjectDto, PageQueryDto, UpdateProjectDto } from './dto/project.dto';
import { MembersService } from './members.service';
import { ProjectAccessService } from './project-access.service';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly members: MembersService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() page: PageQueryDto) {
    return this.projects.list(user, page);
  }

  @Get(':code')
  async get(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.projects.get(await this.access.resolve(user, code));
  }

  @Patch(':code')
  async update(@CurrentUser() user: AuthUser, @Param('code') code: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(await this.access.resolve(user, code, { admin: true }), dto);
  }

  @Delete(':code')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    await this.projects.remove(await this.access.resolve(user, code, { admin: true }));
  }

  @Get(':code/members')
  async listMembers(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.members.list(await this.access.resolve(user, code));
  }

  @Post(':code/members/:userId/admin')
  @HttpCode(204)
  async makeAdmin(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.members.makeAdmin(await this.access.resolve(user, code, { admin: true }), userId);
  }

  @Delete(':code/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.members.remove(await this.access.resolve(user, code, { admin: true }), userId);
  }
}
