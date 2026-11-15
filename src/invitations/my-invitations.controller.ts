import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { PageQueryDto, ProjectDto } from '../projects/dto/project.dto';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsService } from '../projects/projects.service';
import { MyInvitationPageDto, UnreadCountDto } from './dto/invitation.dto';
import { MyInvitationsService } from './my-invitations.service';

@ApiTags('invitations')
@ApiCookieAuth()
@Controller('invitations')
export class MyInvitationsController {
  constructor(
    private readonly invitations: MyInvitationsService,
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
  ) {}

  /** Invitations addressed to me (the Notifications screen). Marks the returned page read. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() page: PageQueryDto): Promise<MyInvitationPageDto> {
    return this.invitations.list(user, page);
  }

  /** Pending invitations I have not seen yet. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser): Promise<UnreadCountDto> {
    return { count: await this.invitations.unreadCount(user) };
  }

  /** Joins the project and returns it. */
  @Post(':id/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<ProjectDto> {
    const code = await this.invitations.accept(user, id);
    return this.projects.get(await this.access.resolve(user, code));
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.invitations.reject(user, id);
  }
}
