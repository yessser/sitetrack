import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { ProjectAccessService } from '../projects/project-access.service';
import { CreateInvitationDto, ProjectInvitationDto } from './dto/invitation.dto';
import { ProjectInvitationsService } from './project-invitations.service';

// Every member can see pending invitations (Members screen); only project
// admins invite and withdraw. Non-members get 404 from the access gate.
@ApiTags('invitations')
@ApiCookieAuth()
@Controller('projects/:code/invitations')
export class ProjectInvitationsController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly invitations: ProjectInvitationsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('code') code: string): Promise<ProjectInvitationDto[]> {
    return this.invitations.listPending(await this.access.resolve(user, code));
  }

  @Post()
  async invite(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: CreateInvitationDto,
  ): Promise<ProjectInvitationDto> {
    return this.invitations.invite(user, await this.access.resolve(user, code, { admin: true }), dto.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.invitations.withdraw(await this.access.resolve(user, code, { admin: true }), id);
  }
}
