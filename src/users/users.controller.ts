import { Controller, Get } from '@nestjs/common';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { UsersService } from './users.service';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.profile(user.userId);
  }
}
