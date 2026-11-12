import { ApiProperty } from '@nestjs/swagger';
import { appRole, type AppRole } from '../../db/schema';

export class UserDto {
  /** @example "7d3c1f2e-5b8a-4c6d-9e0f-1a2b3c4d5e6f" */
  id!: string;
  /** @example "Amina Diallo" */
  name!: string;
  /** @example "amina@company.com" */
  email!: string;
  @ApiProperty({ enum: appRole.enumValues })
  role!: AppRole;
  createdAt!: Date;
}
