import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { projectMembers, projects, users } from '../db/schema';
import type { ProjectAccess } from './project-access.service';

@Injectable()
export class MembersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(access: ProjectAccess) {
    return this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        isAdmin: projectMembers.isAdmin,
        joinedAt: projectMembers.joinedAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, access.projectId))
      .orderBy(desc(projectMembers.isAdmin), asc(users.name));
  }

  async makeAdmin(access: ProjectAccess, userId: string) {
    const updated = await this.db
      .update(projectMembers)
      .set({ isAdmin: true })
      .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)))
      .returning({ userId: projectMembers.userId });
    if (updated.length === 0) throw new NotFoundException('Member not found');
  }

  async remove(access: ProjectAccess, userId: string) {
    await this.db.transaction(async (tx) => {
      // Lock the project row so concurrent removals are serialized and the
      // "at least one project admin" rule cannot be raced.
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, access.projectId)).for('update');

      const [target] = await tx
        .select({ isAdmin: projectMembers.isAdmin })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)));
      if (!target) throw new NotFoundException('Member not found');

      if (target.isAdmin) {
        const [{ admins }] = await tx
          .select({ admins: sql<number>`count(*)::int` })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.isAdmin, true)));
        if (admins <= 1) throw new ConflictException('A project must keep at least one project admin');
      }

      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, userId)));
    });
  }
}
