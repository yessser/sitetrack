import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { invitations, projectMembers, projects, users } from '../db/schema';
import type { PageQueryDto } from '../projects/dto/project.dto';
import type { MyInvitationPageDto } from './dto/invitation.dto';

/**
 * The invitee's side. Invitations double as notifications: the Notifications
 * screen is this list, and its unread count is the badge on every page.
 * Someone else's invitation answers 404, same as one that does not exist.
 */
@Injectable()
export class MyInvitationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Newest first, offset-paged like every other list. Reading a page marks it
   * read; the response still carries the read time from before this request
   * so the screen can highlight what is new.
   */
  async list(user: AuthUser, page: PageQueryDto): Promise<MyInvitationPageDto> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          projectCode: projects.code,
          projectName: projects.name,
          invitedById: users.id,
          invitedByName: users.name,
          status: invitations.status,
          createdAt: invitations.createdAt,
          answeredAt: invitations.answeredAt,
          readAt: invitations.inviteeReadAt,
          total: sql<number>`count(*) over ()::int`,
        })
        .from(invitations)
        .innerJoin(projects, eq(projects.id, invitations.projectId))
        .innerJoin(users, eq(users.id, invitations.invitedBy))
        .where(and(eq(invitations.inviteeId, user.userId), isNull(projects.deletedAt)))
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(page.limit)
        .offset(page.offset);

      const unread = rows.filter((r) => r.readAt === null).map((r) => r.id);
      if (unread.length > 0) {
        await tx
          .update(invitations)
          .set({ inviteeReadAt: sql`now()` })
          .where(and(inArray(invitations.id, unread), isNull(invitations.inviteeReadAt)));
      }

      return {
        items: rows.map(({ total: _, ...r }) => r),
        total: rows[0]?.total ?? 0,
        limit: page.limit,
        offset: page.offset,
      };
    });
  }

  async unreadCount(user: AuthUser): Promise<number> {
    // Served by invitations_invitee_unread_idx. Withdrawn ones (including
    // those of deleted projects) are no longer pending, so they drop out.
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.inviteeId, user.userId),
          eq(invitations.status, 'pending'),
          isNull(invitations.inviteeReadAt),
        ),
      );
    return count;
  }

  /** Joins the project. Returns its code so the caller can load the summary. */
  async accept(user: AuthUser, id: number): Promise<string> {
    return this.db.transaction(async (tx) => {
      const invitation = await this.answer(tx, user, id, 'accepted');
      // Membership and the status change commit together or not at all.
      await tx
        .insert(projectMembers)
        .values({ projectId: invitation.projectId, userId: user.userId })
        .onConflictDoNothing();
      return invitation.code;
    });
  }

  async reject(user: AuthUser, id: number) {
    await this.db.transaction((tx) => this.answer(tx, user, id, 'rejected'));
  }

  private async answer(tx: Tx, user: AuthUser, id: number, status: 'accepted' | 'rejected') {
    const [invitation] = await tx
      .select({ projectId: invitations.projectId, code: projects.code })
      .from(invitations)
      .innerJoin(projects, eq(projects.id, invitations.projectId))
      .where(and(eq(invitations.id, id), eq(invitations.inviteeId, user.userId), isNull(projects.deletedAt)));
    if (!invitation) throw new NotFoundException('Invitation not found');

    // Conditional on pending so this and a racing withdraw can't both win.
    const updated = await tx
      .update(invitations)
      .set({ status, answeredAt: sql`now()`, inviteeReadAt: sql`coalesce(${invitations.inviteeReadAt}, now())` })
      .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
      .returning({ id: invitations.id });
    if (updated.length === 0) throw new ConflictException('Invitation has already been answered or withdrawn');
    return invitation;
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

