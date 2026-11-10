import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { appRole, type AppRole } from '../../db/schema';

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @IsIn(appRole.enumValues)
  role!: AppRole;
}
