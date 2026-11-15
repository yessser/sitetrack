import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { projectMembers, projects, users } from '../db/schema';
import type { ProjectAccess } from './project-access.service';

type Membership = { userId: string; adminSince: Date | null };

@Injectable()
export class MembersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(access: ProjectAccess) {
    return this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        isAdmin: sql<boolean>`${projectMembers.adminSince} is not null`,
        adminSince: projectMembers.adminSince,
        joinedAt: projectMembers.joinedAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, access.projectId))
      .orderBy(sql`${projectMembers.adminSince} asc nulls last`, asc(users.name));
  }

  async makeAdmin(access: ProjectAccess, userId: string) {
    // coalesce: promoting an existing admin must not reset their seniority.
    const updated = await this.db
      .update(projectMembers)
      .set({ adminSince: sql`coalesce(${projectMembers.adminSince}, now())` })
      .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)))
      .returning({ userId: projectMembers.userId });
    if (updated.length === 0) throw new NotFoundException('Member not found');
  }

  async demote(user: AuthUser, access: ProjectAccess, userId: string) {
    await this.change(user, access, userId, async (tx, target) => {
      if (!target.adminSince) return;
      await tx
        .update(projectMembers)
        .set({ adminSince: null })
        .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)));
    });
  }

  async remove(user: AuthUser, access: ProjectAccess, userId: string) {
    await this.change(user, access, userId, async (tx) => {
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)));
    });
  }

  /**
   * Shared gate for removing and demoting. Runs with the project row locked
   * so concurrent changes are serialized: the seniority check reads the
   * caller's current rank and the "at least one project admin" rule cannot
   * be raced.
   */
  private async change(
    user: AuthUser,
    access: ProjectAccess,
    targetId: string,
    apply: (tx: Parameters<Parameters<Db['transaction']>[0]>[0], target: Membership) => Promise<void>,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, access.projectId)).for('update');

      const rows = await tx
        .select({ userId: projectMembers.userId, adminSince: projectMembers.adminSince })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, access.projectId), inArray(projectMembers.userId, [user.userId, targetId])));
      const target = rows.find((r) => r.userId === targetId);
      if (!target) throw new NotFoundException('Member not found');
      this.assertMayManage(user, rows.find((r) => r.userId === user.userId), target);

      if (target.adminSince) {
        const [{ admins }] = await tx
          .select({ admins: sql<number>`count(*)::int` })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, access.projectId), isNotNull(projectMembers.adminSince)));
        if (admins <= 1) throw new ConflictException('A project must keep at least one project admin');
      }

      await apply(tx, target);
    });
  }

  // Anyone may act on themselves (leave, step down). SuperAdmins outrank
  // everyone. Admins may act on regular members and on admins appointed
  // strictly after them.
  private assertMayManage(user: AuthUser, actor: Membership | undefined, target: Membership) {
    if (user.userId === target.userId || user.role === 'super_admin') return;
    if (!actor?.adminSince) throw new ForbiddenException('Only project admins can do this');
    if (target.adminSince && target.adminSince <= actor.adminSince) {
      throw new ForbiddenException('Only a more senior project admin can do this');
    }
  }
}
