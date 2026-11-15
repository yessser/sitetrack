import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { MyInvitationsController } from './my-invitations.controller';
import { MyInvitationsService } from './my-invitations.service';
import { ProjectInvitationsController } from './project-invitations.controller';
import { ProjectInvitationsService } from './project-invitations.service';

@Module({
  imports: [ProjectsModule],
  controllers: [ProjectInvitationsController, MyInvitationsController],
  providers: [ProjectInvitationsService, MyInvitationsService],
})
export class InvitationsModule {}
