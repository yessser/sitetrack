import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { invitations, projectMembers, users } from '../db/schema';
import type { ProjectAccess } from '../projects/project-access.service';
import type { ProjectInvitationDto } from './dto/invitation.dto';

const invitee = alias(users, 'invitee');
const inviter = alias(users, 'inviter');

/** The project admin's side: invite, see pending invitations, withdraw. */
@Injectable()
export class ProjectInvitationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Pending invitations only: answered ones are history, not shown on the Members screen. */
  listPending(access: ProjectAccess): Promise<ProjectInvitationDto[]> {
    return this.select()
      .where(and(eq(invitations.projectId, access.projectId), eq(invitations.status, 'pending')))
      .orderBy(desc(invitations.createdAt), desc(invitations.id));
  }

  async invite(user: AuthUser, access: ProjectAccess, inviteeId: string): Promise<ProjectInvitationDto> {
    if (inviteeId === user.userId) throw new BadRequestException('You cannot invite yourself');

    const [target] = await this.db
      .select({ id: users.id, memberId: projectMembers.userId })
      .from(users)
      .leftJoin(
        projectMembers,
        and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, users.id)),
      )
      .where(eq(users.id, inviteeId));
    if (!target) throw new NotFoundException('User not found');
    if (target.memberId) throw new ConflictException('User is already a member of this project');

    let id: number;
    try {
      [{ id }] = await this.db
        .insert(invitations)
        .values({ projectId: access.projectId, inviteeId, invitedBy: user.userId })
        .returning({ id: invitations.id });
    } catch (err) {
      // invitations_pending_unique: two admins inviting the same person at once.
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new ConflictException('User already has a pending invitation to this project');
      }
      throw err;
    }
    const [created] = await this.select().where(eq(invitations.id, id));
    return created;
  }

  /** Any project admin may withdraw any pending invitation, whoever sent it. */
  async withdraw(access: ProjectAccess, id: number) {
    const [row] = await this.db
      .select({ status: invitations.status })
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.projectId, access.projectId)));
    if (!row) throw new NotFoundException('Invitation not found');

    // Conditional on pending so a racing accept/reject and this withdraw can't both win.
    const updated = await this.db
      .update(invitations)
      .set({ status: 'withdrawn', answeredAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
      .returning({ id: invitations.id });
    if (updated.length === 0) throw new ConflictException('Invitation has already been answered or withdrawn');
  }

  private select() {
    return this.db
      .select({
        id: invitations.id,
        inviteeId: invitee.id,
        inviteeName: invitee.name,
        inviteeEmail: invitee.email,
        invitedById: inviter.id,
        invitedByName: inviter.name,
        status: invitations.status,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(invitee, eq(invitee.id, invitations.inviteeId))
      .innerJoin(inviter, eq(inviter.id, invitations.invitedBy))
      .$dynamic();
  }
}
